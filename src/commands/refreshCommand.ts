import * as vscode from "vscode";
import { COMMAND_MAP } from "./commandMap";
import type { CommandServices } from "./types";

export function registerRefreshCommand(
  context: vscode.ExtensionContext,
  services: CommandServices
): void {
  const disposable = vscode.commands.registerCommand(COMMAND_MAP.WEBVIEW_TO_HOST.REFRESH_TREE, () => {
    services.diagnostics.add("Refresh tree command invoked.");
    void services.webviewPanelManager.createAndShowPanel();

    void vscode.window.showInformationMessage(
      "Code Ingest: Refresh actions are coordinated through the dashboard."
    );
  });

  context.subscriptions.push(disposable);
}
