import { VFS_DRAIN_TIMEOUT_MS } from "../../config/constants";
import { GraphNode } from "../models/Node";
import { GraphEdge } from "../models/Edge";
import { GraphCodeChunk, GraphCommentChunk, GraphKnowledgeChunk } from "../models/Chunk";

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
  knowledgeChunkUpserts: GraphKnowledgeChunk[];
  deletes: Array<{ table: string; filePath?: string; ids?: string[] }>;
  dirtyBufferSnapshots?: DirtyBufferSnapshot[];
  termUpserts?: any[];
  termLinkUpserts?: any[];
  directoryStateUpserts?: any[];
  embeddingMetadataUpserts?: any[];
  artifactStateUpserts?: any[];
  moduleSummaryUpserts?: any[];
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
      const split = this.splitBatch(merged, this.MAX_BATCH_SIZE);
      for (const b of split) {
        await this.executeWithDrain(b);
      }
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
    const knowledgeChunks = new Map<string, GraphKnowledgeChunk>();
    const deletes: Array<{ table: string; filePath?: string; ids?: string[] }> = [];
    const termUpserts: any[] = [];
    const termLinkUpserts: any[] = [];
    const directoryStateUpserts: any[] = [];
    const embeddingMetadataUpserts: any[] = [];
    const artifactStateUpserts: any[] = [];
    const moduleSummaryUpserts: any[] = [];
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
      for (const chunk of batch.knowledgeChunkUpserts) {
        knowledgeChunks.set(chunk.id, chunk);
      }
      deletes.push(...batch.deletes);
      reasons.push(batch.reason);
      for (const snap of batch.dirtyBufferSnapshots ?? []) {
        dirtyBufferSnapshots.set(snap.relativePath, snap);
      }
      if (batch.termUpserts) termUpserts.push(...batch.termUpserts);
      if (batch.termLinkUpserts) termLinkUpserts.push(...batch.termLinkUpserts);
      if (batch.directoryStateUpserts) directoryStateUpserts.push(...batch.directoryStateUpserts);
      if (batch.embeddingMetadataUpserts) embeddingMetadataUpserts.push(...batch.embeddingMetadataUpserts);
      if (batch.artifactStateUpserts) artifactStateUpserts.push(...batch.artifactStateUpserts);
      if (batch.moduleSummaryUpserts) moduleSummaryUpserts.push(...batch.moduleSummaryUpserts);

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
      knowledgeChunkUpserts: Array.from(knowledgeChunks.values()),
      deletes,
      termUpserts,
      termLinkUpserts,
      directoryStateUpserts,
      embeddingMetadataUpserts,
      artifactStateUpserts,
      moduleSummaryUpserts
    };
    if (dirtyBufferSnapshots.size > 0) {
      result.dirtyBufferSnapshots = Array.from(dirtyBufferSnapshots.values());
    }
    return result;
  }

  private splitBatch(batch: PendingWriteBatch, maxSize: number): PendingWriteBatch[] {
    const totalSize = Math.max(
      batch.nodeUpserts.length,
      batch.edgeUpserts.length,
      batch.codeChunkUpserts.length,
      batch.commentChunkUpserts.length,
      batch.knowledgeChunkUpserts.length,
      batch.termUpserts?.length ?? 0,
      batch.termLinkUpserts?.length ?? 0
    );
    if (totalSize <= maxSize) return [batch];

    const result: PendingWriteBatch[] = [];
    let offset = 0;
    while (offset < totalSize) {
      const splitBatch: PendingWriteBatch = {
        reason: batch.reason,
        priority: batch.priority,
        filePaths: batch.filePaths, // copy to all chunks
        nodeUpserts: batch.nodeUpserts.slice(offset, offset + maxSize),
        edgeUpserts: batch.edgeUpserts.slice(offset, offset + maxSize),
        codeChunkUpserts: batch.codeChunkUpserts.slice(offset, offset + maxSize),
        commentChunkUpserts: batch.commentChunkUpserts.slice(offset, offset + maxSize),
        knowledgeChunkUpserts: batch.knowledgeChunkUpserts.slice(offset, offset + maxSize),
        deletes: offset === 0 ? batch.deletes : [], // only do deletes once
      };
      if (batch.termUpserts) splitBatch.termUpserts = batch.termUpserts.slice(offset, offset + maxSize);
      if (batch.termLinkUpserts) splitBatch.termLinkUpserts = batch.termLinkUpserts.slice(offset, offset + maxSize);
      if (batch.directoryStateUpserts) splitBatch.directoryStateUpserts = batch.directoryStateUpserts.slice(offset, offset + maxSize);
      if (batch.embeddingMetadataUpserts) splitBatch.embeddingMetadataUpserts = batch.embeddingMetadataUpserts.slice(offset, offset + maxSize);
      if (batch.artifactStateUpserts) splitBatch.artifactStateUpserts = batch.artifactStateUpserts.slice(offset, offset + maxSize);
      if (batch.moduleSummaryUpserts) splitBatch.moduleSummaryUpserts = batch.moduleSummaryUpserts.slice(offset, offset + maxSize);
      if (batch.dirtyBufferSnapshots) splitBatch.dirtyBufferSnapshots = batch.dirtyBufferSnapshots;

      result.push(splitBatch);
      offset += maxSize;
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
