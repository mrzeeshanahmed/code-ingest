import * as vscode from "vscode";
import { GraphDatabase } from "../graph/database/GraphDatabase";
import { GraphNode } from "../graph/models/Node";
import { SemanticIndexWorker } from "../graph/semantic/SemanticIndexWorker";

export interface EmbeddedNodeMatch {
  node: GraphNode;
  distance: number;
}

export class EmbeddingService {
  private readonly semanticWorker: SemanticIndexWorker;
  private state: "idle" | "active" | "cooldown" = "idle";
  private cooldownUntil = 0;
  private readonly maxRetries = 3;
  private readonly cooldownMs = 300000; // 5 minutes
  private computeLock: Promise<number[] | undefined> | undefined;

  constructor(
    workspaceRoot: string,
    private readonly graphDatabase: GraphDatabase,
    private readonly outputChannel?: { appendLine(message: string): void }
  ) {
    this.semanticWorker = new SemanticIndexWorker(workspaceRoot, graphDatabase, outputChannel);
  }

  public async initialize(): Promise<void> {
    await this.semanticWorker.initialize();
  }

  public isAvailable(): boolean {
    const lmApi = (vscode as unknown as { lm?: { computeTextEmbedding?: unknown } }).lm;
    return typeof lmApi?.computeTextEmbedding === "function";
  }

  public async indexNodes(nodes: GraphNode[]): Promise<void> {
    if (!this.isAvailable() || this.semanticWorker.isDisposed()) {
      this.outputChannel?.appendLine("[embedding] computeTextEmbedding unavailable; skipping semantic index.");
      return;
    }

    const docs = [];
    for (const node of nodes) {
      const vector = await this.computeEmbeddingWithRetry(`${node.label} ${node.relativePath}`);
      if (vector) {
        docs.push({ id: node.id, content: `${node.label} ${node.relativePath}`, vector });
      }
    }

    if (docs.length > 0) {
      await this.semanticWorker.handleMessage({
        type: "index-documents",
        payload: docs,
        requestId: `index-${Date.now()}`
      });
    }
  }

  public async search(query: string, limit: number): Promise<EmbeddedNodeMatch[]> {
    if (!query.trim()) {
      return [];
    }

    if (!this.isAvailable()) {
      return this.searchByLabel(query, limit);
    }

    const queryVector = await this.computeEmbeddingWithRetry(query);
    if (!queryVector) {
      return this.searchByLabel(query, limit);
    }

    const response = await this.semanticWorker.handleMessage({
      type: "search",
      payload: { queryVector, limit },
      requestId: `search-${Date.now()}`
    });

    if (response.type === "error") {
      return this.searchByLabel(query, limit);
    }

    const results = (response.payload ?? []) as Array<{ id: string; distance: number }>;
    const matches: EmbeddedNodeMatch[] = [];
    for (const r of results) {
      const actualNode = this.graphDatabase.getNodeById(r.id);
      if (actualNode) {
        matches.push({ node: actualNode, distance: r.distance });
      }
    }
    return matches;
  }

  public async dispose(): Promise<void> {
    await this.semanticWorker.dispose();
  }

  private async computeEmbeddingWithRetry(text: string): Promise<number[] | undefined> {
    if (this.state === "cooldown" && Date.now() < this.cooldownUntil) {
      return undefined;
    }

    // Atomic serialization: only one embedding call active at a time.
    while (this.computeLock) {
      try {
        await this.computeLock;
      } catch {
        // previous call failed, proceed
      }
    }

    if (this.state === "cooldown" && Date.now() < this.cooldownUntil) {
      return undefined;
    }

    this.computeLock = this.doComputeEmbeddingWithRetry(text);
    try {
      return await this.computeLock;
    } finally {
      this.computeLock = undefined;
    }
  }

  private async doComputeEmbeddingWithRetry(text: string): Promise<number[] | undefined> {
    this.state = "active";
    for (let attempt = 0; attempt < this.maxRetries; attempt += 1) {
      try {
        const lmApi = (vscode as unknown as { lm?: { computeTextEmbedding: (text: string) => Promise<number[]> } }).lm;
        if (!lmApi?.computeTextEmbedding) {
          this.state = "idle";
          return undefined;
        }
        const vector = await lmApi.computeTextEmbedding(text);
        this.state = "idle";
        return vector;
      } catch (error) {
        this.outputChannel?.appendLine(`[embedding] Attempt ${attempt + 1} failed: ${(error as Error).message}`);
        if (attempt < this.maxRetries - 1) {
          await this.delay(1000 * (attempt + 1));
        }
      }
    }

    this.state = "cooldown";
    this.cooldownUntil = Date.now() + this.cooldownMs;
    this.outputChannel?.appendLine("[embedding] Entering cooldown after 3 failed attempts.");
    return undefined;
  }

  private searchByLabel(query: string, limit: number): EmbeddedNodeMatch[] {
    const terms = query.toLowerCase().split(/\s+/u).filter(Boolean);
    if (terms.length === 0) {
      return [];
    }
    const all = this.graphDatabase.getAllNodes("function");
    return all
      .filter((n) => terms.some((t) => n.label.toLowerCase().includes(t) || n.relativePath.toLowerCase().includes(t)))
      .slice(0, limit)
      .map((node) => ({ node, distance: 0 }));
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
