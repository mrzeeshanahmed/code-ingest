import * as path from "node:path";
import * as vscode from "vscode";
import { COMMAND_MAP } from "../commands/commandMap";
import {
  WebviewMessageEnvelope,
  type CommandMessage,
  type EnvelopeMessage,
  type ResponseMessage
} from "./messageEnvelope";
import { setWebviewHtml } from "./webviewHelpers";

type CommandPayloadValidator = (
  commandId: string,
  payload: unknown
) => { ok: true; value: unknown } | { ok: false; reason?: string; errors?: unknown } | undefined;

const commandValidatorPromise: Promise<CommandPayloadValidator> = (async () => {
  // @ts-expect-error command validation helper is provided as a compiled JS asset under resources/
  const module = await import("../../resources/webview/commandValidation.js");
  return (module as { validateCommandPayload: CommandPayloadValidator }).validateCommandPayload;
})();

interface LegacyMessage {
  readonly type: string;
  readonly command?: string;
  readonly payload?: unknown;
}

export class CodeIngestPanel {
  private static instance: CodeIngestPanel | undefined;
  private readonly envelope: WebviewMessageEnvelope;
  private readonly sessionToken: string;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    sessionToken: string
  ) {
    this.sessionToken = sessionToken;
    this.envelope = new WebviewMessageEnvelope({ sessionToken, role: "host" });
    this.panel.onDidDispose(() => this.dispose(), null, []);
    this.panel.webview.onDidReceiveMessage((message: EnvelopeMessage | LegacyMessage) => {
      void this.handleMessage(message);
    });
  }

  static async createOrShow(extensionUri: vscode.Uri): Promise<void> {
    const column = vscode.window.activeTextEditor?.viewColumn;

    if (CodeIngestPanel.instance) {
      CodeIngestPanel.instance.panel.reveal(column);
      return;
    }

    const sessionToken = WebviewMessageEnvelope.generateToken();
    const panel = vscode.window.createWebviewPanel(
      "codeIngestDashboard",
      "Code Ingest",
      column ?? vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, "out", "resources", "webview")]
      }
    );

    console.log('CodeIngestPanel: WebviewPanel created successfully', {
      viewType: panel.viewType,
      title: panel.title,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, "out", "resources", "webview").toString()]
    });

    CodeIngestPanel.instance = new CodeIngestPanel(panel, extensionUri, sessionToken);
    const htmlRelativePath = path.posix.join("out", "resources", "webview", "index.html");
    const htmlUri = vscode.Uri.joinPath(extensionUri, "out", "resources", "webview", "index.html");

    console.log("CodeIngestPanel: Loading HTML from", htmlUri.fsPath);
    setWebviewHtml(panel.webview, extensionUri, htmlRelativePath, { sessionToken });
  }

  static restoreState(state: unknown): boolean {
    if (!CodeIngestPanel.instance) {
      return false;
    }

    CodeIngestPanel.instance.updateState(state);
    return true;
  }

  static postCommand(command: string, payload: unknown, options?: { expectsAck?: boolean }): boolean {
    const instance = CodeIngestPanel.instance;
    if (!instance) {
      return false;
    }

    try {
      const messageOptions =
        typeof options?.expectsAck === "boolean" ? { expectsAck: options.expectsAck } : undefined;
      const message = instance.envelope.createMessage("command", command, payload, messageOptions);
      void instance.panel.webview.postMessage(message);
      return true;
    } catch (error) {
      console.error("CodeIngestPanel: failed to post command", command, error);
      return false;
    }
  }

  updateState(state: unknown): void {
    const message = this.envelope.createMessage(
      "command",
      COMMAND_MAP.HOST_TO_WEBVIEW.RESTORE_STATE,
      { state }
    );
    void this.panel.webview.postMessage(message);
  }

  private async handleMessage(message: EnvelopeMessage | LegacyMessage): Promise<void> {
    if (!message || typeof message !== "object") {
      return;
    }

    if (this.isEnvelopeMessage(message)) {
      const validation = this.envelope.validateMessage(message, { direction: "inbound" });
      if (!validation.ok) {
        console.warn("Rejected webview message", validation.reason);
        return;
      }

      const validated = validation.value;
      if (validated.type === "command") {
        await this.executeCommandFromWebview(validated);
      } else if (validated.type === "response") {
        this.handleResponse(validated);
      }
      return;
    }

    this.handleLegacyMessage(message);
  }

  private dispose(): void {
    if (CodeIngestPanel.instance === this) {
      CodeIngestPanel.instance = undefined;
    }
  }

  private isEnvelopeMessage(message: EnvelopeMessage | LegacyMessage): message is EnvelopeMessage {
    return message.type === "command" || message.type === "response" || message.type === "event";
  }

  private async executeCommandFromWebview(message: CommandMessage): Promise<void> {
    const validator = await commandValidatorPromise;
    const validation = validator(message.command, message.payload) ?? { ok: true, value: message.payload };
    if (!validation || validation.ok !== true) {
      const reason = validation?.reason ?? "validation_failed";
      this.logInboundRejection(message.command, reason);
      this.sendShowError({
        title: "Invalid request",
        message: `Command ${message.command} rejected: ${reason}`
      });
      if (message.expectsAck) {
        this.postResponse(message, { ok: false, reason });
      }
      return;
    }

    const payload = validation.value ?? message.payload;
    try {
      const result = await vscode.commands.executeCommand(message.command, payload);
      if (message.expectsAck) {
        this.postResponse(message, { ok: true, result });
      }
    } catch (error) {
      const formattedError = this.formatError(error);
      if (message.expectsAck) {
        this.postResponse(message, {
          ok: false,
          reason: formattedError
        });
      }
      console.error("Webview command failed", message.command, error);
      const handledByHost = this.wasErrorHandledByHost(error);
      if (handledByHost) {
        return;
      }
      const showError = this.extractShowErrorDetails(error) ?? {
        title: "Command failed",
        message: formattedError
      };
      this.sendShowError(showError);
    }
  }

  private handleResponse(message: ResponseMessage): void {
    console.debug?.("Received webview response", {
      command: message.command,
      ok: (message.payload as { ok?: boolean })?.ok ?? true
    });
  }

  private handleLegacyMessage(message: LegacyMessage): void {
    if (message.type === "command" && message.command) {
      void vscode.commands.executeCommand(message.command, message.payload);
      return;
    }

    if (typeof message.type === "string" && message.type.startsWith("handler:")) {
      console.info("Webview handler notification", message.type, message.payload);
    }
  }

  private postResponse(reference: CommandMessage, payload: unknown): void {
    const response = this.envelope.createResponse(reference, payload);
    void this.panel.webview.postMessage(response);
  }

  private formatError(error: unknown): string {
    if (error instanceof Error) {
      return error.message.slice(0, 512);
    }
    return String(error).slice(0, 512);
  }

  private extractShowErrorDetails(error: unknown): { title: string; message: string } | undefined {
    if (!error || typeof error !== "object") {
      return undefined;
    }
    const details = (error as { showError?: unknown }).showError;
    if (!details || typeof details !== "object") {
      return undefined;
    }
    const title = (details as { title?: unknown }).title;
    const message = (details as { message?: unknown }).message;
    if (typeof title === "string" && typeof message === "string") {
      return { title, message };
    }
    return undefined;
  }

  private wasErrorHandledByHost(error: unknown): boolean {
    if (!error || typeof error !== "object") {
      return false;
    }
    return Boolean((error as { handledByHost?: boolean }).handledByHost);
  }

  private sendShowError(details: { title: string; message: string }): void {
    const outbound = this.envelope.createMessage(
      "command",
      COMMAND_MAP.HOST_TO_WEBVIEW.SHOW_ERROR,
      {
        title: details.title,
        message: details.message
      }
    );
    void this.panel.webview.postMessage(outbound);
  }

  private logInboundRejection(commandId: string, reason: string): void {
    console.warn("CodeIngestPanel: rejected webview command", { commandId, reason });
  }
}
