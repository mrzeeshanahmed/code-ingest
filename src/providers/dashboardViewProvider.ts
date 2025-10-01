import * as vscode from "vscode";
import { ErrorReporter } from "../services/errorReporter";
import { setWebviewHtml } from "./webviewHelpers";

export class DashboardViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly extensionUri: vscode.Uri, private readonly errorReporter: ErrorReporter) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void | Thenable<void> {
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "resources", "webview")]
    };

    const htmlPath = vscode.Uri.joinPath(this.extensionUri, "resources", "webview", "index.html").fsPath;
    try {
      setWebviewHtml(webviewView.webview, htmlPath);
    } catch (error) {
      this.errorReporter.report(error, { source: "dashboard-view" });
      void vscode.window.showErrorMessage("Code Ingest: Failed to load dashboard view. See error channel for details.");
    }
  }

  dispose(): void {
    while (this.disposables.length > 0) {
      const disposable = this.disposables.pop();
      try {
        disposable?.dispose();
      } catch (error) {
        this.errorReporter.report(error, { source: "dashboard-view", command: "dispose" });
      }
    }
  }
}
