import { jest } from "@jest/globals";
import * as vscode from "vscode";
import { CopilotParticipant } from "../../services/copilotParticipant";
import { createEdge, createNode } from "./testUtils";

describe("CopilotParticipant", () => {
  const workspaceRoot = "E:/workspace";

  function createParticipant() {
    const fileNode = createNode(workspaceRoot, "src/index.ts", "index.ts", "file", {
      filePath: `${workspaceRoot}/src/index.ts`
    });
    const relatedNode = createNode(workspaceRoot, "src/related.ts", "related.ts", "file", {
      filePath: `${workspaceRoot}/src/related.ts`
    });

    const graphDatabase = {
      getNodeByRelativePath: jest.fn(() => fileNode)
    };
    const traversal = {
      bfs: jest.fn(() => ({
        nodes: [fileNode, relatedNode],
        edges: [createEdge(fileNode.id, relatedNode.id, "import")],
        orderedNodeIds: [fileNode.id, relatedNode.id],
        circularEdgeIds: []
      }))
    };
    const contextBuilder = {
      build: jest.fn(async () => ({
        payload: "graph payload",
        includedNodeIds: [fileNode.id],
        droppedNodeIds: [],
        tokenEstimate: 42
      }))
    };
    const embeddingService = {
      search: jest.fn(async () => [
        {
          node: relatedNode,
          distance: 0.1234
        }
      ])
    };
    const onFocusFile = jest.fn(async () => undefined);

    const participant = new CopilotParticipant({
      extensionUri: vscode.Uri.file("E:/extension"),
      graphDatabase: graphDatabase as never,
      traversal: traversal as never,
      contextBuilder: contextBuilder as never,
      embeddingService: embeddingService as never,
      settings: {
        hopDepth: 3,
        defaultNodeMode: "file",
        maxNodes: 500,
        enableVectorSearch: true,
        layout: "cose",
        maxFileSizeKB: 10240,
        maxFiles: 10000,
        watcherDebounceMs: 800,
        excludePatterns: [],
        rebuildOnActivation: false,
        tokenBudget: 8192,
        includeSourceContent: true,
        redactSecrets: true,
        semanticResultCount: 5,
        showCircularDepsWarning: true,
        focusModeOpacity: 0.15,
        autoFocusOnEditorChange: true
      },
      onFocusFile
    });

    (vscode.workspace.workspaceFolders as unknown) = [
      {
        uri: vscode.Uri.file(workspaceRoot)
      }
    ];
    (vscode.window as unknown as { activeTextEditor: unknown }).activeTextEditor = {
      document: {
        uri: vscode.Uri.file(`${workspaceRoot}/src/index.ts`)
      }
    };

    participant.register();

    const registered = (vscode as unknown as {
      chat: {
        __getRegisteredParticipants: () => Map<string, { handler: (...args: unknown[]) => Promise<void> }>;
      };
    }).chat.__getRegisteredParticipants();

    const handle = async (request: unknown): Promise<string> => {
      const stream = {
        markdown: jest.fn()
      };
      const registeredParticipant = registered.get("code-ingest");
      if (!registeredParticipant) {
        throw new Error("Chat participant was not registered.");
      }
      await registeredParticipant.handler(request, {}, stream, new vscode.CancellationTokenSource().token);
      return stream.markdown.mock.calls[0]?.[0] as string;
    };

    return {
      fileNode,
      graphDatabase,
      traversal,
      contextBuilder,
      embeddingService,
      onFocusFile,
      handle
    };
  }

  test("handles all six slash command paths", async () => {
    const subject = createParticipant();

    const contextResult = await subject.handle({ prompt: "/context E:/workspace/src/index.ts" });
    expect(contextResult).toBe("graph payload");

    const focusResult = await subject.handle({ prompt: "/focus src/related.ts" });
    expect(focusResult).toContain("Focused graph view");
    expect(subject.onFocusFile).toHaveBeenCalledWith("src/related.ts");

    const impactResult = await subject.handle({ prompt: "/impact auth dependencies" });
    expect(impactResult).toBe("graph payload");
    expect(subject.traversal.bfs).toHaveBeenCalledWith(subject.fileNode.id, 3, "incoming");

    const explainResult = await subject.handle({ prompt: "/explain data flow" });
    expect(explainResult).toBe("graph payload");
    expect(explainResult).toContain("graph payload");

    const depthResult = await subject.handle({ prompt: "/depth 5" });
    expect(depthResult).toBe("graph payload");
    expect(subject.traversal.bfs).toHaveBeenCalledWith(subject.fileNode.id, 5, "both");

    const searchResult = await subject.handle({ prompt: "/search related module" });
    expect(searchResult).toContain("src/related.ts");
    expect(subject.embeddingService.search).toHaveBeenCalledWith("related module", 5);
    expect(subject.contextBuilder.build).toHaveBeenCalled();
    expect(subject.graphDatabase.getNodeByRelativePath).toHaveBeenCalledWith("src/index.ts");
  });
});
