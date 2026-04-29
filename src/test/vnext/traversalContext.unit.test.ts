import * as fs from "node:fs/promises";
import { ContextBuilder } from "../../graph/traversal/ContextBuilder";
import { GraphTraversal } from "../../graph/traversal/GraphTraversal";
import { GraphDatabase } from "../../graph/database/GraphDatabase";
import { createEdge, createNode, createTempWorkspace, removeTempWorkspace } from "./testUtils";

describe("GraphTraversal", () => {
  let workspaceRoot: string;
  let database: GraphDatabase;

  beforeEach(async () => {
    workspaceRoot = await createTempWorkspace(".tmp-graph-traversal");
    database = new GraphDatabase(workspaceRoot);
    database.open();
  });

  afterEach(async () => {
    database.dispose();
    await removeTempWorkspace(workspaceRoot);
  });

  test("keeps the root node first and marks circular relationships", () => {
    const root = createNode(workspaceRoot, "src/root.ts", "root.ts", "file");
    const dependency = createNode(workspaceRoot, "src/dep.ts", "dep.ts", "file");
    const leaf = createNode(workspaceRoot, "src/leaf.ts", "leaf.ts", "file");

    database.replaceFiles(
      [root.relativePath, dependency.relativePath, leaf.relativePath],
      [root, dependency, leaf],
      [
        createEdge(root.id, dependency.id, "import"),
        createEdge(dependency.id, root.id, "import"),
        createEdge(dependency.id, leaf.id, "import")
      ]
    );

    const traversal = new GraphTraversal(database);
    const subGraph = traversal.bfs(root.id, 2, "both");

    expect(subGraph.orderedNodeIds[0]).toBe(root.id);
    expect(subGraph.nodes.map((node) => node.id).sort()).toEqual([root.id, dependency.id, leaf.id].sort());
    expect(subGraph.circularEdgeIds).toEqual(
      expect.arrayContaining([
        createEdge(root.id, dependency.id, "import").id,
        createEdge(dependency.id, root.id, "import").id
      ])
    );
  });
});

describe("ContextBuilder", () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await createTempWorkspace(".tmp-context-builder");
  });

  afterEach(async () => {
    await removeTempWorkspace(workspaceRoot);
  });

  test("redacts secrets and renders readable edge summaries", async () => {
    const entryPath = `${workspaceRoot}/src/index.ts`;
    const helperPath = `${workspaceRoot}/src/helper.ts`;
    await fs.mkdir(`${workspaceRoot}/src`, { recursive: true });
    await fs.writeFile(entryPath, 'const apiKey = "token=abcdefghijklmnopqrstuvwxyz";\nrunHelper();\n', "utf8");
    await fs.writeFile(helperPath, "export function runHelper() {}\n", "utf8");

    const entry = createNode(workspaceRoot, "src/index.ts", "index.ts", "file", { filePath: entryPath });
    const helper = createNode(workspaceRoot, "src/helper.ts", "helper.ts", "file", { filePath: helperPath });

    const builder = new ContextBuilder({
      tokenBudget: 400,
      includeSourceContent: true,
      redactSecrets: true
    });

    const result = await builder.build(
      "src/index.ts",
      {
        nodes: [entry, helper],
        edges: [createEdge(entry.id, helper.id, "call")],
        orderedNodeIds: [entry.id, helper.id],
        circularEdgeIds: []
      },
      [{ node: helper, distance: 0.125 }]
    );

    expect(result.payload).toContain("call: helper.ts (src/helper.ts)");
    expect(result.payload).toContain("[REDACTED]");
    expect(result.payload).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(result.includedNodeIds).toContain(entry.id);
  });

  test("drops source blocks that exceed the token budget", async () => {
    const largePath = `${workspaceRoot}/src/large.ts`;
    await fs.mkdir(`${workspaceRoot}/src`, { recursive: true });
    await fs.writeFile(largePath, Array.from({ length: 300 }, () => "alpha beta gamma delta").join("\n"), "utf8");

    const fileNode = createNode(workspaceRoot, "src/large.ts", "large.ts", "file", { filePath: largePath });
    const builder = new ContextBuilder({
      tokenBudget: 40,
      includeSourceContent: true,
      redactSecrets: true
    });

    const result = await builder.build("src/large.ts", {
      nodes: [fileNode],
      edges: [],
      orderedNodeIds: [fileNode.id],
      circularEdgeIds: []
    });

    expect(result.droppedNodeIds).toContain(fileNode.id);
    expect(result.includedNodeIds).toHaveLength(0);
    expect(result.payload).toContain("--- FILE CONTENTS (within token budget) ---");
    expect(result.payload).not.toContain("alpha beta gamma delta");
  });
});
