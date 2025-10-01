import * as vscode from "vscode";
import { setWebviewHtml } from "./webviewHelpers";

interface IncomingMessage {
  type: string;
  command?: string;
  payload?: unknown;
}

export class CodeIngestPanel {
  private static instance: CodeIngestPanel | undefined;

  private constructor(private readonly panel: vscode.WebviewPanel, private readonly extensionUri: vscode.Uri) {
    this.panel.onDidDispose(() => this.dispose(), null, []);
    this.panel.webview.onDidReceiveMessage((message: IncomingMessage) => this.handleMessage(message));
  }

  static async createOrShow(extensionUri: vscode.Uri): Promise<void> {
    const column = vscode.window.activeTextEditor?.viewColumn;

    if (CodeIngestPanel.instance) {
      CodeIngestPanel.instance.panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "codeIngestDashboard",
      "Code Ingest",
      column ?? vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, "resources", "webview")]
      }
    );

    CodeIngestPanel.instance = new CodeIngestPanel(panel, extensionUri);
    const htmlPath = vscode.Uri.joinPath(extensionUri, "resources", "webview", "index.html").fsPath;
    setWebviewHtml(panel.webview, htmlPath);
  }

  updateState(state: unknown): void {
    this.panel.webview.postMessage({ type: "state", state });
  }

  private handleMessage(message: IncomingMessage): void {
    if (!message || typeof message !== "object") {
      return;
    }

    if (message.type === "command" && message.command) {
      void vscode.commands.executeCommand(message.command, message.payload);
      return;
    }
  }

  private dispose(): void {
    if (CodeIngestPanel.instance === this) {
      CodeIngestPanel.instance = undefined;
    }
  }
}
