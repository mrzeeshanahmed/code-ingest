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

async function getSqlite3(): Promise<SQLiteAPI> {
  return initializeSqlite3();
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

export class GraphDatabase {
  public readonly workspaceHash: string;
  public readonly databasePath: string;

  private outputChannel: { appendLine(message: string): void } | undefined;
  private sqlite3!: SQLiteAPI;
  private db!: number;
  private vfs!: VscodeAsyncVfs;
  public readonly writerQueue: SingleWriterQueue;

  private nodes = new Map<string, GraphNode>();
  private edges = new Map<string, GraphEdge>();
  private indexState: IndexStateRecord | undefined;

  constructor(private readonly workspaceRoot: string, options: GraphDatabaseOptions = {}) {
    this.workspaceHash = crypto.createHash("sha256").update(workspaceRoot).digest("hex");
    this.databasePath = options.databasePath ?? path.join(workspaceRoot, ".vscode", "code-ingest", "graph.db");
    this.outputChannel = options.outputChannel;

    const executor: WriteExecutor = (batch) => this.executeWriteBatch(batch);
    this.writerQueue = new SingleWriterQueue(executor, this.outputChannel);
  }

  public async open(): Promise<void> {
    this.sqlite3 = await getSqlite3();
    this.vfs = await createVscodeAsyncVfs();
    this.sqlite3.vfs_register(this.vfs, true);

    fs.mkdirSync(path.dirname(this.databasePath), { recursive: true });

    const VFS = await loadSqliteConstants();
    this.db = await this.sqlite3.open_v2(
      this.databasePath,
      VFS.SQLITE_OPEN_CREATE | VFS.SQLITE_OPEN_READWRITE,
      this.vfs.name
    );

    for (const statement of CORE_DDL) {
      await this.sqlite3.run(this.db, statement);
    }

    await this.loadStructuralCache();
  }

  public async close(): Promise<void> {
    if (this.db) {
      await this.sqlite3.close(this.db);
      this.db = undefined as unknown as number;
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

    this.nodes.clear();
    this.edges.clear();
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
    for (const node of this.nodes.values()) {
      if (node.relativePath === relativePath && node.type === type) {
        return node;
      }
    }
    return undefined;
  }

  public getNodesByRelativePath(relativePath: string): GraphNode[] {
    return Array.from(this.nodes.values())
      .filter((node) => node.relativePath === relativePath)
      .sort((a, b) => (a.startLine ?? 0) - (b.startLine ?? 0));
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

      for (const del of batch.deletes) {
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
    }
    for (const edge of batch.edgeUpserts) {
      this.edges.set(edge.id, edge);
    }
    for (const del of batch.deletes) {
      if (del.ids) {
        for (const id of del.ids) {
          if (del.table === "nodes") this.nodes.delete(id);
          if (del.table === "edges") this.edges.delete(id);
        }
      }
    }
  }

  private async loadStructuralCache(): Promise<void> {
    const nodeResult = await this.sqlite3.execWithParams(this.db, "SELECT * FROM nodes");
    for (const row of nodeResult.rows) {
      const node = mapNode(row);
      this.nodes.set(node.id, node);
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
