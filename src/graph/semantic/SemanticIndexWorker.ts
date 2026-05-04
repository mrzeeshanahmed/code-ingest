import { SemanticIndexStore, SemanticDocument, SemanticSearchResult } from "./SemanticIndexStore";
import { GraphDatabase } from "../database/GraphDatabase";
import { HNSW_COMPACTION_DOC_THRESHOLD, HNSW_COMPACTION_STALENESS_RATIO } from "../../config/constants";

export interface WorkerMessage {
  type: "index-documents" | "search" | "remove-documents" | "compact" | "dispose";
  payload?: unknown;
  requestId: string;
}

export interface WorkerResponse {
  type: "index-complete" | "search-results" | "error" | "disposed";
  payload?: unknown;
  requestId: string;
}

export class SemanticIndexWorker {
  private readonly indexStore: SemanticIndexStore;
  private disposed = false;

  constructor(
    workspaceRoot: string,
    graphDatabase: GraphDatabase,
    private readonly outputChannel?: { appendLine(message: string): void }
  ) {
    this.indexStore = new SemanticIndexStore(workspaceRoot, graphDatabase, outputChannel);
  }

  public async initialize(): Promise<void> {
    await this.indexStore.initialize();
    this.outputChannel?.appendLine("[semantic-worker] Initialized.");
  }

  public async handleMessage(message: WorkerMessage): Promise<WorkerResponse> {
    if (this.disposed) {
      return { type: "error", requestId: message.requestId, payload: "Worker is disposed." };
    }

    switch (message.type) {
      case "index-documents": {
        const docs = message.payload as SemanticDocument[];
        await this.indexStore.addDocuments(docs);
        return { type: "index-complete", requestId: message.requestId };
      }
      case "search": {
        const { queryVector, limit } = message.payload as { queryVector: number[]; limit: number };
        const results = this.indexStore.search(queryVector, limit);
        return {
          type: "search-results",
          requestId: message.requestId,
          payload: results
        };
      }
      case "remove-documents": {
        const ids = message.payload as string[];
        await this.indexStore.removeDocuments(ids);
        return { type: "index-complete", requestId: message.requestId };
      }
      case "compact":
        await this.indexStore.compact();
        return { type: "index-complete", requestId: message.requestId };
      case "dispose":
        await this.dispose();
        return { type: "disposed", requestId: message.requestId };
      default:
        return { type: "error", requestId: message.requestId, payload: `Unknown message type: ${(message as WorkerMessage).type}` };
    }
  }

  public async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.indexStore.dispose();
    this.outputChannel?.appendLine("[semantic-worker] Disposed.");
  }

  public isDisposed(): boolean {
    return this.disposed;
  }
}
