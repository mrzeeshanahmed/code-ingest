import * as crypto from "node:crypto";
import * as path from "node:path";
import * as vscode from "vscode";
import { GraphSettings } from "../../config/constants";
import { FilterService } from "../../services/filterService";
import { FileScanner } from "../../services/fileScanner";
import { BinaryDetector } from "../../utils/binaryDetector";
import { asyncPool } from "../../utils/asyncPool";
import { GraphDatabase } from "../database/GraphDatabase";
import { DirtyBufferSnapshot } from "../database/SingleWriterQueue";
import { createGraphEdgeId, GraphEdge } from "../models/Edge";
import { generateChunkId, GraphCodeChunk, GraphCommentChunk } from "../models/Chunk";
import { createGraphNodeId, GraphNode, NodeType } from "../models/Node";
import { DirtyBufferResolver } from "./DirtyBufferResolver";
import { EdgeResolver, IndexedFileEntry } from "./EdgeResolver";
import { FileChunker } from "./FileChunker";
import { GrammarAssetResolver } from "./GrammarAssetResolver";
import { PIIService, PIIPolicyMode } from "../../services/security/piiService";
import { TreeSitterExtractor } from "./TreeSitterExtractor";

export interface GraphIndexResult {
  indexedFiles: number;
  nodeCount: number;
  edgeCount: number;
  durationMs: number;
}

interface GraphIndexerDependencies {
  workspaceRoot: vscode.Uri;
  extensionUri: vscode.Uri;
  fileScanner: FileScanner;
  filterService: FilterService;
  graphDatabase: GraphDatabase;
  getSettings: () => GraphSettings;
  outputChannel?: { appendLine(message: string): void };
}

export class GraphIndexer {
  private readonly workspaceRoot;
  private readonly fileScanner;
  private readonly filterService;
  private readonly graphDatabase;
  private readonly getSettings;
  private readonly outputChannel;
  private readonly treeSitterExtractor;
  private readonly dirtyBufferResolver;
  private readonly edgeResolver = new EdgeResolver();
  private readonly fileChunker = new FileChunker();
  private readonly binaryDetector = new BinaryDetector();
  private readonly piiService = new PIIService(PIIPolicyMode.Strict);

  constructor(dependencies: GraphIndexerDependencies) {
    this.workspaceRoot = dependencies.workspaceRoot;
    this.fileScanner = dependencies.fileScanner;
    this.filterService = dependencies.filterService;
    this.graphDatabase = dependencies.graphDatabase;
    this.getSettings = dependencies.getSettings;
    this.outputChannel = dependencies.outputChannel;
    const grammarResolver = new GrammarAssetResolver(dependencies.extensionUri);
    this.treeSitterExtractor = new TreeSitterExtractor(dependencies.extensionUri, this.outputChannel);
    this.dirtyBufferResolver = new DirtyBufferResolver(dependencies.workspaceRoot, grammarResolver);
  }

  public async indexWorkspace(): Promise<GraphIndexResult> {
    const startedAt = Date.now();
    const settings = this.getSettings();
    const scanResults = await this.fileScanner.scan({ maxEntries: settings.maxFiles * 2 });
    const filePaths = scanResults
      .filter((entry) => entry.type === "file" && entry.relPath)
      .map((entry) => path.resolve(this.workspaceRoot.fsPath, entry.relPath!));

    const filtered = await this.filterService.batchFilter(filePaths, {
      includePatterns: ["**/*"],
      excludePatterns: settings.excludePatterns,
      useGitignore: true,
      followSymlinks: false
    });

    const included = filePaths.filter((filePath) => filtered.get(filePath)?.included ?? false).slice(0, settings.maxFiles);
    const relativePaths = included.map((filePath) => path.relative(this.workspaceRoot.fsPath, filePath).replace(/\\/gu, "/"));
    return this.indexRelativePaths(relativePaths, startedAt, true);
  }

  public async reindexRelativePaths(relativePaths: string[]): Promise<GraphIndexResult> {
    return this.indexRelativePaths([...new Set(relativePaths)], Date.now(), false);
  }

  private async indexRelativePaths(relativePaths: string[], startedAt: number, fullRebuild: boolean): Promise<GraphIndexResult> {
    const entries = await asyncPool(
      relativePaths.map((relativePath) => async () => this.indexSingleFile(relativePath)),
      4
    );

    const existingEntries = entries.filter((entry): entry is IndexedFileEntry => Boolean(entry));
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const allCodeChunks: GraphCodeChunk[] = [];
    const allCommentChunks: GraphCommentChunk[] = [];
    const dirtyBufferSnapshots: DirtyBufferSnapshot[] = [];

    for (const entry of existingEntries) {
      nodes.push(entry.fileNode, ...entry.symbolNodes);
      allCodeChunks.push(...entry.codeChunks);
      allCommentChunks.push(...entry.commentChunks);
      for (const symbolNode of entry.symbolNodes) {
        edges.push({
          id: createGraphEdgeId(entry.fileNode.id, symbolNode.id, "contains"),
          sourceId: entry.fileNode.id,
          targetId: symbolNode.id,
          type: "contains",
          weight: 0.5
        });
      }
      if (entry.dirtyBufferSnapshot) {
        dirtyBufferSnapshots.push(entry.dirtyBufferSnapshot);
      }
    }

    edges.push(...this.edgeResolver.resolve(existingEntries));

    const deletes: Array<{ table: string; filePath?: string; ids?: string[] }> = [];
    if (fullRebuild) {
      await this.graphDatabase.clear();
    } else {
      for (const rp of relativePaths) {
        deletes.push({ table: "nodes", filePath: rp });
      }
    }

    const batch: import("../database/SingleWriterQueue").PendingWriteBatch = {
      reason: fullRebuild ? "full-rebuild" : "delta-reindex",
      priority: fullRebuild ? "LOW" : "MEDIUM",
      filePaths: relativePaths,
      nodeUpserts: nodes,
      edgeUpserts: edges,
      codeChunkUpserts: allCodeChunks,
      commentChunkUpserts: allCommentChunks,
      deletes
    };
    if (dirtyBufferSnapshots.length > 0) {
      batch.dirtyBufferSnapshots = dirtyBufferSnapshots;
    }
    await this.graphDatabase.writerQueue.enqueue(batch);

    const stats = this.graphDatabase.getStats();
    await this.graphDatabase.setIndexState(stats.nodeCount, stats.edgeCount);

    return {
      indexedFiles: existingEntries.length,
      nodeCount: stats.nodeCount,
      edgeCount: stats.edgeCount,
      durationMs: Date.now() - startedAt
    };
  }

  private async indexSingleFile(relativePath: string): Promise<IndexedFileEntry | undefined> {
    const settings = this.getSettings();
    const resolution = await this.dirtyBufferResolver.resolve(relativePath);
    if (!resolution) {
      return undefined;
    }

    try {
      const absolutePath = path.join(this.workspaceRoot.fsPath, relativePath);
      const fileNode = this.createFileNode(absolutePath, relativePath, resolution.contentHash, resolution.snapshotTimestamp);

      const isBinary = this.binaryDetector.isBinaryPath(absolutePath);
      const contentByteLength = Buffer.byteLength(resolution.content, "utf8");
      if (isBinary || contentByteLength > settings.maxFileSizeKB * 1024) {
        fileNode.metadata = {
          ...(fileNode.metadata ?? {}),
          binary: isBinary,
          truncatedExtraction: contentByteLength > settings.maxFileSizeKB * 1024
        };
        const entry: IndexedFileEntry = {
          fileNode,
          symbolNodes: [],
          symbols: [],
          content: isBinary ? "" : resolution.content,
          codeChunks: [],
          commentChunks: []
        };
        if (resolution.contentSource === "dirty-buffer") {
          entry.dirtyBufferSnapshot = { relativePath, diskMtimeMsAtResolve: resolution.diskMtimeMsAtResolve! };
        }
        return entry;
      }

      const languageId = this.detectLanguageId(relativePath);
      const extraction = await this.treeSitterExtractor.extract(absolutePath, languageId, resolution.content);
      const symbolNodes = extraction.symbols.map((symbol) =>
        this.createSymbolNode(fileNode, symbol.name, symbol.type, symbol.startLine, symbol.endLine)
      );

      const rawChunks = this.fileChunker.chunk(resolution.content);
      const codeChunks: GraphCodeChunk[] = [];
      const commentChunks: GraphCommentChunk[] = [];

      for (const chunk of rawChunks) {
        const piiResult = this.piiService.scanAndRedact(chunk.content);
        codeChunks.push({
          id: generateChunkId(fileNode.id, chunk.startLine, chunk.endLine),
          fileNodeId: fileNode.id,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          content: chunk.content,
          piiDetected: piiResult.detected,
          piiRedactedContent: piiResult.redactedContent
        });
      }

      const entry: IndexedFileEntry = {
        fileNode,
        symbolNodes,
        symbols: extraction.symbols,
        content: resolution.content,
        codeChunks,
        commentChunks
      };
      if (resolution.contentSource === "dirty-buffer") {
        entry.dirtyBufferSnapshot = { relativePath, diskMtimeMsAtResolve: resolution.diskMtimeMsAtResolve! };
      }
      return entry;
    } catch (error) {
      this.outputChannel?.appendLine(`[indexer] Failed to index ${relativePath}: ${(error as Error).message}`);
      return undefined;
    }
  }

  private createFileNode(absolutePath: string, relativePath: string, hash: string, lastIndexed: number): GraphNode {
    return {
      id: createGraphNodeId(this.workspaceRoot.fsPath, relativePath, ""),
      type: "file",
      label: path.basename(relativePath),
      filePath: absolutePath,
      relativePath,
      language: this.detectLanguageId(relativePath),
      lastIndexed,
      hash
    };
  }

  private createSymbolNode(
    fileNode: GraphNode,
    symbolName: string,
    type: NodeType,
    startLine: number,
    endLine: number
  ): GraphNode {
    return {
      id: createGraphNodeId(this.workspaceRoot.fsPath, fileNode.relativePath, symbolName),
      type,
      label: symbolName,
      filePath: fileNode.filePath,
      relativePath: fileNode.relativePath,
      startLine,
      endLine,
      language: fileNode.language,
      lastIndexed: fileNode.lastIndexed,
      hash: fileNode.hash,
      metadata: {
        parentId: fileNode.id
      }
    };
  }

  private detectLanguageId(relativePath: string): string {
    const extension = path.extname(relativePath).toLowerCase();
    switch (extension) {
      case ".ts":
      case ".tsx":
        return "typescript";
      case ".js":
      case ".jsx":
        return "javascript";
      case ".py":
        return "python";
      case ".json":
        return "json";
      case ".java":
        return "java";
      case ".go":
        return "go";
      case ".rs":
        return "rust";
      case ".md":
        return "markdown";
      default:
        return extension.replace(/^\./u, "") || "plaintext";
    }
  }
}
