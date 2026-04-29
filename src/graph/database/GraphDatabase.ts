import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { GRAPH_SCHEMA_VERSION } from "../../config/constants";
import { GraphEdge } from "../models/Edge";
import { GraphNode, NodeType } from "../models/Node";
import { GraphCodeChunk, GraphCommentChunk } from "../models/Chunk";
import { CORE_DDL, FALLBACK_DDL, VEC_DDL } from "./schema";

type BetterSqliteDatabase = {
  pragma(statement: string): unknown;
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number };
    get(...params: unknown[]): Record<string, unknown> | undefined;
    all(...params: unknown[]): Array<Record<string, unknown>>;
    iterate(...params: unknown[]): Iterable<Record<string, unknown>>;
  };
  transaction<T extends (...args: never[]) => unknown>(fn: T): T;
  close(): void;
  loadExtension?(extensionPath: string): void;
};

type BetterSqliteConstructor = new (databasePath: string) => BetterSqliteDatabase;
type SqliteVecModule = {
  load(database: BetterSqliteDatabase): void;
};

interface GraphDatabaseOptions {
  outputChannel?: { appendLine(message: string): void };
  databasePath?: string;
  sqliteVecExtensionPath?: string;
}

export interface GraphStats {
  nodeCount: number;
  edgeCount: number;
  fileCount: number;
  databaseSizeBytes: number;
  lastIndexed: number | null;
  languages: Record<string, number>;
}

export interface IndexedFileRecord {
  relativePath: string;
  hash: string;
  lastIndexed: number;
}

export interface IndexStateRecord {
  workspaceHash: string;
  lastFullIndex: number | null;
  nodeCount: number;
  edgeCount: number;
  schemaVersion: number;
}

export interface SimilarNodeMatch {
  nodeId: string;
  distance: number;
}

const EMBEDDING_DIMENSION = 1536;

function ensureDirectory(directoryPath: string): void {
  fs.mkdirSync(directoryPath, { recursive: true });
}

function tryRequireBetterSqlite(): BetterSqliteConstructor | undefined {
  try {
    const required = require("better-sqlite3") as unknown;
    return required as BetterSqliteConstructor;
  } catch {
    return undefined;
  }
}

function tryRequireSqliteVec(): SqliteVecModule | undefined {
  try {
    const required = require("sqlite-vec") as unknown;
    return required as SqliteVecModule;
  } catch {
    return undefined;
  }
}

function parseMetadata(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "string" || value.trim() === "") {
    return undefined;
  }

  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function serializeMetadata(value: Record<string, unknown> | undefined): string | null {
  if (!value || Object.keys(value).length === 0) {
    return null;
  }

  return JSON.stringify(value);
}

function mapNode(row: Record<string, unknown>): GraphNode {
  const node: GraphNode = {
    id: String(row.id),
    type: row.type as NodeType,
    label: String(row.label),
    filePath: String(row.file_path),
    relativePath: String(row.relative_path),
    lastIndexed: Number(row.last_indexed),
    hash: String(row.hash)
  };

  if (typeof row.start_line === "number") {
    node.startLine = row.start_line;
  }

  if (typeof row.end_line === "number") {
    node.endLine = row.end_line;
  }

  if (typeof row.language === "string" && row.language) {
    node.language = row.language;
  }

  const metadata = parseMetadata(row.metadata);
  if (metadata) {
    node.metadata = metadata;
  }

  return node;
}

function mapEdge(row: Record<string, unknown>): GraphEdge {
  const edge: GraphEdge = {
    id: String(row.id),
    sourceId: String(row.source_id),
    targetId: String(row.target_id),
    type: row.type as GraphEdge["type"],
    weight: Number(row.weight ?? 1)
  };

  const metadata = parseMetadata(row.metadata);
  if (metadata) {
    edge.metadata = metadata;
  }

  return edge;
}

export class GraphDatabase {
  public readonly workspaceHash: string;
  public readonly databasePath: string;

  private readonly outputChannel;
  private readonly sqliteVecExtensionPath;
  private db: BetterSqliteDatabase | undefined;
  private vectorExtensionLoaded = false;

  constructor(private readonly workspaceRoot: string, options: GraphDatabaseOptions = {}) {
    this.workspaceHash = crypto.createHash("sha256").update(workspaceRoot).digest("hex");
    this.databasePath = options.databasePath ?? path.join(workspaceRoot, ".vscode", "code-ingest", "graph.db");
    this.outputChannel = options.outputChannel;
    this.sqliteVecExtensionPath = options.sqliteVecExtensionPath;
  }

  public open(): void {
    if (this.db) {
      return;
    }

    const BetterSqlite = tryRequireBetterSqlite();
    if (!BetterSqlite) {
      throw new Error("better-sqlite3 is not installed. Graph features are unavailable.");
    }

    ensureDirectory(path.dirname(this.databasePath));
    const db = new BetterSqlite(this.databasePath);
    this.db = db;

    for (const statement of CORE_DDL) {
      db.exec(statement);
    }

    this.tryLoadVectorExtension(db);
    if (this.vectorExtensionLoaded) {
      for (const statement of VEC_DDL) {
        db.exec(statement);
      }
    } else {
      for (const statement of FALLBACK_DDL) {
        db.exec(statement);
      }
    }
  }

  public close(): void {
    this.db?.close();
    this.db = undefined;
  }

  public dispose(): void {
    this.close();
  }

  public isVectorExtensionLoaded(): boolean {
    return this.vectorExtensionLoaded;
  }

  public getLastFullIndex(): number | null {
    return this.getIndexState()?.lastFullIndex ?? null;
  }

  public needsSchemaUpgrade(): boolean {
    const current = this.getIndexState();
    return !current || current.schemaVersion !== GRAPH_SCHEMA_VERSION;
  }

  public setIndexState(nodeCount: number, edgeCount: number, timestamp = Date.now()): void {
    const db = this.getDb();
    db.prepare(
      `INSERT INTO index_state (workspace_hash, last_full_index, node_count, edge_count, schema_version)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(workspace_hash) DO UPDATE SET
         last_full_index = excluded.last_full_index,
         node_count = excluded.node_count,
         edge_count = excluded.edge_count,
         schema_version = excluded.schema_version`
    ).run(this.workspaceHash, timestamp, nodeCount, edgeCount, GRAPH_SCHEMA_VERSION);
  }

  public getIndexState(): IndexStateRecord | undefined {
    const row = this.getDb()
      .prepare("SELECT workspace_hash, last_full_index, node_count, edge_count, schema_version FROM index_state WHERE workspace_hash = ?")
      .get(this.workspaceHash);

    if (!row) {
      return undefined;
    }

    return {
      workspaceHash: String(row.workspace_hash),
      lastFullIndex: typeof row.last_full_index === "number" ? row.last_full_index : null,
      nodeCount: Number(row.node_count ?? 0),
      edgeCount: Number(row.edge_count ?? 0),
      schemaVersion: Number(row.schema_version ?? GRAPH_SCHEMA_VERSION)
    };
  }

  public clear(): void {
    const db = this.getDb();
    db.exec("DELETE FROM edges;");
    this.clearEmbeddings();
    db.exec("DELETE FROM nodes;");
    db.prepare("DELETE FROM index_state WHERE workspace_hash = ?").run(this.workspaceHash);
  }

  public replaceFileGraph(relativePath: string, nodes: GraphNode[], edges: GraphEdge[]): void {
    const db = this.getDb();
    const apply = db.transaction(() => {
      this.deleteEmbeddingsForRelativePaths([relativePath]);
      db.prepare("DELETE FROM nodes WHERE relative_path = ?").run(relativePath);
      this.insertNodes(nodes);
      this.deleteDanglingEdges();
      this.insertEdges(edges);
    });
    apply();
  }

  public replaceFiles(relativePaths: string[], nodes: GraphNode[], edges: GraphEdge[]): void {
    const db = this.getDb();
    const apply = db.transaction(() => {
      this.deleteEmbeddingsForRelativePaths(relativePaths);
      for (const relativePath of relativePaths) {
        db.prepare("DELETE FROM nodes WHERE relative_path = ?").run(relativePath);
      }
      this.insertNodes(nodes);
      this.deleteDanglingEdges();
      this.insertEdges(edges);
    });
    apply();
  }

  public upsertNodes(nodes: GraphNode[]): void {
    this.insertNodes(nodes);
  }

  public upsertEdges(edges: GraphEdge[]): void {
    this.insertEdges(edges);
  }

  public upsertCodeChunks(chunks: GraphCodeChunk[]): void {
    this.insertCodeChunks(chunks);
  }

  public upsertCommentChunks(chunks: GraphCommentChunk[]): void {
    this.insertCommentChunks(chunks);
  }

  public getCodeChunksForFile(fileNodeId: string): GraphCodeChunk[] {
    return this.getDb()
      .prepare("SELECT * FROM code_chunks WHERE file_node_id = ? ORDER BY start_line ASC")
      .all(fileNodeId)
      .map((row: any) => ({
        id: String(row.id),
        fileNodeId: String(row.file_node_id),
        startLine: Number(row.start_line),
        endLine: Number(row.end_line),
        content: String(row.content),
        piiDetected: Boolean(row.pii_detected),
        piiRedactedContent: row.pii_redacted_content ? String(row.pii_redacted_content) : undefined
      }));
  }

  public getCommentChunksForFile(fileNodeId: string): GraphCommentChunk[] {
    return this.getDb()
      .prepare("SELECT * FROM comment_chunks WHERE file_node_id = ? ORDER BY start_line ASC")
      .all(fileNodeId)
      .map((row: any) => ({
        id: String(row.id),
        fileNodeId: String(row.file_node_id),
        startLine: Number(row.start_line),
        endLine: Number(row.end_line),
        content: String(row.content),
        piiDetected: Boolean(row.pii_detected),
        piiTags: row.pii_tags ? String(row.pii_tags) : undefined
      }));
  }

  public getNodeById(nodeId: string): GraphNode | undefined {
    const row = this.getDb().prepare("SELECT * FROM nodes WHERE id = ?").get(nodeId);
    return row ? mapNode(row) : undefined;
  }

  public getNodeByRelativePath(relativePath: string, type: NodeType = "file"): GraphNode | undefined {
    const row = this.getDb()
      .prepare("SELECT * FROM nodes WHERE relative_path = ? AND type = ? ORDER BY start_line ASC LIMIT 1")
      .get(relativePath, type);
    return row ? mapNode(row) : undefined;
  }

  public getNodesByRelativePath(relativePath: string): GraphNode[] {
    return this.getDb()
      .prepare("SELECT * FROM nodes WHERE relative_path = ? ORDER BY start_line ASC")
      .all(relativePath)
      .map(mapNode);
  }

  public getAllNodes(nodeMode: "file" | "function" = "file"): GraphNode[] {
    const query = nodeMode === "file"
      ? "SELECT * FROM nodes WHERE type = 'file' ORDER BY relative_path ASC"
      : "SELECT * FROM nodes ORDER BY relative_path ASC, start_line ASC";
    return this.getDb().prepare(query).all().map(mapNode);
  }

  public getAllEdges(): GraphEdge[] {
    return this.getDb().prepare("SELECT * FROM edges").all().map(mapEdge);
  }

  public getGraphSnapshot(nodeMode: "file" | "function" = "file", maxNodes?: number): { nodes: GraphNode[]; edges: GraphEdge[] } {
    const nodes = this.getAllNodes(nodeMode);
    const limitedNodes = typeof maxNodes === "number" ? nodes.slice(0, maxNodes) : nodes;
    const nodeIds = new Set(limitedNodes.map((node) => node.id));
    const edges = this.getAllEdges().filter((edge) => nodeIds.has(edge.sourceId) && nodeIds.has(edge.targetId));
    return { nodes: limitedNodes, edges };
  }

  public getNeighbors(nodeIds: string[], direction: "both" | "incoming" | "outgoing" = "both"): { nodes: GraphNode[]; edges: GraphEdge[] } {
    if (nodeIds.length === 0) {
      return { nodes: [], edges: [] };
    }

    const placeholders = nodeIds.map(() => "?").join(", ");
    const edgeWhere = direction === "incoming"
      ? `target_id IN (${placeholders})`
      : direction === "outgoing"
        ? `source_id IN (${placeholders})`
        : `(source_id IN (${placeholders}) OR target_id IN (${placeholders}))`;
    const edgeParams = direction === "both" ? [...nodeIds, ...nodeIds] : nodeIds;

    const edges = this.getDb()
      .prepare(`SELECT * FROM edges WHERE ${edgeWhere}`)
      .all(...edgeParams)
      .map(mapEdge);

    const neighborIds = new Set<string>();
    for (const edge of edges) {
      neighborIds.add(edge.sourceId);
      neighborIds.add(edge.targetId);
    }

    if (neighborIds.size === 0) {
      return { nodes: [], edges };
    }

    const nodePlaceholders = Array.from(neighborIds).map(() => "?").join(", ");
    const nodes = this.getDb()
      .prepare(`SELECT * FROM nodes WHERE id IN (${nodePlaceholders})`)
      .all(...Array.from(neighborIds))
      .map(mapNode);

    return { nodes, edges };
  }

  public getIndexedFiles(): IndexedFileRecord[] {
    return this.getDb()
      .prepare("SELECT relative_path, hash, MAX(last_indexed) as last_indexed FROM nodes WHERE type = 'file' GROUP BY relative_path, hash ORDER BY relative_path ASC")
      .all()
      .map((row) => ({
        relativePath: String(row.relative_path),
        hash: String(row.hash),
        lastIndexed: Number(row.last_indexed ?? 0)
      }));
  }

  public getStats(): GraphStats {
    const nodeCount = Number(this.getDb().prepare("SELECT COUNT(*) as count FROM nodes").get()?.count ?? 0);
    const edgeCount = Number(this.getDb().prepare("SELECT COUNT(*) as count FROM edges").get()?.count ?? 0);
    const fileCount = Number(this.getDb().prepare("SELECT COUNT(*) as count FROM nodes WHERE type = 'file'").get()?.count ?? 0);
    const lastIndexedRow = this.getDb().prepare("SELECT MAX(last_indexed) as last_indexed FROM nodes").get();
    const languageRows = this.getDb()
      .prepare("SELECT language, COUNT(*) as count FROM nodes WHERE language IS NOT NULL AND language != '' GROUP BY language")
      .all();

    const languages: Record<string, number> = {};
    for (const row of languageRows) {
      if (typeof row.language === "string") {
        languages[row.language] = Number(row.count ?? 0);
      }
    }

    return {
      nodeCount,
      edgeCount,
      fileCount,
      databaseSizeBytes: fs.existsSync(this.databasePath) ? fs.statSync(this.databasePath).size : 0,
      lastIndexed: typeof lastIndexedRow?.last_indexed === "number" ? lastIndexedRow.last_indexed : null,
      languages
    };
  }

  public upsertEmbedding(nodeId: string, embedding: number[]): void {
    if (embedding.length === 0) {
      return;
    }

    const normalizedEmbedding = this.normalizeEmbedding(embedding);

    if (this.vectorExtensionLoaded) {
      this.getDb()
        .prepare("INSERT OR REPLACE INTO node_embeddings (node_id, embedding) VALUES (?, ?)")
        .run(nodeId, normalizedEmbedding);
      return;
    }

    this.getDb()
      .prepare(
        `INSERT INTO node_embeddings_fallback (node_id, embedding_json)
         VALUES (?, ?)
         ON CONFLICT(node_id) DO UPDATE SET embedding_json = excluded.embedding_json`
      )
      .run(nodeId, JSON.stringify(Array.from(normalizedEmbedding)));
  }

  public upsertEmbeddings(entries: Array<{ nodeId: string; embedding: number[] }>): void {
    const db = this.getDb();
    const apply = db.transaction(() => {
      for (const entry of entries) {
        this.upsertEmbedding(entry.nodeId, entry.embedding);
      }
    });
    apply();
  }

  public queryNearestEmbeddings(queryEmbedding: number[], limit: number): SimilarNodeMatch[] {
    if (queryEmbedding.length === 0) {
      return [];
    }

    const normalizedQuery = this.normalizeEmbedding(queryEmbedding);

    if (this.vectorExtensionLoaded) {
      try {
        return this.getDb()
          .prepare(
            `SELECT node_id, distance
             FROM node_embeddings
             WHERE embedding MATCH ? AND k = ?`
          )
          .all(normalizedQuery, Math.max(1, limit))
          .map((row) => ({
            nodeId: String(row.node_id),
            distance: Number(row.distance ?? Number.POSITIVE_INFINITY)
          }));
      } catch (error) {
        this.outputChannel?.appendLine(`[graph-db] sqlite-vec KNN query failed, falling back to brute force: ${(error as Error).message}`);
      }
    }

    let rows: Array<Record<string, unknown>> = [];
    try {
      rows = this.getDb().prepare("SELECT node_id, embedding_json FROM node_embeddings_fallback").all();
    } catch {
      return [];
    }

    const matches = rows
      .map((row) => {
        let embedding: number[] = [];
        try {
          embedding = JSON.parse(String(row.embedding_json)) as number[];
        } catch {
          embedding = [];
        }

        return {
          nodeId: String(row.node_id),
          distance: this.calculateL2Distance(Array.from(normalizedQuery), embedding)
        };
      })
      .filter((entry) => Number.isFinite(entry.distance))
      .sort((left, right) => left.distance - right.distance);

    return matches.slice(0, Math.max(1, limit));
  }

  public updateIndexState(nodeCount: number, edgeCount: number, timestamp = Date.now()): void {
    this.setIndexState(nodeCount, edgeCount, timestamp);
  }

  public clearAll(): void {
    this.clear();
  }

  public hasEmbedding(nodeId: string): boolean {
    const tableName = this.vectorExtensionLoaded ? "node_embeddings" : "node_embeddings_fallback";
    try {
      const row = this.getDb().prepare(`SELECT 1 as present FROM ${tableName} WHERE node_id = ? LIMIT 1`).get(nodeId);
      return Boolean(row?.present);
    } catch {
      return false;
    }
  }

  private tryLoadVectorExtension(db: BetterSqliteDatabase): void {
    if (this.sqliteVecExtensionPath && typeof db.loadExtension === "function") {
      try {
        db.loadExtension(this.sqliteVecExtensionPath);
        this.vectorExtensionLoaded = true;
        this.outputChannel?.appendLine(`[graph-db] Loaded sqlite-vec extension from ${this.sqliteVecExtensionPath}`);
        return;
      } catch (error) {
        this.outputChannel?.appendLine(`[graph-db] Unable to load sqlite-vec extension from path: ${(error as Error).message}`);
      }
    }

    const sqliteVec = tryRequireSqliteVec();
    if (!sqliteVec) {
      this.outputChannel?.appendLine("[graph-db] sqlite-vec module is unavailable; semantic KNN will use fallback mode.");
      return;
    }

    try {
      sqliteVec.load(db);
      this.vectorExtensionLoaded = true;
      this.outputChannel?.appendLine("[graph-db] Loaded sqlite-vec module.");
    } catch (error) {
      this.outputChannel?.appendLine(`[graph-db] Unable to initialize sqlite-vec: ${(error as Error).message}`);
    }
  }

  private calculateL2Distance(left: number[], right: number[]): number {
    if (left.length === 0 || right.length === 0 || left.length !== right.length) {
      return Number.POSITIVE_INFINITY;
    }

    let sum = 0;
    for (let index = 0; index < left.length; index += 1) {
      const delta = left[index] - right[index];
      sum += delta * delta;
    }

    return Math.sqrt(sum);
  }

  private normalizeEmbedding(embedding: number[]): Float32Array {
    const normalized = new Float32Array(EMBEDDING_DIMENSION);
    const limit = Math.min(EMBEDDING_DIMENSION, embedding.length);

    for (let index = 0; index < limit; index += 1) {
      normalized[index] = Number(embedding[index] ?? 0);
    }

    return normalized;
  }

  private clearEmbeddings(): void {
    try {
      this.getDb().exec("DELETE FROM node_embeddings;");
    } catch {
      // Ignore if vec0 table is not present.
    }

    try {
      this.getDb().exec("DELETE FROM node_embeddings_fallback;");
    } catch {
      // Ignore if the fallback table is not present.
    }
  }

  private deleteEmbeddingsForRelativePaths(relativePaths: string[]): void {
    if (relativePaths.length === 0) {
      return;
    }

    const placeholders = relativePaths.map(() => "?").join(", ");
    const rows = this.getDb()
      .prepare(`SELECT id FROM nodes WHERE relative_path IN (${placeholders})`)
      .all(...relativePaths);

    const nodeIds = rows.map((row) => String(row.id));
    if (nodeIds.length === 0) {
      return;
    }

    const nodePlaceholders = nodeIds.map(() => "?").join(", ");

    try {
      this.getDb().prepare(`DELETE FROM node_embeddings WHERE node_id IN (${nodePlaceholders})`).run(...nodeIds);
    } catch {
      // Ignore if vec0 table is not present.
    }

    try {
      this.getDb().prepare(`DELETE FROM node_embeddings_fallback WHERE node_id IN (${nodePlaceholders})`).run(...nodeIds);
    } catch {
      // Ignore if the fallback table is not present.
    }
  }

  private deleteDanglingEdges(): void {
    this.getDb().exec(
      `DELETE FROM edges
       WHERE source_id NOT IN (SELECT id FROM nodes)
          OR target_id NOT IN (SELECT id FROM nodes)`
    );
  }

  private insertNodes(nodes: GraphNode[]): void {
    if (nodes.length === 0) {
      return;
    }

    const statement = this.getDb().prepare(
      `INSERT INTO nodes (
        id, type, label, file_path, relative_path, start_line, end_line, language, last_indexed, hash, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        type = excluded.type,
        label = excluded.label,
        file_path = excluded.file_path,
        relative_path = excluded.relative_path,
        start_line = excluded.start_line,
        end_line = excluded.end_line,
        language = excluded.language,
        last_indexed = excluded.last_indexed,
        hash = excluded.hash,
        metadata = excluded.metadata`
    );

    const apply = this.getDb().transaction(() => {
      for (const node of nodes) {
        statement.run(
          node.id,
          node.type,
          node.label,
          node.filePath,
          node.relativePath,
          node.startLine ?? null,
          node.endLine ?? null,
          node.language ?? null,
          node.lastIndexed,
          node.hash,
          serializeMetadata(node.metadata)
        );
      }
    });

    apply();
  }

  private insertEdges(edges: GraphEdge[]): void {
    if (edges.length === 0) {
      return;
    }

    const statement = this.getDb().prepare(
      `INSERT INTO edges (id, source_id, target_id, type, weight, metadata)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         source_id = excluded.source_id,
         target_id = excluded.target_id,
         type = excluded.type,
         weight = excluded.weight,
         metadata = excluded.metadata`
    );

    const apply = this.getDb().transaction(() => {
      for (const edge of edges) {
        statement.run(
          edge.id,
          edge.sourceId,
          edge.targetId,
          edge.type,
          edge.weight,
          serializeMetadata(edge.metadata)
        );
      }
    });

    apply();
  }

  private insertCodeChunks(chunks: GraphCodeChunk[]): void {
    if (chunks.length === 0) {
      return;
    }

    const statement = this.getDb().prepare(
      `INSERT INTO code_chunks (id, file_node_id, start_line, end_line, content, pii_detected, pii_redacted_content)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         file_node_id = excluded.file_node_id,
         start_line = excluded.start_line,
         end_line = excluded.end_line,
         content = excluded.content,
         pii_detected = excluded.pii_detected,
         pii_redacted_content = excluded.pii_redacted_content`
    );

    const apply = this.getDb().transaction(() => {
      for (const chunk of chunks) {
        statement.run(
          chunk.id,
          chunk.fileNodeId,
          chunk.startLine,
          chunk.endLine,
          chunk.content,
          chunk.piiDetected ? 1 : 0,
          chunk.piiRedactedContent ?? null
        );
      }
    });

    apply();
  }

  private insertCommentChunks(chunks: GraphCommentChunk[]): void {
    if (chunks.length === 0) {
      return;
    }

    const statement = this.getDb().prepare(
      `INSERT INTO comment_chunks (id, file_node_id, start_line, end_line, content, pii_detected, pii_tags)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         file_node_id = excluded.file_node_id,
         start_line = excluded.start_line,
         end_line = excluded.end_line,
         content = excluded.content,
         pii_detected = excluded.pii_detected,
         pii_tags = excluded.pii_tags`
    );

    const apply = this.getDb().transaction(() => {
      for (const chunk of chunks) {
        statement.run(
          chunk.id,
          chunk.fileNodeId,
          chunk.startLine,
          chunk.endLine,
          chunk.content,
          chunk.piiDetected ? 1 : 0,
          chunk.piiTags ?? null
        );
      }
    });

    apply();
  }

  private getDb(): BetterSqliteDatabase {
    if (!this.db) {
      this.open();
    }

    if (!this.db) {
      throw new Error("Graph database is not available.");
    }

    return this.db;
  }
}
