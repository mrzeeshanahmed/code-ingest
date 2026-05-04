import { GraphDatabase } from "../database/GraphDatabase";
import { GraphNode } from "../models/Node";

const KNOWLEDGE_MAX_CONCURRENT_SYNTHESIZES = 2;

export interface KnowledgeEntry {
  nodeId: string;
  summary: string;
  invariants: string[];
  createdAt: number;
  stale: boolean;
}

export class KnowledgeService {
  private activeSynthesizes = 0;
  private readonly queue: Array<() => void> = [];

  constructor(
    private readonly graphDatabase: GraphDatabase,
    private readonly outputChannel?: { appendLine(message: string): void }
  ) {}

  public async synthesizeForNode(node: GraphNode): Promise<KnowledgeEntry | undefined> {
    await this.acquireSlot();
    try {
      const chunks = await this.graphDatabase.getCodeChunksForFile(node.id);
      if (chunks.length === 0) {
        return undefined;
      }

      const content = chunks.map((c) => c.content).join("\n").slice(0, 4000);
      const summary = this.generateSummary(content);
      const invariants = this.extractInvariants(content);

      const entry: KnowledgeEntry = {
        nodeId: node.id,
        summary,
        invariants,
        createdAt: Date.now(),
        stale: false
      };

      this.outputChannel?.appendLine(`[knowledge] Synthesized knowledge for ${node.relativePath}.`);
      return entry;
    } finally {
      this.releaseSlot();
    }
  }

  public async prefetchModule(relativePath: string): Promise<void> {
    // Soft prefetch bounded to active-file or active-module scope only during idle windows.
    this.outputChannel?.appendLine(`[knowledge] Prefetch triggered for ${relativePath}.`);
  }

  private async acquireSlot(): Promise<void> {
    if (this.activeSynthesizes < KNOWLEDGE_MAX_CONCURRENT_SYNTHESIZES) {
      this.activeSynthesizes += 1;
      return;
    }
    return new Promise((resolve) => {
      this.queue.push(() => {
        this.activeSynthesizes += 1;
        resolve();
      });
    });
  }

  private releaseSlot(): void {
    this.activeSynthesizes -= 1;
    const next = this.queue.shift();
    next?.();
  }

  private generateSummary(content: string): string {
    const lines = content.split("\n").filter((line) => line.trim());
    if (lines.length === 0) {
      return "Empty file.";
    }
    const firstComment = lines.find((line) => line.trim().startsWith("//") || line.trim().startsWith("#") || line.trim().startsWith("/*"));
    return firstComment ? firstComment.trim().slice(0, 200) : `File with ${lines.length} lines.`;
  }

  private extractInvariants(content: string): string[] {
    const invariants: string[] = [];
    const exportMatches = content.match(/export\s+(?:class|interface|function)\s+([A-Za-z0-9_$]+)/gu);
    if (exportMatches) {
      for (const match of exportMatches) {
        invariants.push(`Exports ${match.split(/\s+/u).pop() ?? "unknown"}`);
      }
    }
    return invariants.slice(0, 5);
  }
}
