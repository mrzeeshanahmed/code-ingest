import * as vscode from "vscode";
import { CodeIngestPanel } from "../providers/codeIngestPanel";
import { DashboardViewProvider } from "../providers/dashboardViewProvider";
import type { Diagnostics } from "../services/diagnostics";
import type { PerformanceMonitor } from "../services/performanceMonitor";
import type { HostCommandId } from "../commands/commandMap";

type PanelState = Record<string, unknown>;

type OperationStatusValue = "idle" | "running" | "completed" | "failed" | "cancelled";

interface OperationStatusEntry {
  readonly operation: string;
  readonly status: OperationStatusValue;
  readonly message?: string;
  readonly detail?: unknown;
  readonly progressId?: string;
  readonly updatedAt: number;
}

interface OperationProgressEntry {
  readonly id: string;
  readonly operation: string;
  readonly phase?: string;
  readonly message?: string;
  readonly percent?: number;
  readonly busy?: boolean;
  readonly filesProcessed?: number;
  readonly totalFiles?: number;
  readonly cancellable?: boolean;
  readonly cancelled?: boolean;
}

export class WebviewPanelManager {
  private stateSnapshot: PanelState | undefined;
  private readonly operationStatus = new Map<string, OperationStatusEntry>();
  private readonly progressRegistry = new Map<string, OperationProgressEntry>();

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

  updateOperationState(
    operation: string,
    update: Partial<Omit<OperationStatusEntry, "operation" | "updatedAt">> & { status?: OperationStatusValue } | null,
    options?: { emit?: boolean }
  ): void {
    if (!operation) {
      return;
    }

    if (!update) {
      if (this.operationStatus.delete(operation)) {
        this.flushOperationSnapshot(options);
      }
      return;
    }

    const existing = this.operationStatus.get(operation);
    const base: OperationStatusEntry = {
      operation,
      status: update.status ?? existing?.status ?? "idle",
      updatedAt: Date.now(),
      ...(update.message !== undefined
        ? { message: update.message }
        : existing?.message !== undefined
          ? { message: existing.message }
          : {}),
      ...(update.detail !== undefined
        ? { detail: update.detail }
        : existing?.detail !== undefined
          ? { detail: existing.detail }
          : {}),
      ...(update.progressId !== undefined
        ? { progressId: update.progressId }
        : existing?.progressId !== undefined
          ? { progressId: existing.progressId }
          : {})
    };
    this.operationStatus.set(operation, base);
    this.flushOperationSnapshot(options);
  }

  updateOperationProgress(
    operation: string,
    progressId: string,
    update: Partial<Omit<OperationProgressEntry, "operation" | "id" >> | null,
    options?: { emit?: boolean }
  ): void {
    if (!progressId) {
      return;
    }

    if (!update) {
      this.clearOperationProgress(progressId, options);
      return;
    }

    const existing = this.progressRegistry.get(progressId);
    const snapshot: OperationProgressEntry = {
      id: progressId,
      operation: operation || existing?.operation || "unknown",
      ...(update.phase !== undefined
        ? { phase: update.phase }
        : existing?.phase !== undefined
          ? { phase: existing.phase }
          : {}),
      ...(update.message !== undefined
        ? { message: update.message }
        : existing?.message !== undefined
          ? { message: existing.message }
          : {}),
      ...(update.percent !== undefined
        ? { percent: update.percent }
        : existing?.percent !== undefined
          ? { percent: existing.percent }
          : {}),
      ...(update.busy !== undefined
        ? { busy: update.busy }
        : existing?.busy !== undefined
          ? { busy: existing.busy }
          : {}),
      ...(update.filesProcessed !== undefined
        ? { filesProcessed: update.filesProcessed }
        : existing?.filesProcessed !== undefined
          ? { filesProcessed: existing.filesProcessed }
          : {}),
      ...(update.totalFiles !== undefined
        ? { totalFiles: update.totalFiles }
        : existing?.totalFiles !== undefined
          ? { totalFiles: existing.totalFiles }
          : {}),
      ...(update.cancellable !== undefined
        ? { cancellable: update.cancellable }
        : existing?.cancellable !== undefined
          ? { cancellable: existing.cancellable }
          : {}),
      ...(update.cancelled !== undefined
        ? { cancelled: update.cancelled }
        : existing?.cancelled !== undefined
          ? { cancelled: existing.cancelled }
          : {})
    };
    this.progressRegistry.set(progressId, snapshot);

    if (operation) {
      const status = this.operationStatus.get(operation) ?? {
        operation,
        status: "idle" as OperationStatusValue,
        updatedAt: Date.now()
      };
      this.operationStatus.set(operation, {
        ...status,
        progressId,
        updatedAt: Date.now()
      });
    }

    this.flushOperationSnapshot(options);
  }

  clearOperationProgress(progressId: string, options?: { emit?: boolean }): void {
    if (!progressId) {
      return;
    }

    const entry = this.progressRegistry.get(progressId);
    if (!entry) {
      return;
    }

    this.progressRegistry.delete(progressId);
    const status = this.operationStatus.get(entry.operation);
    if (status?.progressId === progressId) {
      const nextStatus: OperationStatusEntry = {
        operation: entry.operation,
        status: status.status,
        updatedAt: Date.now(),
        ...(status.message !== undefined ? { message: status.message } : {}),
        ...(status.detail !== undefined ? { detail: status.detail } : {})
      };
      this.operationStatus.set(entry.operation, nextStatus);
    }
    this.flushOperationSnapshot(options);
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

  private flushOperationSnapshot(options?: { emit?: boolean }): void {
    const emit = options?.emit !== false;
    const operationStatus = this.buildOperationStatusSnapshot();
    const operationProgress = this.buildOperationProgressSnapshot();
    const legacyPatch = this.buildLegacySnapshot(operationStatus, operationProgress);

    const payload: PanelState = {
      operationStatus,
      operationProgress,
      ...legacyPatch
    };
    this.setStateSnapshot(payload, { emit });
  }

  private buildOperationStatusSnapshot(): Record<string, OperationStatusEntry> {
    const entries: Record<string, OperationStatusEntry> = {};
    for (const [operation, snapshot] of this.operationStatus.entries()) {
      entries[operation] = { ...snapshot };
    }
    return entries;
  }

  private buildOperationProgressSnapshot(): Record<string, OperationProgressEntry> {
    const entries: Record<string, OperationProgressEntry> = {};
    for (const [key, snapshot] of this.progressRegistry.entries()) {
      entries[key] = { ...snapshot };
    }
    return entries;
  }

  private buildLegacySnapshot(
    operationStatus: Record<string, OperationStatusEntry>,
    operationProgress: Record<string, OperationProgressEntry>
  ): PanelState {
    const digestStatus = operationStatus.digest;
    const digestProgress = digestStatus?.progressId ? operationProgress[digestStatus.progressId] : undefined;

    const patch: PanelState = {};

    if (digestStatus) {
      const legacyStatusMap: Record<OperationStatusValue, string> = {
        idle: "idle",
        running: "digest-running",
        completed: "digest-ready",
        failed: "digest-failed",
        cancelled: "digest-cancelled"
      };
      patch.status = legacyStatusMap[digestStatus.status] ?? "idle";
    }

    if (digestProgress) {
      patch.progress = {
        id: digestProgress.id,
        phase: digestProgress.phase,
        percent: digestProgress.percent,
        message: digestProgress.message,
        filesProcessed: digestProgress.filesProcessed,
        totalFiles: digestProgress.totalFiles,
        busy: digestProgress.busy,
        cancellable: digestProgress.cancellable,
        cancelled: digestProgress.cancelled
      };
    } else if (digestStatus && digestStatus.progressId) {
      patch.progress = null;
    }

    return patch;
  }
}
