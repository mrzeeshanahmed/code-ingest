import * as vscode from "vscode";
import { GraphIndexer, GraphIndexResult } from "../graph/indexer/GraphIndexer";
import { GraphDatabase } from "../graph/database/GraphDatabase";
import { GraphViewPanel } from "../providers/graphViewPanel";
import { SettingsProvider } from "../providers/settingsProvider";

export interface GraphCommandDependencies {
  graphIndexer: GraphIndexer;
  graphDatabase: GraphDatabase;
  graphViewPanel: GraphViewPanel;
  settingsProvider: SettingsProvider;
  outputChannel: vscode.OutputChannel;
  onSendToChat: (filePath?: string | string[]) => Promise<void>;
  onIndexed: (result: GraphIndexResult) => Promise<void>;
}

const COMMAND_ALIASES: Record<string, string[]> = {
  "code-ingest.rebuildGraph": ["codeIngest.rebuildGraph"],
  "code-ingest.openGraphView": ["codeIngest.openGraphView"],
  "code-ingest.focusCurrentFile": ["codeIngest.focusCurrentFile"],
  "code-ingest.openSettings": ["codeIngest.openSettings"],
  "code-ingest.sendToChat": ["codeIngest.sendToChat"],
  "code-ingest.showLogs": ["codeIngest.showLogs"],
  "code-ingest.exportGraphPng": ["codeIngest.exportGraphPng"],
  "code-ingest.clearDatabase": ["codeIngest.clearDatabase"],
  "code-ingest.showGraphStats": ["codeIngest.showGraphStats"]
};

export function registerGraphCommands(context: vscode.ExtensionContext, deps: GraphCommandDependencies): void {
  const register = (commandId: string, handler: (...args: unknown[]) => unknown | Promise<unknown>) => {
    context.subscriptions.push(vscode.commands.registerCommand(commandId, handler));
    for (const alias of COMMAND_ALIASES[commandId] ?? []) {
      context.subscriptions.push(vscode.commands.registerCommand(alias, handler));
    }
  };

  register("code-ingest.openGraphView", async () => {
    await deps.graphViewPanel.createOrShow();
  });

  register("code-ingest.rebuildGraph", async () => {
    const result = await deps.graphIndexer.indexWorkspace();
    await deps.onIndexed(result);
    void vscode.window.showInformationMessage(`Graph rebuilt: ${result.nodeCount} nodes, ${result.edgeCount} edges.`);
  });

  register("code-ingest.clearDatabase", async () => {
    deps.graphDatabase.clear();
    const result = await deps.graphIndexer.indexWorkspace();
    await deps.onIndexed(result);
    void vscode.window.showInformationMessage("Graph database cleared and rebuilt.");
  });

  register("code-ingest.showGraphStats", async () => {
    const stats = deps.graphDatabase.getStats();
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

  register("code-ingest.focusCurrentFile", async (filePath?: unknown) => {
    const target = typeof filePath === "string" ? filePath : vscode.window.activeTextEditor?.document.uri.fsPath;
    await deps.graphViewPanel.focusFile(target);
  });

  register("code-ingest.openSettings", async () => {
    await deps.settingsProvider.createOrShow();
  });

  register("code-ingest.sendToChat", async (filePath?: unknown) => {
    await deps.onSendToChat(typeof filePath === "string" ? filePath : undefined);
  });

  register("code-ingest.showLogs", async () => {
    deps.outputChannel.show(true);
  });

  register("code-ingest.exportGraphPng", async () => {
    await deps.graphViewPanel.exportPng();
  });
}
