import * as path from "node:path";
import { GRAPH_SCHEMA_VERSION } from "../../config/constants";
import { GraphDatabase } from "../../graph/database/GraphDatabase";
import { createEdge, createNode, createTempWorkspace, removeTempWorkspace } from "./testUtils";

describe("GraphDatabase", () => {
  let workspaceRoot: string;
  let database: GraphDatabase;

  beforeEach(async () => {
    workspaceRoot = await createTempWorkspace(".tmp-graph-db");
    database = new GraphDatabase(workspaceRoot, {
      databasePath: path.join(workspaceRoot, ".vscode", "code-ingest", "graph.db")
    });
    try {
      await database.open();
    } catch (error: any) {
      console.error("GraphDatabase.open() failed:", error.message, "code:", error.code);
      throw error;
    }
  });

  afterEach(async () => {
    await database.dispose();
    await removeTempWorkspace(workspaceRoot);
  });

  test("creates schema, tracks index state, and reports stats", async () => {
    expect(database.needsSchemaUpgrade()).toBe(true);

    const fileNode = createNode(workspaceRoot, "src/index.ts", "index.ts", "file", { language: "typescript" });
    const helperNode = createNode(workspaceRoot, "src/helper.ts", "helper.ts", "file", { language: "typescript" });
    const importEdge = createEdge(fileNode.id, helperNode.id, "import");

    await database.writerQueue.enqueue({
      reason: "test",
      priority: "HIGH",
      filePaths: [fileNode.relativePath, helperNode.relativePath],
      nodeUpserts: [fileNode, helperNode],
      edgeUpserts: [importEdge],
      codeChunkUpserts: [],
      commentChunkUpserts: [],
      deletes: []
    });

    await database.setIndexState(2, 1, 12345);

    expect(database.needsSchemaUpgrade()).toBe(false);
    expect(database.getIndexState()).toEqual({
      workspaceHash: database.workspaceHash,
      lastFullIndex: 12345,
      nodeCount: 2,
      edgeCount: 1,
      schemaVersion: GRAPH_SCHEMA_VERSION,
      gitHead: null
    });

    const stats = database.getStats();
    expect(stats.nodeCount).toBe(2);
    expect(stats.edgeCount).toBe(1);
    expect(stats.languages.typescript).toBe(2);
    expect(stats.databaseSizeBytes).toBeGreaterThan(0);
  });

  test("returns bidirectional neighbors", async () => {
    const fileNode = createNode(workspaceRoot, "src/index.ts", "index.ts", "file");
    const helperNode = createNode(workspaceRoot, "src/helper.ts", "helper.ts", "file");
    const importEdge = createEdge(fileNode.id, helperNode.id, "import");

    await database.writerQueue.enqueue({
      reason: "test",
      priority: "HIGH",
      filePaths: [fileNode.relativePath, helperNode.relativePath],
      nodeUpserts: [fileNode, helperNode],
      edgeUpserts: [importEdge],
      codeChunkUpserts: [],
      commentChunkUpserts: [],
      deletes: []
    });

    const neighbors = database.getNeighbors([fileNode.id], "both");
    expect(neighbors.nodes.map((node) => node.id).sort()).toEqual([fileNode.id, helperNode.id].sort());
    expect(neighbors.edges).toHaveLength(1);
  });

  test("clears persisted graph state", async () => {
    const fileNode = createNode(workspaceRoot, "src/index.ts", "index.ts", "file");
    await database.writerQueue.enqueue({
      reason: "test",
      priority: "HIGH",
      filePaths: [fileNode.relativePath],
      nodeUpserts: [fileNode],
      edgeUpserts: [],
      codeChunkUpserts: [],
      commentChunkUpserts: [],
      deletes: []
    });
    await database.setIndexState(1, 0, 999);

    await database.clear();

    expect(database.getAllNodes("function")).toHaveLength(0);
    expect(database.getAllEdges()).toHaveLength(0);
    expect(database.getIndexState()).toBeUndefined();
  });
});
