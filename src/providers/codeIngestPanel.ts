import * as path from "node:path";
import * as vscode from "vscode";
import { COMMAND_MAP } from "../commands/commandMap";
import {
  WebviewMessageEnvelope,
  type CommandMessage,
  type EnvelopeMessage,
  type ResponseMessage
} from "./messageEnvelope";
import { loadCommandValidator, type CommandPayloadValidator } from "./commandValidator";
import { detectFallbackHtml, setWebviewHtml } from "./webviewHelpers";

interface LegacyMessage {
  readonly type: string;
  readonly command?: string;
  readonly payload?: unknown;
}

interface PendingHostMessage {
  readonly command: string;
  readonly payload: unknown;
  readonly options?: { expectsAck?: boolean };
}

export class CodeIngestPanel {
  private static instance: CodeIngestPanel | undefined;
  private static handlerErrorChannel: vscode.OutputChannel | undefined;

  public static registerHandlerErrorChannel(channel: vscode.OutputChannel | undefined): void {
    CodeIngestPanel.handlerErrorChannel = channel;
  }
  private readonly envelope: WebviewMessageEnvelope;
  private readonly sessionToken: string;
  private readonly pendingMessages: PendingHostMessage[] = [];
  private isWebviewReady = false;
  private flushRetryTimer: NodeJS.Timeout | undefined;
  private hasRenderedFallback = false;

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
    const html = setWebviewHtml(panel.webview, extensionUri, htmlRelativePath, { sessionToken });
    CodeIngestPanel.instance.handleInitialRender(html);
  }

  static restoreState(state: unknown): boolean {
    if (!CodeIngestPanel.instance) {
      return false;
    }

    CodeIngestPanel.instance.updateState(state);
    return true;
  }

  static notifyWebviewReady(): void {
    CodeIngestPanel.instance?.markWebviewReady();
  }

  static postCommand(command: string, payload: unknown, options?: { expectsAck?: boolean }): boolean {
    const instance = CodeIngestPanel.instance;
    if (!instance) {
      return false;
    }

    return instance.queueOrPostCommand(command, payload, options);
  }

  updateState(state: unknown): void {
    this.queueOrPostCommand(COMMAND_MAP.HOST_TO_WEBVIEW.RESTORE_STATE, { state });
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
    this.pendingMessages.splice(0, this.pendingMessages.length);
    this.isWebviewReady = false;
    if (this.flushRetryTimer) {
      clearTimeout(this.flushRetryTimer);
      this.flushRetryTimer = undefined;
    }
    this.hasRenderedFallback = false;
  }

  private isEnvelopeMessage(message: EnvelopeMessage | LegacyMessage): message is EnvelopeMessage {
    return message.type === "command" || message.type === "response" || message.type === "event";
  }

  private async executeCommandFromWebview(message: CommandMessage): Promise<void> {
    const validator = await this.getCommandValidator();
    const validation = validator?.(message.command, message.payload) ?? { ok: true, value: message.payload };
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

  private async getCommandValidator(): Promise<CommandPayloadValidator | undefined> {
    try {
      return await loadCommandValidator();
    } catch (error) {
      console.error("CodeIngestPanel: failed to load command validator", error);
      return undefined;
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
      if (message.type === "handler:registrationFailed") {
        CodeIngestPanel.logHandlerRegistrationFailure(message.payload);
        return;
      }
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
    this.queueOrPostCommand(COMMAND_MAP.HOST_TO_WEBVIEW.SHOW_ERROR, {
      title: details.title,
      message: details.message
    });
  }

  private logInboundRejection(commandId: string, reason: string): void {
    console.warn("CodeIngestPanel: rejected webview command", { commandId, reason });
  }

  private queueOrPostCommand(command: string, payload: unknown, options?: { expectsAck?: boolean }): boolean {
    const normalizedOptions = typeof options?.expectsAck === "boolean" ? { expectsAck: options.expectsAck } : undefined;

    if (!this.isWebviewReady) {
      const pending: PendingHostMessage = normalizedOptions
        ? { command, payload, options: normalizedOptions }
        : { command, payload };
      this.pendingMessages.push(pending);
      this.schedulePendingFlush();
      return true;
    }

    const posted = this.postCommandInternal(command, payload, normalizedOptions);
    if (!posted) {
      const pending: PendingHostMessage = normalizedOptions
        ? { command, payload, options: normalizedOptions }
        : { command, payload };
      this.pendingMessages.push(pending);
      this.schedulePendingFlush();
    }
    return posted;
  }

  private postCommandInternal(command: string, payload: unknown, options?: { expectsAck?: boolean }): boolean {
    try {
      const message = this.envelope.createMessage("command", command, payload, options);
      void this.panel.webview.postMessage(message);
      return true;
    } catch (error) {
      console.error("CodeIngestPanel: failed to post command", command, error);
      return false;
    }
  }

  private markWebviewReady(): void {
    if (this.isWebviewReady) {
      return;
    }

    this.isWebviewReady = true;

    if (this.pendingMessages.length === 0) {
      return;
    }

    const queued = this.pendingMessages.splice(0, this.pendingMessages.length);
    for (const message of queued) {
      const success = this.postCommandInternal(message.command, message.payload, message.options);
      if (!success) {
        this.pendingMessages.push(message);
      }
    }

    if (this.pendingMessages.length > 0) {
      this.schedulePendingFlush();
    }
  }

  private schedulePendingFlush(delay = 500): void {
    if (this.flushRetryTimer || this.pendingMessages.length === 0) {
      return;
    }

    this.flushRetryTimer = setTimeout(() => {
      this.flushRetryTimer = undefined;

      if (!this.isWebviewReady) {
        this.schedulePendingFlush(Math.min(delay * 2, 4000));
        return;
      }

      if (this.pendingMessages.length === 0) {
        return;
      }

      const pending = this.pendingMessages.splice(0, this.pendingMessages.length);
      const failed: PendingHostMessage[] = [];
      for (const message of pending) {
        const success = this.postCommandInternal(message.command, message.payload, message.options);
        if (!success) {
          failed.push(message);
        }
      }

      if (failed.length > 0) {
        this.pendingMessages.unshift(...failed);
        this.schedulePendingFlush(Math.min(delay * 2, 4000));
      }
    }, delay);
  }

  private handleInitialRender(html: string): void {
    const detection = detectFallbackHtml(html);
    if (!detection.isFallback) {
      this.hasRenderedFallback = false;
      return;
    }

    if (this.hasRenderedFallback) {
      return;
    }

    this.hasRenderedFallback = true;
    const reason = detection.reason ?? "unknown";
    console.error("CodeIngestPanel: Webview rendered fallback UI", { reason });
    CodeIngestPanel.handlerErrorChannel?.appendLine(
      `[webview-fallback] Dashboard webview failed to load (${reason}). Run "npm run build:webview" and reopen Code Ingest.`
    );
  }

  private static logHandlerRegistrationFailure(payload: unknown): void {
    const type = typeof (payload as { type?: unknown })?.type === "string"
      ? (payload as { type: string }).type
      : "unknown";
    const reason = typeof (payload as { reason?: unknown })?.reason === "string"
      ? (payload as { reason: string }).reason
      : "Handler registration failed";

    const message = `[handler-error] Registration failed for "${type}": ${reason}`;
    console.error("CodeIngestPanel: handler registration failed", { type, reason });
    CodeIngestPanel.handlerErrorChannel?.appendLine(message);
    if (!CodeIngestPanel.handlerErrorChannel) {
      void vscode.window.showErrorMessage(`Code Ingest handler registration failed: ${type}. ${reason}`);
    }
  }
}