import * as vscode from "vscode";
import { COMMAND_MAP } from "./commandMap";
import type { CommandServices } from "./types";
import { getActiveProvider } from "./utils";

export function registerRefreshCommand(
  context: vscode.ExtensionContext,
  services: CommandServices
): void {
  const disposable = vscode.commands.registerCommand(COMMAND_MAP.EXTENSION_ONLY.REFRESH_TREE, () => {
    const provider = getActiveProvider(services.treeProviders);

    if (!provider) {
      void vscode.window.showWarningMessage("Code Ingest: No active workspace tree to refresh.");
      return;
    }

    provider.refresh();
  });

  context.subscriptions.push(disposable);
}
