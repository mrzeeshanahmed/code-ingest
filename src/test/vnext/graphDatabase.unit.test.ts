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
    database.open();
  });

  afterEach(async () => {
    database.dispose();
    await removeTempWorkspace(workspaceRoot);
  });

  test("creates schema, tracks index state, and reports stats", () => {
    expect(database.needsSchemaUpgrade()).toBe(true);

    const fileNode = createNode(workspaceRoot, "src/index.ts", "index.ts", "file", { language: "typescript" });
    const helperNode = createNode(workspaceRoot, "src/helper.ts", "helper.ts", "file", { language: "typescript" });
    const importEdge = createEdge(fileNode.id, helperNode.id, "import");

    database.replaceFiles([fileNode.relativePath, helperNode.relativePath], [fileNode, helperNode], [importEdge]);
    database.setIndexState(2, 1, 12345);

    expect(database.needsSchemaUpgrade()).toBe(false);
    expect(database.getIndexState()).toEqual({
      workspaceHash: database.workspaceHash,
      lastFullIndex: 12345,
      nodeCount: 2,
      edgeCount: 1,
      schemaVersion: GRAPH_SCHEMA_VERSION
    });

    const stats = database.getStats();
    expect(stats.nodeCount).toBe(2);
    expect(stats.edgeCount).toBe(1);
    expect(stats.languages.typescript).toBe(2);
    expect(stats.databaseSizeBytes).toBeGreaterThan(0);
  });

  test("returns bidirectional neighbors and embedding matches", () => {
    const fileNode = createNode(workspaceRoot, "src/index.ts", "index.ts", "file");
    const helperNode = createNode(workspaceRoot, "src/helper.ts", "helper.ts", "file");
    const importEdge = createEdge(fileNode.id, helperNode.id, "import");

    database.replaceFiles([fileNode.relativePath, helperNode.relativePath], [fileNode, helperNode], [importEdge]);
    database.upsertEmbeddings([
      { nodeId: fileNode.id, embedding: [0, 0] },
      { nodeId: helperNode.id, embedding: [3, 4] }
    ]);

    const neighbors = database.getNeighbors([fileNode.id], "both");
    expect(neighbors.nodes.map((node) => node.id).sort()).toEqual([fileNode.id, helperNode.id].sort());
    expect(neighbors.edges).toHaveLength(1);

    const matches = database.queryNearestEmbeddings([0, 1], 2);
    expect(matches.map((match) => match.nodeId)).toEqual([fileNode.id, helperNode.id]);
  });

  test("clears persisted graph state", () => {
    const fileNode = createNode(workspaceRoot, "src/index.ts", "index.ts", "file");
    database.replaceFiles([fileNode.relativePath], [fileNode], []);
    database.setIndexState(1, 0, 999);

    database.clear();

    expect(database.getAllNodes("function")).toHaveLength(0);
    expect(database.getAllEdges()).toHaveLength(0);
    expect(database.getIndexState()).toBeUndefined();
  });
});
