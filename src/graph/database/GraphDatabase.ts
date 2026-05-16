import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import { GRAPH_SCHEMA_VERSION } from "../../config/constants";
import { GraphEdge } from "../models/Edge";
import { GraphNode, NodeType } from "../models/Node";
import { GraphCodeChunk, GraphCommentChunk } from "../models/Chunk";
import { CORE_DDL } from "./schema";
import { PendingWriteBatch, SingleWriterQueue, WriteExecutor } from "./SingleWriterQueue";
import { createVscodeAsyncVfs, VscodeAsyncVfs } from "./VscodeAsyncVfs";
import { loadSqliteConstants, loadWaSqliteAsyncModule, loadWaSqliteFactory, SQLiteAPI } from "./waSqliteLoader";

let _sqlitePromise: Promise<SQLiteAPI> | null = null;
async function getSqlite3(): Promise<SQLiteAPI> {
  if (!_sqlitePromise) {
    _sqlitePromise = initializeSqlite3();
  }
  return _sqlitePromise;
}

async function initializeSqlite3(): Promise<SQLiteAPI> {
  const Factory = await loadWaSqliteFactory();
  const SQLiteAsyncESMFactory = await loadWaSqliteAsyncModule();
  const module = await SQLiteAsyncESMFactory();
  const sqlite3 = Factory(module);
  return sqlite3;
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
  gitHead: string | null;
}

export interface GraphDatabaseOptions {
  outputChannel?: { appendLine(message: string): void };
  databasePath?: string;
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

function mapNode(row: Array<unknown>): GraphNode {
  const metadata = parseMetadata(row[10]);
  const node: GraphNode = {
    id: String(row[0]),
    type: String(row[1]) as NodeType,
    label: String(row[2]),
    filePath: String(row[3]),
    relativePath: String(row[4]),
    lastIndexed: Number(row[8]),
    hash: String(row[9])
  };
  if (typeof row[5] === "number") node.startLine = row[5];
  if (typeof row[6] === "number") node.endLine = row[6];
  if (typeof row[7] === "string" && row[7]) node.language = row[7];
  if (metadata) node.metadata = metadata;
  return node;
}

function mapEdge(row: Array<unknown>): GraphEdge {
  const metadata = parseMetadata(row[5]);
  const edge: GraphEdge = {
    id: String(row[0]),
    sourceId: String(row[1]),
    targetId: String(row[2]),
    type: String(row[3]) as GraphEdge["type"],
    weight: Number(row[4] ?? 1)
  };
  if (metadata) edge.metadata = metadata;
  return edge;
}

class LRUCache<K, V> {
  private cache = new Map<K, V>();
  constructor(private capacity: number) {}
  get(key: K): V | undefined {
    if (!this.cache.has(key)) return undefined;
    const value = this.cache.get(key)!;
    this.cache.delete(key);
    this.cache.set(key, value);
    return value;
  }
  set(key: K, value: V): void {
    this.cache.delete(key);
    this.cache.set(key, value);
    if (this.cache.size > this.capacity) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }
  }
  delete(key: K): void {
    this.cache.delete(key);
  }
  clear(): void {
    this.cache.clear();
  }
  values(): IterableIterator<V> {
    return this.cache.values();
  }
  get size(): number {
    return this.cache.size;
  }
  [Symbol.iterator]() {
    return this.cache[Symbol.iterator]();
  }
}

export class GraphDatabase {
  public readonly workspaceHash: string;
  public readonly databasePath: string;

  private outputChannel: { appendLine(message: string): void } | undefined;
  private sqlite3!: SQLiteAPI;
  private db!: number;
  private vfs!: VscodeAsyncVfs;
  public readonly writerQueue: SingleWriterQueue;

  private nodes = new LRUCache<string, GraphNode>(50000);
  private edges = new LRUCache<string, GraphEdge>(100000);
  private nodesByRelativePath = new Map<string, GraphNode[]>();
  private indexState: IndexStateRecord | undefined;

  constructor(private readonly workspaceRoot: string, options: GraphDatabaseOptions = {}) {
    this.workspaceHash = crypto.createHash("sha256").update(workspaceRoot).digest("hex");
    this.databasePath = options.databasePath ?? path.join(workspaceRoot, ".vscode", "code-ingest", "graph.db");
    this.outputChannel = options.outputChannel;

    const executor: WriteExecutor = (batch) => this.executeWriteBatch(batch);
    this.writerQueue = new SingleWriterQueue(executor, this.outputChannel);
  }

  private lockFilePath: string | undefined;

  public async open(): Promise<void> {
    this.sqlite3 = await getSqlite3();
    this.vfs = await createVscodeAsyncVfs();
    this.sqlite3.vfs_register(this.vfs, true);

    fs.mkdirSync(path.dirname(this.databasePath), { recursive: true });

    // Lockfile guard to prevent concurrent access from multiple VS Code windows.
    // If a stale lockfile exists from a crashed/killed process, remove it.
    this.lockFilePath = `${this.databasePath}.lock`;
    try {
      const lockFd = fs.openSync(this.lockFilePath, "wx");
      fs.writeSync(lockFd, String(process.pid));
      fs.closeSync(lockFd);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        // Check if the owning PID is still alive.
        let ownerAlive = false;
        try {
          const ownerPid = parseInt(fs.readFileSync(this.lockFilePath, "utf8").trim(), 10);
          if (!isNaN(ownerPid) && ownerPid !== process.pid) {
            // process.kill(pid, 0) throws if the PID doesn't exist.
            process.kill(ownerPid, 0);
            ownerAlive = true;
          }
        } catch {
          // Either the PID file is unreadable, the PID is invalid, or the process is dead.
          ownerAlive = false;
        }

        if (ownerAlive) {
          throw new Error(`Database is locked by another process. Lockfile: ${this.lockFilePath}`);
        }

        // Stale lockfile — previous process crashed or was killed without cleanup.
        this.outputChannel?.appendLine(`[GraphDatabase] Removing stale lockfile from previous session: ${this.lockFilePath}`);
        fs.unlinkSync(this.lockFilePath);
        const lockFd = fs.openSync(this.lockFilePath, "wx");
        fs.writeSync(lockFd, String(process.pid));
        fs.closeSync(lockFd);
      } else {
        throw error;
      }
    }

    const VFS = await loadSqliteConstants();
    try {
      this.db = await this.sqlite3.open_v2(
        this.databasePath,
        VFS.SQLITE_OPEN_CREATE | VFS.SQLITE_OPEN_READWRITE,
        this.vfs.name
      );

      let currentVersion = 0;
      try {
        const result = await this.sqlite3.execWithParams(this.db, "SELECT schema_version FROM index_state LIMIT 1");
        if (result.rows.length > 0) currentVersion = Number(result.rows[0][0]);
      } catch {
        // Table might not exist yet
      }

      if (currentVersion !== GRAPH_SCHEMA_VERSION) {
        this.outputChannel?.appendLine(`[GraphDatabase] Schema version mismatch or uninitialized (current: ${currentVersion}, target: ${GRAPH_SCHEMA_VERSION}). Initializing schema...`);
        for (const statement of CORE_DDL) {
          await this.sqlite3.run(this.db, statement);
        }
      }

      await this.loadStructuralCache();
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  public async close(): Promise<void> {
    if (this.db) {
      await this.sqlite3.close(this.db);
      this.db = undefined as unknown as number;
    }
    if (this.vfs) {
      await this.vfs.dispose();
    }
    if (this.lockFilePath && fs.existsSync(this.lockFilePath)) {
      try {
        fs.unlinkSync(this.lockFilePath);
      } catch {
        // Best-effort lockfile cleanup.
      }
      this.lockFilePath = undefined;
    }
  }

  public async dispose(): Promise<void> {
    await this.writerQueue.waitForQuiescent();
    await this.close();
  }

  public getLastFullIndex(): number | null {
    return this.indexState?.lastFullIndex ?? null;
  }

  public needsSchemaUpgrade(): boolean {
    return !this.indexState || this.indexState.schemaVersion !== GRAPH_SCHEMA_VERSION;
  }

  public async setIndexState(nodeCount: number, edgeCount: number, timestamp = Date.now()): Promise<void> {
    await this.writerQueue.waitForQuiescent();
    await this.sqlite3.run(this.db, `
      INSERT INTO index_state (workspace_hash, last_full_index, node_count, edge_count, schema_version)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(workspace_hash) DO UPDATE SET
        last_full_index = excluded.last_full_index,
        node_count = excluded.node_count,
        edge_count = excluded.edge_count,
        schema_version = excluded.schema_version
    `, [this.workspaceHash, timestamp, nodeCount, edgeCount, GRAPH_SCHEMA_VERSION]);

    this.indexState = {
      workspaceHash: this.workspaceHash,
      lastFullIndex: timestamp,
      nodeCount,
      edgeCount,
      schemaVersion: GRAPH_SCHEMA_VERSION,
      gitHead: this.indexState?.gitHead ?? null
    };
  }

  public getIndexState(): IndexStateRecord | undefined {
    return this.indexState;
  }

  public async clear(): Promise<void> {
    await this.writerQueue.waitForQuiescent();
    await this.sqlite3.run(this.db, "BEGIN");
    try {
      await this.sqlite3.run(this.db, "DELETE FROM edges;");
      await this.sqlite3.run(this.db, "DELETE FROM code_chunks;");
      await this.sqlite3.run(this.db, "DELETE FROM comment_chunks;");
      await this.sqlite3.run(this.db, "DELETE FROM knowledge_chunks;");
      await this.sqlite3.run(this.db, "DELETE FROM knowledge_links;");
      await this.sqlite3.run(this.db, "DELETE FROM terms;");
      await this.sqlite3.run(this.db, "DELETE FROM term_links;");
      await this.sqlite3.run(this.db, "DELETE FROM module_summaries;");
      await this.sqlite3.run(this.db, "DELETE FROM directory_state;");
      await this.sqlite3.run(this.db, "DELETE FROM embedding_document_metadata;");
      await this.sqlite3.run(this.db, "DELETE FROM artifact_state;");
      await this.sqlite3.run(this.db, "DELETE FROM nodes;");
      await this.sqlite3.run(this.db, "DELETE FROM index_state WHERE workspace_hash = ?", [this.workspaceHash]);
      await this.sqlite3.run(this.db, "COMMIT");
    } catch (error) {
      await this.sqlite3.run(this.db, "ROLLBACK");
      throw error;
    }

    this.nodes.clear();
    this.edges.clear();
    this.nodesByRelativePath.clear();
    this.indexState = undefined;
  }

  public async getCodeChunksForFile(fileNodeId: string): Promise<GraphCodeChunk[]> {
    const result = await this.sqlite3.execWithParams(this.db, `
      SELECT id, file_node_id, start_line, end_line, content, lineage, pii_detected, pii_redacted_content
      FROM code_chunks WHERE file_node_id = ? ORDER BY start_line ASC
    `, [fileNodeId]);

    return result.rows.map((row: unknown[]) => ({
      id: String(row[0]),
      fileNodeId: String(row[1]),
      startLine: Number(row[2]),
      endLine: Number(row[3]),
      content: String(row[4]),
      lineage: row[5] ? String(row[5]) : undefined,
      piiDetected: Boolean(row[6]),
      piiRedactedContent: row[7] ? String(row[7]) : undefined
    }));
  }

  public async getCommentChunksForFile(fileNodeId: string): Promise<GraphCommentChunk[]> {
    const result = await this.sqlite3.execWithParams(this.db, `
      SELECT id, file_node_id, start_line, end_line, content, lineage, pii_detected, pii_tags
      FROM comment_chunks WHERE file_node_id = ? ORDER BY start_line ASC
    `, [fileNodeId]);

    return result.rows.map((row: unknown[]) => ({
      id: String(row[0]),
      fileNodeId: String(row[1]),
      startLine: Number(row[2]),
      endLine: Number(row[3]),
      content: String(row[4]),
      lineage: row[5] ? String(row[5]) : undefined,
      piiDetected: Boolean(row[6]),
      piiTags: row[7] ? String(row[7]) : undefined
    }));
  }

  public getNodeById(nodeId: string): GraphNode | undefined {
    return this.nodes.get(nodeId);
  }

  public getNodeByRelativePath(relativePath: string, type: NodeType = "file"): GraphNode | undefined {
    const list = this.nodesByRelativePath.get(relativePath);
    if (list) {
      for (const node of list) {
        if (node.type === type) return node;
      }
    }
    return undefined;
  }

  public getNodesByRelativePath(relativePath: string): GraphNode[] {
    const list = this.nodesByRelativePath.get(relativePath) || [];
    return [...list].sort((a, b) => (a.startLine ?? 0) - (b.startLine ?? 0));
  }

  public getAllNodes(nodeMode: "file" | "function" = "file"): GraphNode[] {
    const all = Array.from(this.nodes.values());
    if (nodeMode === "file") {
      return all.filter((n) => n.type === "file").sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    }
    return all.sort((a, b) => {
      const pathCmp = a.relativePath.localeCompare(b.relativePath);
      return pathCmp !== 0 ? pathCmp : (a.startLine ?? 0) - (b.startLine ?? 0);
    });
  }

  public getAllEdges(): GraphEdge[] {
    return Array.from(this.edges.values());
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

    const filteredEdges = this.getAllEdges().filter((edge) => {
      if (direction === "incoming") return nodeIds.includes(edge.targetId);
      if (direction === "outgoing") return nodeIds.includes(edge.sourceId);
      return nodeIds.includes(edge.sourceId) || nodeIds.includes(edge.targetId);
    });

    const neighborIds = new Set<string>();
    for (const edge of filteredEdges) {
      neighborIds.add(edge.sourceId);
      neighborIds.add(edge.targetId);
    }

    const nodes = Array.from(neighborIds).map((id) => this.nodes.get(id)).filter((n): n is GraphNode => !!n);
    return { nodes, edges: filteredEdges };
  }

  public getIndexedFiles(): IndexedFileRecord[] {
    const files = new Map<string, IndexedFileRecord>();
    for (const node of this.nodes.values()) {
      if (node.type === "file") {
        const existing = files.get(node.relativePath);
        if (!existing || node.lastIndexed > existing.lastIndexed) {
          files.set(node.relativePath, {
            relativePath: node.relativePath,
            hash: node.hash,
            lastIndexed: node.lastIndexed
          });
        }
      }
    }
    return Array.from(files.values()).sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  }

  public getStats(): GraphStats {
    const allNodes = this.getAllNodes("function");
    const nodeCount = allNodes.length;
    const edgeCount = this.edges.size;
    const fileCount = allNodes.filter((n) => n.type === "file").length;
    const languages: Record<string, number> = {};
    for (const node of allNodes) {
      if (node.language) {
        languages[node.language] = (languages[node.language] ?? 0) + 1;
      }
    }
    let lastIndexed: number | null = null;
    for (const node of allNodes) {
      if (lastIndexed === null || node.lastIndexed > lastIndexed) {
        lastIndexed = node.lastIndexed;
      }
    }

    return {
      nodeCount,
      edgeCount,
      fileCount,
      databaseSizeBytes: fs.existsSync(this.databasePath) ? fs.statSync(this.databasePath).size : 0,
      lastIndexed,
      languages
    };
  }

  public async executeWriteBatch(batch: PendingWriteBatch): Promise<void> {
    // Stale dirty-buffer snapshot check
    const staleRelativePaths = new Set<string>();
    for (const snapshot of batch.dirtyBufferSnapshots ?? []) {
      const absolutePath = path.join(this.workspaceRoot, snapshot.relativePath);
      try {
        const stats = await fsPromises.stat(absolutePath);
        if (stats.mtimeMs > snapshot.diskMtimeMsAtResolve) {
          staleRelativePaths.add(snapshot.relativePath);
        }
      } catch {
        // File missing on disk; treat as stale
        staleRelativePaths.add(snapshot.relativePath);
      }
    }

    if (staleRelativePaths.size > 0) {
      this.outputChannel?.appendLine(`[GraphDatabase] Discarding stale dirty-buffer snapshots for: ${Array.from(staleRelativePaths).join(", ")}`);
      batch.nodeUpserts = batch.nodeUpserts.filter((n) => !staleRelativePaths.has(n.relativePath));
      batch.edgeUpserts = batch.edgeUpserts.filter((e) => {
        const source = this.nodes.get(e.sourceId);
        const target = this.nodes.get(e.targetId);
        return !staleRelativePaths.has(source?.relativePath ?? "") && !staleRelativePaths.has(target?.relativePath ?? "");
      });
      batch.codeChunkUpserts = batch.codeChunkUpserts.filter((c) => {
        const fileNode = this.nodes.get(c.fileNodeId);
        return !staleRelativePaths.has(fileNode?.relativePath ?? "");
      });
      batch.commentChunkUpserts = batch.commentChunkUpserts.filter((c) => {
        const fileNode = this.nodes.get(c.fileNodeId);
        return !staleRelativePaths.has(fileNode?.relativePath ?? "");
      });
      for (const rp of staleRelativePaths) {
        batch.deletes.push({ table: "nodes", filePath: rp });
      }
    }

    await this.sqlite3.run(this.db, "BEGIN");
    try {
      for (const node of batch.nodeUpserts) {
        await this.sqlite3.run(this.db, `
          INSERT INTO nodes (id, type, label, file_path, relative_path, start_line, end_line, language, last_indexed, hash, metadata)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
            metadata = excluded.metadata
        `, [
          node.id, node.type, node.label, node.filePath, node.relativePath,
          node.startLine ?? null, node.endLine ?? null, node.language ?? null,
          node.lastIndexed, node.hash, serializeMetadata(node.metadata)
        ]);
      }

      for (const edge of batch.edgeUpserts) {
        await this.sqlite3.run(this.db, `
          INSERT INTO edges (id, source_id, target_id, type, weight, metadata)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            source_id = excluded.source_id,
            target_id = excluded.target_id,
            type = excluded.type,
            weight = excluded.weight,
            metadata = excluded.metadata
        `, [edge.id, edge.sourceId, edge.targetId, edge.type, edge.weight, serializeMetadata(edge.metadata)]);
      }

      for (const chunk of batch.codeChunkUpserts) {
        await this.sqlite3.run(this.db, `
          INSERT INTO code_chunks (id, file_node_id, start_line, end_line, content, lineage, pii_detected, pii_redacted_content)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            file_node_id = excluded.file_node_id,
            start_line = excluded.start_line,
            end_line = excluded.end_line,
            content = excluded.content,
            lineage = excluded.lineage,
            pii_detected = excluded.pii_detected,
            pii_redacted_content = excluded.pii_redacted_content
        `, [
          chunk.id, chunk.fileNodeId, chunk.startLine, chunk.endLine,
          chunk.content, chunk.lineage ?? null, chunk.piiDetected ? 1 : 0,
          chunk.piiRedactedContent ?? null
        ]);
      }

      for (const chunk of batch.commentChunkUpserts) {
        await this.sqlite3.run(this.db, `
          INSERT INTO comment_chunks (id, file_node_id, start_line, end_line, content, lineage, pii_detected, pii_tags)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            file_node_id = excluded.file_node_id,
            start_line = excluded.start_line,
            end_line = excluded.end_line,
            content = excluded.content,
            lineage = excluded.lineage,
            pii_detected = excluded.pii_detected,
            pii_tags = excluded.pii_tags
        `, [
          chunk.id, chunk.fileNodeId, chunk.startLine, chunk.endLine,
          chunk.content, chunk.lineage ?? null, chunk.piiDetected ? 1 : 0,
          chunk.piiTags ?? null
        ]);
      }

      for (const chunk of batch.knowledgeChunkUpserts) {
        await this.sqlite3.run(this.db, `
          INSERT INTO knowledge_chunks (id, node_id, summary, invariants, pii_detected, pii_redacted_summary, created_at, stale)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            node_id = excluded.node_id,
            summary = excluded.summary,
            invariants = excluded.invariants,
            pii_detected = excluded.pii_detected,
            pii_redacted_summary = excluded.pii_redacted_summary,
            created_at = excluded.created_at,
            stale = excluded.stale
        `, [
          chunk.id, chunk.nodeId, chunk.summary, chunk.invariants,
          chunk.piiDetected ? 1 : 0, chunk.piiRedactedSummary ?? null,
          chunk.createdAt, chunk.stale ? 1 : 0
        ]);
      }

      for (const term of batch.termUpserts ?? []) {
        await this.sqlite3.run(this.db, `
          INSERT INTO terms (id, term, frequency) VALUES (?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET frequency = excluded.frequency
        `, [term.id, term.term, term.frequency]);
      }

      for (const link of batch.termLinkUpserts ?? []) {
        await this.sqlite3.run(this.db, `
          INSERT INTO term_links (term_id, node_id) VALUES (?, ?)
          ON CONFLICT(term_id, node_id) DO NOTHING
        `, [link.term_id, link.node_id]);
      }

      for (const ds of batch.directoryStateUpserts ?? []) {
        await this.sqlite3.run(this.db, `
          INSERT INTO directory_state (relative_path, parent_relative_path, merkle_hash, child_count, updated_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(relative_path) DO UPDATE SET
            parent_relative_path = excluded.parent_relative_path,
            merkle_hash = excluded.merkle_hash,
            child_count = excluded.child_count,
            updated_at = excluded.updated_at
        `, [ds.relative_path, ds.parent_relative_path ?? null, ds.merkle_hash, ds.child_count, ds.updated_at]);
      }

      for (const em of batch.embeddingMetadataUpserts ?? []) {
        await this.sqlite3.run(this.db, `
          INSERT INTO embedding_document_metadata (id, kind, source_table, source_id, content_hash, artifact_key, last_embedded)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            content_hash = excluded.content_hash,
            artifact_key = excluded.artifact_key,
            last_embedded = excluded.last_embedded
        `, [em.id, em.kind, em.source_table, em.source_id, em.content_hash, em.artifact_key, em.last_embedded]);
      }

      for (const art of batch.artifactStateUpserts ?? []) {
        await this.sqlite3.run(this.db, `
          INSERT INTO artifact_state (artifact_key, kind, backend, artifact_path, doc_count, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(artifact_key) DO UPDATE SET
            doc_count = excluded.doc_count,
            updated_at = excluded.updated_at
        `, [art.artifact_key, art.kind, art.backend, art.artifact_path, art.doc_count, art.updated_at]);
      }

      for (const ms of batch.moduleSummaryUpserts ?? []) {
        await this.sqlite3.run(this.db, `
          INSERT INTO module_summaries (id, module_path, summary, file_count, source_merkle_root, created_at, stale)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            summary = excluded.summary,
            file_count = excluded.file_count,
            source_merkle_root = excluded.source_merkle_root,
            stale = excluded.stale
        `, [ms.id, ms.module_path, ms.summary, ms.file_count, ms.source_merkle_root, ms.created_at, ms.stale ? 1 : 0]);
      }

      const VALID_DELETE_TABLES = new Set([
        "nodes", "edges", "code_chunks", "comment_chunks", "knowledge_chunks",
        "knowledge_links", "terms", "term_links", "module_summaries",
        "directory_state", "embedding_document_metadata", "artifact_state"
      ]);
      for (const del of batch.deletes) {
        if (!VALID_DELETE_TABLES.has(del.table)) {
          this.outputChannel?.appendLine(`[GraphDatabase] Rejected delete from unknown table: ${del.table}`);
          continue;
        }
        if (del.ids && del.ids.length > 0) {
          const placeholders = del.ids.map(() => "?").join(", ");
          await this.sqlite3.run(this.db, `DELETE FROM ${del.table} WHERE id IN (${placeholders})`, del.ids);
        } else if (del.filePath) {
          if (del.table === "nodes") {
            await this.sqlite3.run(this.db, `DELETE FROM ${del.table} WHERE relative_path = ?`, [del.filePath]);
          }
        }
      }

      await this.sqlite3.run(this.db, "COMMIT");
    } catch (error) {
      await this.sqlite3.run(this.db, "ROLLBACK");
      throw error;
    }

    // Update in-memory cache after successful commit.
    for (const node of batch.nodeUpserts) {
      this.nodes.set(node.id, node);
      let list = this.nodesByRelativePath.get(node.relativePath);
      if (!list) {
        list = [];
        this.nodesByRelativePath.set(node.relativePath, list);
      }
      const existingIdx = list.findIndex(n => n.id === node.id);
      if (existingIdx !== -1) {
        list[existingIdx] = node;
      } else {
        list.push(node);
      }
    }
    for (const edge of batch.edgeUpserts) {
      this.edges.set(edge.id, edge);
    }
    for (const del of batch.deletes) {
      if (del.ids) {
        for (const id of del.ids) {
          if (del.table === "nodes") {
            const node = this.nodes.get(id);
            if (node) {
              const list = this.nodesByRelativePath.get(node.relativePath);
              if (list) {
                const idx = list.findIndex(n => n.id === id);
                if (idx !== -1) list.splice(idx, 1);
              }
            }
            this.nodes.delete(id);
          }
          if (del.table === "edges") this.edges.delete(id);
        }
      }
      if (del.filePath && del.table === "nodes") {
        this.nodesByRelativePath.delete(del.filePath);
        const idsToDelete: string[] = [];
        for (const [id, node] of this.nodes) {
          if (node.relativePath === del.filePath) {
            idsToDelete.push(id);
          }
        }
        for (const id of idsToDelete) {
          this.nodes.delete(id);
          for (const [edgeId, edge] of this.edges) {
            if (edge.sourceId === id || edge.targetId === id) {
              this.edges.delete(edgeId);
            }
          }
        }
      }
    }
  }

  private async loadStructuralCache(): Promise<void> {
    const nodeResult = await this.sqlite3.execWithParams(this.db, "SELECT * FROM nodes");
    for (const row of nodeResult.rows) {
      const node = mapNode(row);
      this.nodes.set(node.id, node);
      let list = this.nodesByRelativePath.get(node.relativePath);
      if (!list) {
        list = [];
        this.nodesByRelativePath.set(node.relativePath, list);
      }
      list.push(node);
    }

    const edgeResult = await this.sqlite3.execWithParams(this.db, "SELECT * FROM edges");
    for (const row of edgeResult.rows) {
      const edge = mapEdge(row);
      this.edges.set(edge.id, edge);
    }

    const indexResult = await this.sqlite3.execWithParams(this.db, "SELECT * FROM index_state WHERE workspace_hash = ?", [this.workspaceHash]);
    if (indexResult.rows.length > 0) {
      const row = indexResult.rows[0];
      this.indexState = {
        workspaceHash: String(row[0]),
        lastFullIndex: typeof row[1] === "number" ? row[1] : null,
        nodeCount: Number(row[2] ?? 0),
        edgeCount: Number(row[3] ?? 0),
        schemaVersion: Number(row[4] ?? GRAPH_SCHEMA_VERSION),
        gitHead: row[5] ? String(row[5]) : null
      };
    }
  }
}
