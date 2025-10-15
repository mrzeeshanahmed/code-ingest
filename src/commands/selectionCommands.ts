import * as vscode from "vscode";
import { COMMAND_MAP } from "./commandMap";
import type { CommandServices } from "./types";

export function registerSelectionCommands(
  context: vscode.ExtensionContext,
  services: CommandServices
): void {
  const updateSelection = vscode.commands.registerCommand(
    COMMAND_MAP.WEBVIEW_TO_HOST.UPDATE_SELECTION,
    (payload?: { filePath?: string; selected?: boolean }) => {
      if (!payload || typeof payload.filePath !== "string") {
        return;
      }
      services.workspaceManager.updateSelection(payload.filePath, Boolean(payload.selected));
      const selection = services.workspaceManager.getSelection();
      services.webviewPanelManager.setStateSnapshot({ selection }, { emit: false });
    }
  );

  const applySelection = async (action: "select" | "clear") => {
    if (action === "select") {
      const selection = services.workspaceManager.selectAll();
      services.webviewPanelManager.setStateSnapshot({ selection });
      services.diagnostics.add(`Selected ${selection.length} files.`);
    } else {
      services.workspaceManager.clearSelection();
      services.webviewPanelManager.setStateSnapshot({ selection: [] });
      services.diagnostics.add("Cleared file selection.");
    }
  };

  const registerUniqueCommands = <T extends (...args: never[]) => unknown>(
    ids: string[],
    handler: T
  ): vscode.Disposable[] => {
    const uniqueIds = Array.from(new Set(ids));
    return uniqueIds.map((commandId) => vscode.commands.registerCommand(commandId, handler));
  };

  const applySelectionCommands = [
    ...registerUniqueCommands([
      COMMAND_MAP.WEBVIEW_TO_HOST.SELECT_ALL,
      COMMAND_MAP.EXTENSION_ONLY.SELECT_ALL
    ], () => applySelection("select")),
    ...registerUniqueCommands([
      COMMAND_MAP.WEBVIEW_TO_HOST.DESELECT_ALL,
      COMMAND_MAP.EXTENSION_ONLY.DESELECT_ALL
    ], () => applySelection("clear"))
  ];

  const applyPreset = vscode.commands.registerCommand(
    COMMAND_MAP.WEBVIEW_TO_HOST.APPLY_PRESET,
    (payload?: { presetId?: string }) => {
      const presetId = typeof payload?.presetId === "string" && payload.presetId.length > 0 ? payload.presetId : "default";
      services.diagnostics.add(`Preset request received: ${presetId}. Presets are not yet implemented.`);
      void vscode.window.showInformationMessage(
        `Code Ingest: Preset "${presetId}" is not available yet.`,
        "Dismiss"
      );
    }
  );

  const adjustExpansion = (expand: boolean) => {
    if (expand) {
      services.workspaceManager.expandAll();
    } else {
      services.workspaceManager.collapseAll();
    }
    services.webviewPanelManager.setStateSnapshot({
      expandState: services.workspaceManager.getExpandStateObject(),
      tree: services.workspaceManager.getTree()
    });
  };

  const expandCommands = [
    ...registerUniqueCommands([
      COMMAND_MAP.WEBVIEW_TO_HOST.EXPAND_ALL,
      COMMAND_MAP.EXTENSION_ONLY.EXPAND_ALL
    ], () => adjustExpansion(true)),
    ...registerUniqueCommands([
      COMMAND_MAP.WEBVIEW_TO_HOST.COLLAPSE_ALL,
      COMMAND_MAP.EXTENSION_ONLY.COLLAPSE_ALL
    ], () => adjustExpansion(false))
  ];

  context.subscriptions.push(updateSelection, ...applySelectionCommands, ...expandCommands, applyPreset);
}
