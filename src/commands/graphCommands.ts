import * as vscode from "vscode";
import { GraphIndexer, GraphIndexResult } from "../graph/indexer/GraphIndexer";
import { GraphDatabase } from "../graph/database/GraphDatabase";
import { GraphViewPanel } from "../providers/graphViewPanel";
import { SettingsProvider } from "../providers/settingsProvider";
import { KnowledgeService } from "../graph/semantic/KnowledgeService";

export interface GraphCommandDependencies {
  getGraphIndexer: () => GraphIndexer;
  getGraphDatabase: () => GraphDatabase;
  getKnowledgeService: () => KnowledgeService | undefined;
  graphViewPanel: GraphViewPanel;
  settingsProvider: SettingsProvider;
  outputChannel: vscode.OutputChannel;
  onSendToChat: (filePath?: string | string[]) => Promise<void>;
  onIndexed: (result: GraphIndexResult) => Promise<void>;
}

export function registerGraphCommands(context: vscode.ExtensionContext, deps: GraphCommandDependencies): void {
  const register = (commandId: string, handler: (...args: unknown[]) => unknown | Promise<unknown>) => {
    context.subscriptions.push(vscode.commands.registerCommand(commandId, handler));
  };

  register("codeIngest.openGraphView", async () => {
    await deps.graphViewPanel.createOrShow();
  });

  register("codeIngest.rebuildGraph", async () => {
    const result = await deps.getGraphIndexer().indexWorkspace();
    await deps.onIndexed(result);
    void vscode.window.showInformationMessage(`Graph rebuilt: ${result.nodeCount} nodes, ${result.edgeCount} edges.`);
  });

  register("codeIngest.clearDatabase", async () => {
    deps.getGraphDatabase().clear();
    const result = await deps.getGraphIndexer().indexWorkspace();
    await deps.onIndexed(result);
    void vscode.window.showInformationMessage("Graph database cleared and rebuilt.");
  });

  register("codeIngest.showGraphStats", async () => {
    const stats = deps.getGraphDatabase().getStats();
    await vscode.window.showQuickPick(
      [
        `Nodes: ${stats.nodeCount}`,
        `Edges: ${stats.edgeCount}`,
        `DB Size: ${Math.round(stats.databaseSizeBytes / 1024)} KB`,
        `Last Indexed: ${stats.lastIndexed ? new Date(stats.lastIndexed).toLocaleString() : "Never"}`
      ],
      { title: "Code-Ingest Graph Statistics" }
    );
  });

  register("codeIngest.focusCurrentFile", async (filePath?: unknown) => {
    const target = typeof filePath === "string" ? filePath : vscode.window.activeTextEditor?.document.uri.fsPath;
    await deps.graphViewPanel.focusFile(target);
  });

  register("codeIngest.openSettings", async () => {
    await deps.settingsProvider.createOrShow();
  });

  register("codeIngest.sendToChat", async (filePath?: unknown) => {
    await deps.onSendToChat(typeof filePath === "string" ? filePath : undefined);
  });

  register("codeIngest.showLogs", async () => {
    deps.outputChannel.show(true);
  });

  register("codeIngest.exportGraphPng", async () => {
    await deps.graphViewPanel.exportPng();
  });

  register("codeIngest.initializeCodebase", async () => {
    const result = await deps.getGraphIndexer().indexWorkspace();
    await deps.onIndexed(result);
    void vscode.window.showInformationMessage(`Codebase initialized: ${result.nodeCount} nodes, ${result.edgeCount} edges.`);
  });

  register("codeIngest.synthesizeKnowledge", async (targetPath?: unknown) => {
    const ks = deps.getKnowledgeService();
    if (!ks) {
      void vscode.window.showWarningMessage("Knowledge service is not available.");
      return;
    }
    const db = deps.getGraphDatabase();
    const activePath = typeof targetPath === "string"
      ? targetPath
      : vscode.window.activeTextEditor?.document.uri.fsPath;
    if (!activePath) {
      void vscode.window.showWarningMessage("No active file to synthesize knowledge for.");
      return;
    }
    const relativePath = vscode.workspace.asRelativePath(activePath);
    const node = db.getNodeByRelativePath(relativePath);
    if (!node) {
      void vscode.window.showWarningMessage(`File not found in graph: ${relativePath}`);
      return;
    }
    const entry = await ks.synthesizeForNode(node);
    if (entry) {
      void vscode.window.showInformationMessage(`Knowledge synthesized for ${node.relativePath}.`);
    } else {
      void vscode.window.showWarningMessage(`Could not synthesize knowledge for ${node.relativePath}.`);
    }
  });

  register("codeIngest.exportDiagnostics", async () => {
    const db = deps.getGraphDatabase();
    const stats = db.getStats();
    const indexState = db.getIndexState();
    const bundle = {
      timestamp: new Date().toISOString(),
      extensionVersion: "1.1.0",
      graphStats: {
        nodeCount: stats.nodeCount,
        edgeCount: stats.edgeCount,
        fileCount: stats.fileCount,
        databaseSizeBytes: stats.databaseSizeBytes,
        lastIndexed: stats.lastIndexed
      },
      indexState: indexState
        ? {
            workspaceHash: indexState.workspaceHash,
            lastFullIndex: indexState.lastFullIndex,
            nodeCount: indexState.nodeCount,
            edgeCount: indexState.edgeCount,
            schemaVersion: indexState.schemaVersion
          }
        : null,
      configuration: {
        // Redacted: only schema keys, no values
        settingsSchema: "codeIngest.graph, codeIngest.indexing, codeIngest.copilot, codeIngest.display, codeIngest.pii, codeIngest.embedding, codeIngest.knowledge"
      },
      embeddingAvailable: false,
      recentErrors: [] as string[]
    };
    const json = JSON.stringify(bundle, null, 2);
    await vscode.env.clipboard.writeText(json);
    void vscode.window.showInformationMessage("Diagnostics bundle copied to clipboard.");
  });
}
