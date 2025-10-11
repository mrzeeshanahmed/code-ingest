import * as vscode from "vscode";
import { COMMAND_MAP } from "./commandMap";
import type { CommandServices } from "./types";

export function registerSelectionCommands(
  context: vscode.ExtensionContext,
  services: CommandServices
): void {
  const selectAll = vscode.commands.registerCommand(COMMAND_MAP.EXTENSION_ONLY.SELECT_ALL, () => {
    services.diagnostics.add("Select all command invoked.");
    void services.webviewPanelManager.createAndShowPanel();
    void vscode.window.showInformationMessage(
      "Code Ingest: Selection is managed from the dashboard view."
    );
  });

  const deselectAll = vscode.commands.registerCommand(COMMAND_MAP.EXTENSION_ONLY.DESELECT_ALL, () => {
    services.diagnostics.add("Deselect all command invoked.");
    void services.webviewPanelManager.createAndShowPanel();
    void vscode.window.showInformationMessage(
      "Code Ingest: Selection clearing is handled within the dashboard."
    );
  });

  context.subscriptions.push(selectAll, deselectAll);
}
