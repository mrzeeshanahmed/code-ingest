import * as vscode from "vscode";
import { COMMAND_MAP } from "./commandMap";
import type { CommandServices } from "./types";
import { getActiveProvider } from "./utils";

export function registerSelectionCommands(
  context: vscode.ExtensionContext,
  services: CommandServices
): void {
  const selectAll = vscode.commands.registerCommand(COMMAND_MAP.EXTENSION_ONLY.SELECT_ALL, () => {
    const provider = getActiveProvider(services.treeProviders);

    if (!provider) {
      void vscode.window.showWarningMessage(
        "Code Ingest: No active workspace tree available to select items."
      );
      return;
    }

    services.diagnostics.add("Select all command invoked.");
    provider.refresh();
  });

  const deselectAll = vscode.commands.registerCommand(COMMAND_MAP.EXTENSION_ONLY.DESELECT_ALL, () => {
    const provider = getActiveProvider(services.treeProviders);

    if (!provider) {
      void vscode.window.showWarningMessage(
        "Code Ingest: No active workspace tree available to deselect items."
      );
      return;
    }

    services.diagnostics.add("Deselect all command invoked.");
    provider.refresh();
  });

  context.subscriptions.push(selectAll, deselectAll);
}
