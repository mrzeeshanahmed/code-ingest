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
const VECTORS_FILENAME = "vectors.json";

// NOTE: v1.1 deferred — SemanticIndexStore currently uses JSON file persistence
// and brute-force O(n) cosine search. Migration to hnswlib-wasm HNSW sidecars
// with versioned checksum manifests is planned for v1.1.

interface PersistedVectorEntry {
  id: string;
  vector: number[];
}

export class SemanticIndexStore {
  private vectors = new Map<string, number[]>();
  private docCount = 0;
  private staleCount = 0;
  private readonly indexPath: string;
  private readonly vectorsPath: string;

  constructor(
    private readonly workspaceRoot: string,
    private readonly graphDatabase: GraphDatabase,
    private readonly outputChannel?: { appendLine(message: string): void }
  ) {
    this.indexPath = path.join(workspaceRoot, ".vscode", "code-ingest", "semantic-index");
    this.vectorsPath = path.join(this.indexPath, VECTORS_FILENAME);
  }

  public async initialize(): Promise<void> {
    if (!fs.existsSync(this.indexPath)) {
      fs.mkdirSync(this.indexPath, { recursive: true });
    }
    await this.loadFromDisk();
    this.outputChannel?.appendLine(`[semantic-index] Initialized at ${this.indexPath} with ${this.docCount} document(s).`);
  }

  public async addDocuments(docs: SemanticDocument[]): Promise<void> {
    for (const doc of docs) {
      if (!this.vectors.has(doc.id)) {
        this.docCount += 1;
      }
      this.vectors.set(doc.id, doc.vector);
    }
    this.outputChannel?.appendLine(`[semantic-index] Added ${docs.length} document(s). Total: ${this.docCount}`);
    await this.persistToDisk();
    await this.checkCompaction();
  }

  public async removeDocuments(ids: string[]): Promise<void> {
    for (const id of ids) {
      if (this.vectors.has(id)) {
        this.vectors.delete(id);
        this.staleCount += 1;
      }
    }
    await this.persistToDisk();
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

  public async compact(): Promise<void> {
    // Rebuild the index by re-persisting all non-stale vectors.
    this.staleCount = 0;
    await this.persistToDisk();
    this.outputChannel?.appendLine("[semantic-index] Compaction complete.");
  }

  public dispose(): void {
    // Save before clearing.
    try {
      this.persistToDiskSync();
    } catch {
      // Best-effort: if we can't persist, at least clear memory.
    }
    this.vectors.clear();
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
    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    if (denominator === 0) {
      return 1; // maximum distance for zero-magnitude vectors
    }
    const similarity = dot / denominator;
    return 1 - similarity;
  }

  private async checkCompaction(): Promise<void> {
    const stalenessRatio = this.docCount > 0 ? this.staleCount / this.docCount : 0;
    if (this.docCount >= HNSW_COMPACTION_DOC_THRESHOLD || stalenessRatio >= HNSW_COMPACTION_STALENESS_RATIO) {
      this.outputChannel?.appendLine(`[semantic-index] Triggering compaction (docs=${this.docCount}, stale=${this.staleCount}).`);
      await this.compact();
    }
  }

  private async persistToDisk(): Promise<void> {
    const entries: PersistedVectorEntry[] = [];
    for (const [id, vector] of this.vectors.entries()) {
      entries.push({ id, vector });
    }
    const json = JSON.stringify({ version: 1, docCount: this.docCount, entries });
    await fs.promises.writeFile(this.vectorsPath, json, "utf8");
  }

  private persistToDiskSync(): void {
    const entries: PersistedVectorEntry[] = [];
    for (const [id, vector] of this.vectors.entries()) {
      entries.push({ id, vector });
    }
    const json = JSON.stringify({ version: 1, docCount: this.docCount, entries });
    fs.writeFileSync(this.vectorsPath, json, "utf8");
  }

  private async loadFromDisk(): Promise<void> {
    try {
      const raw = await fs.promises.readFile(this.vectorsPath, "utf8");
      const parsed = JSON.parse(raw) as { version: number; docCount: number; entries: PersistedVectorEntry[] };
      if (parsed.version !== 1 || !Array.isArray(parsed.entries)) {
        this.outputChannel?.appendLine("[semantic-index] Unknown or corrupt vectors file; starting fresh.");
        return;
      }
      for (const entry of parsed.entries) {
        this.vectors.set(entry.id, entry.vector);
      }
      this.docCount = parsed.docCount ?? this.vectors.size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.outputChannel?.appendLine(`[semantic-index] Failed to load vectors: ${(error as Error).message}`);
      }
    }
  }
}
