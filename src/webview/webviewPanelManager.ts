import * as vscode from "vscode";

export class WebviewPanelManager {
  constructor(private readonly extensionUri: vscode.Uri) {}

  createAndShowPanel(): void {
    const panel = vscode.window.createWebviewPanel(
      "codeIngestDashboard",
      "Code Ingest",
      vscode.ViewColumn.One,
      {}
    );

    panel.webview.html = "<h1>Code Ingest Dashboard</h1>";
  }
}
