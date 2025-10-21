import * as vscode from "vscode";
import { CodeIngestPanel } from "../providers/codeIngestPanel";
import { DashboardViewProvider } from "../providers/dashboardViewProvider";
import type { Diagnostics } from "../services/diagnostics";
import type { PerformanceMonitor } from "../services/performanceMonitor";
import type { HostCommandId } from "../commands/commandMap";

type PanelState = Record<string, unknown>;

export class WebviewPanelManager {
  private stateSnapshot: PanelState | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly ensureResourcesReady: () => Promise<void>,
    private readonly diagnostics: Diagnostics,
    private readonly performanceMonitor: PerformanceMonitor
  ) {}

  async createAndShowPanel(state?: PanelState): Promise<void> {
    if (state) {
      this.setStateSnapshot(state, { emit: false });
    }
    await this.ensureResourcesReady();
    const focusCommand = `${DashboardViewProvider.viewType}.focus`;
    try {
      await vscode.commands.executeCommand(focusCommand);
    } catch (focusError) {
      try {
        await CodeIngestPanel.createOrShow(this.extensionUri);
      } catch (panelError) {
        console.error("WebviewPanelManager: failed to show dashboard panel", {
          focusError,
          panelError
        });
      }
    }
  }

  setStateSnapshot(state: PanelState, options?: { emit?: boolean }): void {
    const incomingState = state ?? {};
    const emit = options?.emit !== false;
    const metadata = {
      emit,
      selectionCount: Array.isArray((incomingState as { selection?: unknown }).selection)
        ? ((incomingState as { selection: unknown[] }).selection.length)
        : undefined,
      treeRoots: Array.isArray((incomingState as { tree?: unknown[] }).tree)
        ? ((incomingState as { tree: unknown[] }).tree.length)
        : undefined
    };
    let previewSnapshot: { length?: number; truncated?: boolean } | undefined;

    const applySnapshot = () => {
      const nextState = this.stateSnapshot ? { ...this.stateSnapshot, ...incomingState } : { ...incomingState };
      this.stateSnapshot = nextState;

      const previewCandidate = (nextState as { preview?: { content?: unknown; truncated?: unknown } }).preview;
      if (previewCandidate && typeof previewCandidate === "object") {
        const content = (previewCandidate as { content?: unknown }).content;
        const previewLength = typeof content === "string" ? content.length : undefined;
        const isTruncated = (previewCandidate as { truncated?: unknown }).truncated === true;
        previewSnapshot = {};
        if (typeof previewLength === "number") {
          previewSnapshot.length = previewLength;
        }
        if (isTruncated) {
          previewSnapshot.truncated = true;
        }
      }

      if (!emit) {
        return;
      }
      const snapshot = { ...nextState };
      const delivered = DashboardViewProvider.restoreState(snapshot);
      if (!delivered) {
        CodeIngestPanel.restoreState({ ...snapshot });
        return;
      }
      CodeIngestPanel.restoreState({ ...snapshot });
    };

    const { metrics } = this.performanceMonitor.measureSync("webview.setStateSnapshot", () => applySnapshot(), metadata);
    const durationMs = Math.round(metrics.duration);
    const selectionCount = metadata.selectionCount ?? 0;
    const previewLength = previewSnapshot?.length ?? 0;
    const previewTruncated = previewSnapshot?.truncated === true ? "yes" : "no";
    this.diagnostics.add(
      `[trace] stateSnapshot emit=${emit} selectionCount=${selectionCount} previewLength=${previewLength} truncated=${previewTruncated} duration=${durationMs}ms.`
    );
  }

  getStateSnapshot(): PanelState | undefined {
    return this.stateSnapshot ? { ...this.stateSnapshot } : undefined;
  }

  tryRestoreState(): boolean {
    if (!this.stateSnapshot) {
      return false;
    }
    const snapshot = { ...this.stateSnapshot };
    const viewRestored = DashboardViewProvider.restoreState({ ...snapshot });
    const panelRestored = CodeIngestPanel.restoreState({ ...snapshot });
    return viewRestored || panelRestored;
  }

  sendCommand(command: HostCommandId, payload: unknown, options?: { expectsAck?: boolean }): void {
    const deliveredToView = DashboardViewProvider.postCommand(command, payload, options);
    const deliveredToPanel = CodeIngestPanel.postCommand(command, payload, options);

    if (!deliveredToView && !deliveredToPanel) {
      console.warn("WebviewPanelManager: unable to deliver command", { command });
    }
  }
}
