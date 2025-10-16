import * as vscode from "vscode";
import { COMMAND_MAP } from "./commandMap";
import type { CommandRegistrar, CommandServices } from "./types";

export function registerSelectionCommands(
  context: vscode.ExtensionContext,
  services: CommandServices,
  registerCommand: CommandRegistrar
): void {
  registerCommand(COMMAND_MAP.WEBVIEW_TO_HOST.UPDATE_SELECTION, (...args: unknown[]) => {
    const [maybePayload] = args;
    const payload = maybePayload as { filePath?: string; selected?: boolean } | undefined;
    if (!payload || typeof payload.filePath !== "string") {
      return;
    }
    services.workspaceManager.updateSelection(payload.filePath, Boolean(payload.selected));
    const selection = services.workspaceManager.getSelection();
    services.webviewPanelManager.setStateSnapshot({ selection }, { emit: false });
  });

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

  const registerUniqueCommands = (
    ids: string[],
    handler: () => unknown | Promise<unknown>
  ): void => {
    const uniqueIds = Array.from(new Set(ids));
    uniqueIds.forEach((commandId) => {
      registerCommand(commandId, async (...commandArgs: unknown[]) => {
        void commandArgs;
        return handler();
      });
    });
  };

  registerUniqueCommands([
    COMMAND_MAP.WEBVIEW_TO_HOST.SELECT_ALL,
    COMMAND_MAP.EXTENSION_ONLY.SELECT_ALL
  ], () => applySelection("select"));
  registerUniqueCommands([
    COMMAND_MAP.WEBVIEW_TO_HOST.DESELECT_ALL,
    COMMAND_MAP.EXTENSION_ONLY.DESELECT_ALL
  ], () => applySelection("clear"));

  registerCommand(COMMAND_MAP.WEBVIEW_TO_HOST.APPLY_PRESET, (...args: unknown[]) => {
    const [maybePayload] = args;
    const payload = maybePayload as { presetId?: string } | undefined;
    const presetId = typeof payload?.presetId === "string" && payload.presetId.length > 0 ? payload.presetId : "default";
    services.diagnostics.add(`Preset request received: ${presetId}. Presets are not yet implemented.`);
    void vscode.window.showInformationMessage(
      `Code Ingest: Preset "${presetId}" is not available yet.`,
      "Dismiss"
    );
  });

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

  registerUniqueCommands([
    COMMAND_MAP.WEBVIEW_TO_HOST.EXPAND_ALL,
    COMMAND_MAP.EXTENSION_ONLY.EXPAND_ALL
  ], () => adjustExpansion(true));
  registerUniqueCommands([
    COMMAND_MAP.WEBVIEW_TO_HOST.COLLAPSE_ALL,
    COMMAND_MAP.EXTENSION_ONLY.COLLAPSE_ALL
  ], () => adjustExpansion(false));
}
