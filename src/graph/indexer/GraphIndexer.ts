import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { GraphSettings } from "../../config/constants";
import { FilterService } from "../../services/filterService";
import { FileNode, FileScanner } from "../../services/fileScanner";
import { BinaryDetector } from "../../utils/binaryDetector";
import { asyncPool } from "../../utils/asyncPool";
import { GraphDatabase } from "../database/GraphDatabase";
import { createGraphEdgeId, GraphEdge } from "../models/Edge";
import { createGraphNodeId, GraphNode, NodeType } from "../models/Node";
import { EdgeResolver, IndexedFileEntry } from "./EdgeResolver";
import { FileChunker } from "./FileChunker";
import { LspExtractor } from "./LspExtractor";
import { EmbeddingService } from "../../services/embeddingService";
import { PIIService, PIIPolicyMode } from "../../services/security/piiService";
import { generateChunkId, GraphCodeChunk, GraphCommentChunk } from "../models/Chunk";

export interface GraphIndexResult {
  indexedFiles: number;
  nodeCount: number;
  edgeCount: number;
  durationMs: number;
}

interface GraphIndexerDependencies {
  workspaceRoot: vscode.Uri;
  fileScanner: FileScanner;
  filterService: FilterService;
  graphDatabase: GraphDatabase;
  getSettings: () => GraphSettings;
  outputChannel?: { appendLine(message: string): void };
  embeddingService?: EmbeddingService;
}

export class GraphIndexer {
  private readonly workspaceRoot;
  private readonly fileScanner;
  private readonly filterService;
  private readonly graphDatabase;
  private readonly getSettings;
  private readonly outputChannel;
  private readonly embeddingService;
  private readonly lspExtractor;
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
    this.embeddingService = dependencies.embeddingService;
    this.lspExtractor = new LspExtractor(this.outputChannel);
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
          weight: 1
        });
      }
    }

    edges.push(...this.edgeResolver.resolve(existingEntries));

    if (fullRebuild) {
      this.graphDatabase.clear();
    }
    this.graphDatabase.replaceFiles(relativePaths, nodes, edges);
    this.graphDatabase.upsertCodeChunks(allCodeChunks);
    this.graphDatabase.upsertCommentChunks(allCommentChunks);
    const stats = this.graphDatabase.getStats();
    this.graphDatabase.setIndexState(stats.nodeCount, stats.edgeCount);

    return {
      indexedFiles: existingEntries.length,
      nodeCount: stats.nodeCount,
      edgeCount: stats.edgeCount,
      durationMs: Date.now() - startedAt
    };
  }

  private async indexSingleFile(relativePath: string): Promise<IndexedFileEntry | undefined> {
    const settings = this.getSettings();
    const absolutePath = path.resolve(this.workspaceRoot.fsPath, relativePath);
    try {
      const buffer = await fs.readFile(absolutePath);
      const stats = await fs.stat(absolutePath);
      const fileNode = this.createFileNode(absolutePath, relativePath, buffer, stats.mtimeMs);

      const isBinary = this.binaryDetector.isBinary(buffer) || this.binaryDetector.isBinaryPath(absolutePath);
      if (isBinary || stats.size > settings.maxFileSizeKB * 1024) {
        fileNode.metadata = {
          ...(fileNode.metadata ?? {}),
          binary: isBinary,
          truncatedExtraction: stats.size > settings.maxFileSizeKB * 1024
        };
        return {
          fileNode,
          symbolNodes: [],
          symbols: [],
          content: isBinary ? "" : buffer.toString("utf8"),
          codeChunks: [],
          commentChunks: []
        };
      }

      const content = buffer.toString("utf8");
      const languageId = this.detectLanguageId(relativePath);
      const symbols = await this.lspExtractor.extract(vscode.Uri.file(absolutePath), languageId, content);
      const symbolNodes = symbols.map((symbol) => this.createSymbolNode(fileNode, symbol.name, symbol.type, symbol.startLine, symbol.endLine));

      const rawChunks = this.fileChunker.chunk(content);
      const codeChunks: GraphCodeChunk[] = [];
      const commentChunks: GraphCommentChunk[] = [];

      for (const chunk of rawChunks) {
        // Here we could separate comments from code. For now, everything is considered code.
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

      return {
        fileNode,
        symbolNodes,
        symbols,
        content,
        codeChunks,
        commentChunks
      };
    } catch (error) {
      this.outputChannel?.appendLine(`[indexer] Failed to index ${relativePath}: ${(error as Error).message}`);
      return undefined;
    }
  }

  private createFileNode(absolutePath: string, relativePath: string, buffer: Buffer, lastIndexed: number): GraphNode {
    const hash = crypto.createHash("sha256").update(buffer).digest("hex");
    return {
      id: createGraphNodeId(this.workspaceRoot.fsPath, relativePath, relativePath, "file"),
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
      id: createGraphNodeId(this.workspaceRoot.fsPath, fileNode.relativePath, symbolName, type),
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
