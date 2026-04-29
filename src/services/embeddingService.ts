import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import { FileChunker } from "../graph/indexer/FileChunker";
import { IndexedFileEntry } from "../graph/indexer/EdgeResolver";
import { GraphDatabase } from "../graph/database/GraphDatabase";
import { GraphNode } from "../graph/models/Node";

export interface EmbeddedNodeMatch {
  node: GraphNode;
  distance: number;
}

export class EmbeddingService {
  private embeddingsPrimed = false;

  constructor(
    private readonly graphDatabase: GraphDatabase,
    private readonly outputChannel?: { appendLine(message: string): void }
  ) {}

  public isAvailable(): boolean {
    const lmApi = (vscode as unknown as { lm?: { computeTextEmbedding?: unknown } }).lm;
    return this.graphDatabase.isVectorExtensionLoaded() && typeof lmApi?.computeTextEmbedding === "function";
  }

  public async indexEntries(entries: IndexedFileEntry[], fileChunker: FileChunker): Promise<void> {
    void entries;
    void fileChunker;
  }

  public async search(query: string, limit: number): Promise<EmbeddedNodeMatch[]> {
    if (!query.trim()) {
      return [];
    }

    if (!this.isAvailable()) {
      return this.searchByLabel(query, limit);
    }

    try {
      await this.ensureEmbeddingsIndexed();
      const embedding = await this.computeEmbedding(query);
      if (embedding.length === 0) {
        return this.searchByLabel(query, limit);
      }

      const matches = this.graphDatabase.queryNearestEmbeddings(embedding, limit);
      return matches
        .map((match) => {
          const node = this.graphDatabase.getNodeById(match.nodeId);
          return node ? { node, distance: match.distance } : undefined;
        })
        .filter((match): match is EmbeddedNodeMatch => Boolean(match));
    } catch (error) {
      this.outputChannel?.appendLine(`[embedding] Falling back to label search: ${(error as Error).message}`);
      return this.searchByLabel(query, limit);
    }
  }

  private async ensureEmbeddingsIndexed(): Promise<void> {
    if (this.embeddingsPrimed || !this.isAvailable()) {
      return;
    }

    const fileNodes = this.graphDatabase.getAllNodes("file");
    const missingNodes = fileNodes.filter((node) => !this.graphDatabase.hasEmbedding(node.id));
    if (missingNodes.length === 0) {
      this.embeddingsPrimed = true;
      return;
    }

    const fileChunker = new FileChunker();
    const embeddings: Array<{ nodeId: string; embedding: number[] }> = [];
    for (const node of missingNodes) {
      try {
        const content = await fs.readFile(node.filePath, "utf8");
        if (!content.trim()) {
          continue;
        }

        const chunks = fileChunker.chunk(content);
        const excerpt = chunks.length > 0 ? chunks[0].content.slice(0, 512) : content.slice(0, 512);
        const embeddingInput = `[${node.type}] ${node.label} ${node.relativePath}\n${excerpt}`;
        const embedding = await this.computeEmbedding(embeddingInput);
        if (embedding.length === 0) {
          continue;
        }

        embeddings.push({ nodeId: node.id, embedding });
      } catch (error) {
        this.outputChannel?.appendLine(`[embedding] Skipping ${node.relativePath}: ${(error as Error).message}`);
      }
    }

    if (embeddings.length > 0) {
      this.outputChannel?.appendLine(`[embedding] Indexed ${embeddings.length} file embedding(s) on first semantic request.`);
      this.graphDatabase.upsertEmbeddings(embeddings);
    }

    this.embeddingsPrimed = true;
  }

  private async computeEmbedding(text: string): Promise<number[]> {
    const lmApi = (vscode as unknown as {
      lm?: { computeTextEmbedding?: (input: string) => Promise<number[] | Float32Array> };
    }).lm;

    if (typeof lmApi?.computeTextEmbedding !== "function") {
      return [];
    }

    const result = await lmApi.computeTextEmbedding(text);
    if (Array.isArray(result)) {
      return result.map((value) => Number(value));
    }

    if (result instanceof Float32Array) {
      return Array.from(result.values());
    }

    return [];
  }

  private async searchByLabel(query: string, limit: number): Promise<EmbeddedNodeMatch[]> {
    const normalizedQuery = query.toLowerCase();
    return this.graphDatabase
      .getAllNodes("function")
      .filter((node) => {
        const haystack = `${node.label} ${node.relativePath}`.toLowerCase();
        return haystack.includes(normalizedQuery);
      })
      .slice(0, Math.max(1, limit))
      .map((node) => ({ node, distance: 0 }));
  }
}
