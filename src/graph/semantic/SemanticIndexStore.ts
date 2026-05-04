import * as path from "node:path";
import * as fs from "node:fs";
import { GraphDatabase } from "../database/GraphDatabase";

export interface SemanticDocument {
  id: string;
  content: string;
  vector: number[];
}

export interface SemanticSearchResult {
  id: string;
  distance: number;
}

const HNSW_COMPACTION_DOC_THRESHOLD = 5000;
const HNSW_COMPACTION_STALENESS_RATIO = 0.3;

export class SemanticIndexStore {
  private vectors = new Map<string, number[]>();
  private docCount = 0;
  private staleCount = 0;
  private readonly indexPath: string;

  constructor(
    private readonly workspaceRoot: string,
    private readonly graphDatabase: GraphDatabase,
    private readonly outputChannel?: { appendLine(message: string): void }
  ) {
    this.indexPath = path.join(workspaceRoot, ".vscode", "code-ingest", "semantic-index");
  }

  public async initialize(): Promise<void> {
    if (!fs.existsSync(this.indexPath)) {
      fs.mkdirSync(this.indexPath, { recursive: true });
    }
    this.outputChannel?.appendLine(`[semantic-index] Initialized at ${this.indexPath}`);
  }

  public async addDocuments(docs: SemanticDocument[]): Promise<void> {
    for (const doc of docs) {
      this.vectors.set(doc.id, doc.vector);
      this.docCount += 1;
    }
    this.outputChannel?.appendLine(`[semantic-index] Added ${docs.length} document(s). Total: ${this.docCount}`);
    await this.checkCompaction();
  }

  public async removeDocuments(ids: string[]): Promise<void> {
    for (const id of ids) {
      if (this.vectors.has(id)) {
        this.vectors.delete(id);
        this.staleCount += 1;
      }
    }
  }

  public search(queryVector: number[], limit: number): SemanticSearchResult[] {
    const results: SemanticSearchResult[] = [];
    for (const [id, vector] of this.vectors.entries()) {
      const distance = this.cosineDistance(queryVector, vector);
      results.push({ id, distance });
    }
    results.sort((a, b) => a.distance - b.distance);
    return results.slice(0, limit);
  }

  private cosineDistance(a: number[], b: number[]): number {
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i += 1) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const similarity = dot / (Math.sqrt(normA) * Math.sqrt(normB));
    return 1 - similarity;
  }

  private async checkCompaction(): Promise<void> {
    const stalenessRatio = this.docCount > 0 ? this.staleCount / this.docCount : 0;
    if (this.docCount >= HNSW_COMPACTION_DOC_THRESHOLD || stalenessRatio >= HNSW_COMPACTION_STALENESS_RATIO) {
      this.outputChannel?.appendLine(`[semantic-index] Triggering compaction (docs=${this.docCount}, stale=${this.staleCount}).`);
      await this.compact();
    }
  }

  public async compact(): Promise<void> {
    // Placeholder: rebuild index, persist to disk.
    this.staleCount = 0;
    this.outputChannel?.appendLine("[semantic-index] Compaction complete.");
  }

  public dispose(): void {
    this.vectors.clear();
  }
}
