import { VFS_DRAIN_TIMEOUT_MS } from "../../config/constants";
import { GraphNode } from "../models/Node";
import { GraphEdge } from "../models/Edge";
import { GraphCodeChunk, GraphCommentChunk } from "../models/Chunk";

export interface DirtyBufferSnapshot {
  relativePath: string;
  diskMtimeMsAtResolve: number;
}

export interface PendingWriteBatch {
  reason: string;
  priority: "HIGH" | "MEDIUM" | "LOW";
  filePaths: string[];
  abortSignal?: AbortSignal;
  nodeUpserts: GraphNode[];
  edgeUpserts: GraphEdge[];
  codeChunkUpserts: GraphCodeChunk[];
  commentChunkUpserts: GraphCommentChunk[];
  deletes: Array<{ table: string; filePath?: string; ids?: string[] }>;
  dirtyBufferSnapshots?: DirtyBufferSnapshot[];
}

export type WriteExecutor = (batch: PendingWriteBatch) => Promise<void>;

export class SingleWriterQueue {
  private pending: PendingWriteBatch[] = [];
  private flushing = false;
  private coalesceTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly quiescenceResolvers: Array<() => void> = [];
  private degraded = false;

  private readonly COALESCE_MS = 10;
  private readonly MAX_BATCH_SIZE = 500;

  constructor(
    private readonly executor: WriteExecutor,
    private readonly outputChannel?: { appendLine(message: string): void }
  ) {}

  public enqueue(batch: PendingWriteBatch): Promise<void> {
    return new Promise((resolve, reject) => {
      if (batch.abortSignal?.aborted) {
        reject(new Error("Write batch aborted before enqueue"));
        return;
      }

      const wrappedBatch: PendingWriteBatch & { _resolve?: () => void; _reject?: (error: Error) => void } = {
        ...batch,
        _resolve: resolve,
        _reject: reject
      };

      this.pending.push(wrappedBatch as PendingWriteBatch);
      this.scheduleFlush();
    });
  }

  public async flush(): Promise<void> {
    if (this.coalesceTimer) {
      clearTimeout(this.coalesceTimer);
      this.coalesceTimer = undefined;
    }
    await this.runFlush();
  }

  public isBusy(): boolean {
    return this.flushing || this.pending.length > 0;
  }

  public waitForQuiescent(): Promise<void> {
    if (!this.flushing && this.pending.length === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.quiescenceResolvers.push(resolve);
    });
  }

  public isDegraded(): boolean {
    return this.degraded;
  }

  private scheduleFlush(): void {
    if (this.coalesceTimer || this.flushing) {
      return;
    }
    this.coalesceTimer = setTimeout(() => {
      this.coalesceTimer = undefined;
      void this.runFlush();
    }, this.COALESCE_MS);
  }

  private async runFlush(): Promise<void> {
    if (this.flushing || this.pending.length === 0) {
      return;
    }

    this.flushing = true;
    const batches = this.pending.splice(0, this.pending.length);

    try {
      const merged = this.coalesceBatches(batches);
      await this.executeWithDrain(merged);
      for (const batch of batches) {
        (batch as PendingWriteBatch & { _resolve?: () => void })._resolve?.();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      for (const batch of batches) {
        (batch as PendingWriteBatch & { _reject?: (error: Error) => void })._reject?.(new Error(message));
      }
    } finally {
      this.flushing = false;
      this.notifyQuiescence();
      if (this.pending.length > 0) {
        this.scheduleFlush();
      }
    }
  }

  private coalesceBatches(batches: PendingWriteBatch[]): PendingWriteBatch {
    const filePathSet = new Set<string>();
    const nodeUpserts = new Map<string, GraphNode>();
    const edgeUpserts = new Map<string, GraphEdge>();
    const codeChunks = new Map<string, GraphCodeChunk>();
    const commentChunks = new Map<string, GraphCommentChunk>();
    const deletes: Array<{ table: string; filePath?: string; ids?: string[] }> = [];
    let highestPriority: "HIGH" | "MEDIUM" | "LOW" = "LOW";
    const reasons: string[] = [];
    const dirtyBufferSnapshots = new Map<string, DirtyBufferSnapshot>();

    for (const batch of batches) {
      for (const fp of batch.filePaths) {
        filePathSet.add(fp);
      }
      for (const node of batch.nodeUpserts) {
        nodeUpserts.set(node.id, node);
      }
      for (const edge of batch.edgeUpserts) {
        edgeUpserts.set(edge.id, edge);
      }
      for (const chunk of batch.codeChunkUpserts) {
        codeChunks.set(chunk.id, chunk);
      }
      for (const chunk of batch.commentChunkUpserts) {
        commentChunks.set(chunk.id, chunk);
      }
      deletes.push(...batch.deletes);
      reasons.push(batch.reason);
      for (const snap of batch.dirtyBufferSnapshots ?? []) {
        dirtyBufferSnapshots.set(snap.relativePath, snap);
      }

      if (batch.priority === "HIGH" || (batch.priority === "MEDIUM" && highestPriority === "LOW")) {
        highestPriority = batch.priority;
      }
    }

    const result: PendingWriteBatch = {
      reason: reasons.join("; "),
      priority: highestPriority,
      filePaths: Array.from(filePathSet),
      nodeUpserts: Array.from(nodeUpserts.values()),
      edgeUpserts: Array.from(edgeUpserts.values()),
      codeChunkUpserts: Array.from(codeChunks.values()),
      commentChunkUpserts: Array.from(commentChunks.values()),
      deletes
    };
    if (dirtyBufferSnapshots.size > 0) {
      result.dirtyBufferSnapshots = Array.from(dirtyBufferSnapshots.values());
    }
    return result;
  }

  private async executeWithDrain(batch: PendingWriteBatch): Promise<void> {
    const start = Date.now();
    await this.executor(batch);
    const elapsed = Date.now() - start;

    if (elapsed > VFS_DRAIN_TIMEOUT_MS) {
      this.degraded = true;
      this.outputChannel?.appendLine(
        `[single-writer-queue] VFS drain timeout exceeded (${elapsed}ms). Runtime marked degraded.`
      );
    }
  }

  private notifyQuiescence(): void {
    if (this.flushing || this.pending.length > 0) {
      return;
    }
    while (this.quiescenceResolvers.length > 0) {
      const resolve = this.quiescenceResolvers.shift();
      resolve?.();
    }
  }
}
