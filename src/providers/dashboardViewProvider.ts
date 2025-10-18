import * as vscode from "vscode";
import { COMMAND_MAP } from "../commands/commandMap";
import {
  WebviewMessageEnvelope,
  type CommandMessage,
  type EnvelopeMessage,
  type ResponseMessage
} from "./messageEnvelope";
import { detectFallbackHtml, setWebviewHtml } from "./webviewHelpers";
import { loadCommandValidator, type CommandPayloadValidator } from "./commandValidator";
import type { WebviewPanelManager } from "../webview/webviewPanelManager";
import type { ErrorReporter } from "../services/errorReporter";
import { wrapError } from "../utils/errorHandling";

interface LegacyMessage {
  readonly type: string;
  readonly command?: string;
  readonly payload?: unknown;
}

export class DashboardViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  public static readonly viewType = "codeIngest.dashboard";

  private static activeInstance: DashboardViewProvider | undefined;

  private webviewView: vscode.WebviewView | undefined;
  private envelope: WebviewMessageEnvelope | undefined;
  private sessionToken: string | undefined;
  private disposables: vscode.Disposable[] = [];
  private hasRenderedFallback = false;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly panelManager: WebviewPanelManager,
    private readonly ensureResourcesReady: () => Promise<void>,
    private readonly errorReporter: ErrorReporter
  ) {}

  public async resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): Promise<void> {
    void _context;
    void _token;
    try {
      await this.ensureResourcesReady();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      webviewView.webview.html = `<!DOCTYPE html><html lang="en"><body><h2>Code Ingest</h2><p>Failed to load dashboard assets: ${message}</p></body></html>`;
      return;
    }

    this.disposeCurrentSession();

    DashboardViewProvider.activeInstance = this;
    this.webviewView = webviewView;

    this.sessionToken = WebviewMessageEnvelope.generateToken();
    this.envelope = new WebviewMessageEnvelope({ sessionToken: this.sessionToken, role: "host" });

    const { webview } = webviewView;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "out", "resources", "webview")]
    };

    const initialState = {
      sessionToken: this.sessionToken,
      state: this.panelManager.getStateSnapshot() ?? {}
    };

    try {
      const html = setWebviewHtml(webview, this.extensionUri, "out/resources/webview/index.html", initialState);
      this.handleInitialRender(html);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      webview.html = `<!DOCTYPE html><html lang="en"><body><h2>Code Ingest</h2><p>Failed to load dashboard: ${message}</p></body></html>`;
    }

    const messageDisposable = webview.onDidReceiveMessage((message: EnvelopeMessage | LegacyMessage) => {
      void this.handleMessage(message);
    });

    const visibilityDisposable = webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        void vscode.commands.executeCommand("setContext", "codeIngest.dashboardVisible", true);
      } else {
        void vscode.commands.executeCommand("setContext", "codeIngest.dashboardVisible", false);
      }
    });

    this.disposables.push(messageDisposable, visibilityDisposable);

    webviewView.onDidDispose(() => {
      messageDisposable.dispose();
      visibilityDisposable.dispose();
      this.disposeCurrentSession();
      if (DashboardViewProvider.activeInstance === this) {
        DashboardViewProvider.activeInstance = undefined;
      }
    });
  }

  public dispose(): void {
    this.disposeCurrentSession();
    if (DashboardViewProvider.activeInstance === this) {
      DashboardViewProvider.activeInstance = undefined;
    }
  }

  public static restoreState(state: unknown): boolean {
    const instance = DashboardViewProvider.activeInstance;
    if (!instance?.webviewView?.webview || !instance.envelope) {
      return false;
    }

    const message = instance.envelope.createMessage(
      "command",
      COMMAND_MAP.HOST_TO_WEBVIEW.RESTORE_STATE,
      { state }
    );

    void instance.webviewView.webview.postMessage(message);
    return true;
  }

  public static postCommand(command: string, payload: unknown, options?: { expectsAck?: boolean }): boolean {
    const instance = DashboardViewProvider.activeInstance;
    if (!instance?.webviewView?.webview || !instance.envelope) {
      return false;
    }

    try {
      const messageOptions =
        typeof options?.expectsAck === "boolean" ? { expectsAck: options.expectsAck } : undefined;
      const message = instance.envelope.createMessage("command", command, payload, messageOptions);
      void instance.webviewView.webview.postMessage(message);
      return true;
    } catch (error) {
      console.error("DashboardViewProvider: failed to post command", command, error);
      return false;
    }
  }

  private disposeCurrentSession(): void {
    this.disposables.forEach((disposable) => {
      try {
        disposable.dispose();
      } catch (error) {
        console.warn("DashboardViewProvider: failed to dispose resource", error);
      }
    });
    this.disposables = [];
    this.webviewView = undefined;
    this.envelope = undefined;
    this.sessionToken = undefined;
    this.hasRenderedFallback = false;
  }

  private async handleMessage(message: EnvelopeMessage | LegacyMessage): Promise<void> {
    if (!message || typeof message !== "object") {
      return;
    }

    if (this.isEnvelopeMessage(message)) {
      if (!this.envelope || !this.webviewView) {
        return;
      }

      const validation = this.envelope.validateMessage(message, { direction: "inbound" });
      if (!validation.ok) {
        console.warn("DashboardViewProvider: rejected message", validation.reason);
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

  private isEnvelopeMessage(message: EnvelopeMessage | LegacyMessage): message is EnvelopeMessage {
    return message.type === "command" || message.type === "response" || message.type === "event";
  }

  private async executeCommandFromWebview(message: CommandMessage): Promise<void> {
    const validator = await this.getCommandValidator();
    const validation = validator?.(message.command, message.payload) ?? { ok: true, value: message.payload };
    if (!validation || validation.ok !== true) {
      const reason = validation?.reason ?? "validation_failed";
      console.warn("DashboardViewProvider: rejected command", { commandId: message.command, reason });
      this.panelManager.sendCommand(COMMAND_MAP.HOST_TO_WEBVIEW.SHOW_ERROR, {
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
      this.handleCommandFailure(message, error);
    }
  }

  private handleResponse(message: ResponseMessage): void {
    console.debug?.("DashboardViewProvider: received response", message.command);
  }

  private handleLegacyMessage(message: LegacyMessage): void {
    if (!message) {
      return;
    }

    if (message.type === "command" && message.command) {
      void vscode.commands.executeCommand(message.command, message.payload);
      return;
    }

    if (typeof message.type === "string" && message.type.startsWith("handler:")) {
      console.info("DashboardViewProvider: handler notification", message.type, message.payload);
    }
  }

  private postResponse(reference: CommandMessage, payload: unknown): void {
    if (!this.envelope || !this.webviewView) {
      return;
    }
    const response = this.envelope.createResponse(reference, payload);
    void this.webviewView.webview.postMessage(response);
  }

  private async getCommandValidator(): Promise<CommandPayloadValidator | undefined> {
    try {
      return await loadCommandValidator();
    } catch (error) {
      console.error("DashboardViewProvider: failed to load command validator", error);
      return undefined;
    }
  }

  private handleCommandFailure(message: CommandMessage, error: unknown): void {
    const wrapped = wrapError(error, { command: message.command, source: "dashboard" });
    this.errorReporter.report(wrapped, {
      command: message.command,
      source: "dashboard",
      metadata: { expectsAck: Boolean(message.expectsAck) }
    });

    const reason = wrapped.message ?? "command_failed";
    this.panelManager.sendCommand(COMMAND_MAP.HOST_TO_WEBVIEW.SHOW_ERROR, {
      title: "Command failed",
      message: reason
    });

    if (message.expectsAck) {
      this.postResponse(message, { ok: false, reason });
    }

    console.error("DashboardViewProvider: command execution failed", message.command, wrapped);
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
    const error = new Error(`Dashboard webview rendered fallback UI (${reason}).`);
    this.errorReporter.report(error, { source: "dashboard-webview", metadata: { reason } });
    console.error("DashboardViewProvider: Webview rendered fallback UI", { reason });
  }
}
