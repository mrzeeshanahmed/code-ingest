import * as vscode from "vscode";
import { GraphDatabase } from "../graph/database/GraphDatabase";
import { GraphNode } from "../graph/models/Node";
import { SemanticIndexStore, SemanticDocument } from "../graph/semantic/SemanticIndexStore";

export interface EmbeddedNodeMatch {
  node: GraphNode;
  distance: number;
}

export class EmbeddingService {
  private readonly indexStore: SemanticIndexStore;
  private state: "idle" | "active" | "cooldown" = "idle";
  private cooldownUntil = 0;
  private readonly maxRetries = 3;
  private readonly cooldownMs = 300000; // 5 minutes

  constructor(
    workspaceRoot: string,
    graphDatabase: GraphDatabase,
    private readonly outputChannel?: { appendLine(message: string): void }
  ) {
    this.indexStore = new SemanticIndexStore(workspaceRoot, graphDatabase, outputChannel);
  }

  public async initialize(): Promise<void> {
    await this.indexStore.initialize();
  }

  public isAvailable(): boolean {
    const lmApi = (vscode as unknown as { lm?: { computeTextEmbedding?: unknown } }).lm;
    return typeof lmApi?.computeTextEmbedding === "function";
  }

  public async indexNodes(nodes: GraphNode[]): Promise<void> {
    if (!this.isAvailable()) {
      this.outputChannel?.appendLine("[embedding] computeTextEmbedding unavailable; skipping semantic index.");
      return;
    }

    const docs: SemanticDocument[] = [];
    for (const node of nodes) {
      const vector = await this.computeEmbeddingWithRetry(`${node.label} ${node.relativePath}`);
      if (vector) {
        docs.push({ id: node.id, content: `${node.label} ${node.relativePath}`, vector });
      }
    }

    if (docs.length > 0) {
      await this.indexStore.addDocuments(docs);
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

    const results = this.indexStore.search(queryVector, limit);
    return results.map((r: { id: string; distance: number }) => {
      const node = { id: r.id, label: "", type: "file", filePath: "", relativePath: "", lastIndexed: 0, hash: "" } as GraphNode;
      return { node, distance: r.distance };
    });
  }

  private async computeEmbeddingWithRetry(text: string): Promise<number[] | undefined> {
    if (this.state === "cooldown" && Date.now() < this.cooldownUntil) {
      return undefined;
    }

    for (let attempt = 0; attempt < this.maxRetries; attempt += 1) {
      try {
        const lmApi = (vscode as unknown as { lm?: { computeTextEmbedding: (text: string) => Promise<number[]> } }).lm;
        if (!lmApi?.computeTextEmbedding) {
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
    const normalizedQuery = query.toLowerCase();
    // Fallback: this requires access to the graph database which we don't store directly.
    // In practice, the caller should provide nodes. For now return empty.
    return [];
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
