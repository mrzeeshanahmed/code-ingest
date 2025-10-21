import * as path from "node:path";
import * as vscode from "vscode";
import { COMMAND_MAP } from "./commandMap";
import type { CommandRegistrar, CommandServices } from "./types";

const PROGRESS_OVERLAY_MESSAGE = "Selecting all files…";

type NormalizedSelectionResult =
  | { ok: true; relative: string }
  | { ok: false; reason: "no_workspace" | "invalid_payload" | "outside_workspace" };

let selectionHandlersReady = false;
let readinessPromise: Promise<void> | null = null;
let resolveReadiness: (() => void) | null = null;

async function waitForSelectionHandlers(): Promise<void> {
  if (selectionHandlersReady) {
    return;
  }
  if (!readinessPromise) {
    readinessPromise = new Promise<void>((resolve) => {
      resolveReadiness = resolve;
    });
  }
  await readinessPromise;
}

export function markSelectionHandlersReady(): void {
  selectionHandlersReady = true;
  resolveReadiness?.();
  readinessPromise = null;
  resolveReadiness = null;
}

function resetSelectionReadiness(): void {
  selectionHandlersReady = false;
  readinessPromise = null;
  resolveReadiness = null;
}

function normalizeSelectionPath(filePath: unknown, workspaceRoot: vscode.Uri | undefined): NormalizedSelectionResult {
  if (!workspaceRoot) {
    return { ok: false, reason: "no_workspace" };
  }

  if (typeof filePath !== "string") {
    return { ok: false, reason: "invalid_payload" };
  }

  let candidate = filePath.trim();
  if (!candidate) {
    return { ok: false, reason: "invalid_payload" };
  }

  if (candidate.startsWith("file://")) {
    try {
      candidate = vscode.Uri.parse(candidate).fsPath;
    } catch {
      return { ok: false, reason: "invalid_payload" };
    }
  }

  if (!path.isAbsolute(candidate)) {
    candidate = path.join(workspaceRoot.fsPath, candidate);
  }

  const relativePath = path.relative(workspaceRoot.fsPath, candidate);
  if (!relativePath || relativePath === "." || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return { ok: false, reason: "outside_workspace" };
  }

  const normalized = relativePath.split(path.sep).join("/");
  return { ok: true, relative: normalized };
}

function formatCount(value: number): string {
  return Math.max(0, value).toLocaleString();
}

export function registerSelectionCommands(
  context: vscode.ExtensionContext,
  services: CommandServices,
  registerCommand: CommandRegistrar
): void {
  const registerUniqueCommands = (ids: string[], handler: () => unknown | Promise<unknown>): void => {
    const uniqueIds = Array.from(new Set(ids));
    uniqueIds.forEach((commandId) => {
      registerCommand(commandId, (...commandArgs: unknown[]) => {
        void commandArgs;
        return Promise.resolve(handler());
      });
    });
  };

  registerCommand(COMMAND_MAP.WEBVIEW_TO_HOST.UPDATE_SELECTION, async (...args: unknown[]) => {
    await waitForSelectionHandlers();

    const [maybePayload] = args;
    const payload = maybePayload as { filePath?: unknown; selected?: unknown } | undefined;
    const workspaceRoot = services.workspaceManager.getWorkspaceRoot();
    const normalized = normalizeSelectionPath(payload?.filePath, workspaceRoot);

    if (!normalized.ok) {
      const reason = normalized.reason;
      if (reason === "no_workspace") {
        services.webviewPanelManager.sendCommand(COMMAND_MAP.HOST_TO_WEBVIEW.SHOW_ERROR, {
          title: "Selection unavailable",
          message: "Open a workspace folder before adjusting selections."
        });
      } else {
        const message = reason === "outside_workspace"
          ? "The requested item is outside the workspace."
          : "Unable to interpret the requested selection.";
        services.webviewPanelManager.sendCommand(COMMAND_MAP.HOST_TO_WEBVIEW.SHOW_ERROR, {
          title: "Invalid selection",
          message
        });
      }
      return { ok: false, reason } as const;
    }

    if (typeof payload?.selected !== "boolean") {
      services.webviewPanelManager.sendCommand(COMMAND_MAP.HOST_TO_WEBVIEW.SHOW_ERROR, {
        title: "Invalid selection",
        message: "Selection updates must specify a boolean target state."
      });
      return { ok: false, reason: "invalid_payload" as const };
    }

    return services.workspaceManager.withSelectionLock(async () => {
      services.workspaceManager.updateSelection(normalized.relative, payload.selected as boolean);
      const selection = services.workspaceManager.getSelection();
      services.webviewPanelManager.setStateSnapshot({ selection }, { emit: false });
      return { ok: true } as const;
    });
  });

  const applySelection = async (action: "select" | "clear") => {
    await waitForSelectionHandlers();

    return services.workspaceManager.withSelectionLock(async () => {
      if (action === "select") {
        const progressId = `select-${Date.now().toString(36)}`;
        const stateSnapshot = services.workspaceManager.getStateSnapshot();
        const totalFiles = stateSnapshot.totalFiles ?? 0;
        const progressCommand = COMMAND_MAP.HOST_TO_WEBVIEW.UPDATE_PROGRESS;
        let lastPercent = -1;
        let lastEmitted = 0;

        const emitProgress = (processed: number, total: number) => {
          const safeTotal = total > 0 ? total : Math.max(processed, totalFiles);
          const percent = safeTotal > 0 ? Math.min(100, Math.round((processed / safeTotal) * 100)) : 0;
          const now = Date.now();
          if (percent === lastPercent && now - lastEmitted < 80) {
            return;
          }
          lastPercent = percent;
          lastEmitted = now;
          const message = safeTotal > 0
            ? `Selecting ${formatCount(Math.min(processed, safeTotal))} of ${formatCount(safeTotal)} files`
            : `Selecting ${formatCount(processed)} file${processed === 1 ? "" : "s"}`;
          services.webviewPanelManager.sendCommand(progressCommand, {
            progressId,
            phase: "select",
            percent,
            message,
            overlayMessage: percent >= 100 ? undefined : PROGRESS_OVERLAY_MESSAGE
          });
        };

        emitProgress(0, totalFiles);

        try {
          const selection = await services.workspaceManager.selectAll((processed, total) => emitProgress(processed, total));
          services.webviewPanelManager.setStateSnapshot({ selection });
          services.diagnostics.add(`Selected ${selection.length} file${selection.length === 1 ? "" : "s"}.`);
          emitProgress(selection.length, totalFiles || selection.length);
          services.webviewPanelManager.sendCommand(progressCommand, {
            progressId,
            phase: "select",
            percent: 100,
            message: "Selection complete",
            overlayMessage: undefined
          });
          return { ok: true, selected: selection.length } as const;
        } catch (error) {
          const message = error instanceof Error ? error.message : "Select-all failed";
          services.diagnostics.add(`Select-all failed: ${message}`);
          services.webviewPanelManager.sendCommand(progressCommand, {
            progressId,
            phase: "select",
            percent: 0,
            message,
            overlayMessage: undefined
          });
          throw error;
        }
      }

      services.workspaceManager.clearSelection();
      services.webviewPanelManager.setStateSnapshot({ selection: [] });
      services.diagnostics.add("Cleared file selection.");
      return { ok: true, cleared: true } as const;
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

export const __testing = {
  resetReadiness: resetSelectionReadiness
};
