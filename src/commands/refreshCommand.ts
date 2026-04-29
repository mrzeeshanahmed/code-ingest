import * as vscode from "vscode";
import { COMMAND_MAP } from "./commandMap";
import type { CommandRegistrar, CommandServices } from "./types";

export function registerRefreshCommand(
  context: vscode.ExtensionContext,
  services: CommandServices,
  registerCommand: CommandRegistrar
): void {
  const handler = async () => {
    services.diagnostics.add("Refreshing workspace tree...");

    const state = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Code Ingest: Refreshing workspace tree",
        cancellable: false
      },
      async () => services.workspaceManager.refreshWorkspaceTree()
    );

    const snapshotUpdate: Record<string, unknown> = {
      tree: state.tree,
      selection: state.selection,
      expandState: state.expandState,
      warnings: state.warnings,
      status: state.status,
      scanId: state.scanId,
      totalFiles: state.totalFiles
    };

    if (state.workspaceFolder) {
      snapshotUpdate.workspaceFolder = state.workspaceFolder;
    }

    services.webviewPanelManager.setStateSnapshot(snapshotUpdate);

    services.diagnostics.add(`Workspace tree refreshed (${state.totalFiles} files).`);
  };

  const commandIds = new Set([
    COMMAND_MAP.WEBVIEW_TO_HOST.REFRESH_TREE,
    COMMAND_MAP.EXTENSION_ONLY.REFRESH_TREE
  ]);

  for (const commandId of commandIds) {
    registerCommand(commandId, handler);
  }
}