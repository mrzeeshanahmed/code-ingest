import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { registerDigestCommand } from "./commands/digestCommand";
import { registerExportCommands } from "./commands/exportCommands";
import { registerGraphCommands } from "./commands/graphCommands";
import { getGraphSettings } from "./config/graphSettings";
import { ConfigurationService } from "./services/configurationService";
import { ErrorReporter } from "./services/errorReporter";
import { GitignoreService } from "./services/gitignoreService";
import type { Logger } from "./utils/gitProcessManager";
import { FilterService } from "./services/filterService";
import { FileScanner } from "./services/fileScanner";
import { GraphDatabase } from "./graph/database/GraphDatabase";
import { FileWatcher } from "./graph/indexer/FileWatcher";
import { GraphIndexer, GraphIndexResult } from "./graph/indexer/GraphIndexer";
import { GraphTraversal } from "./graph/traversal/GraphTraversal";
import { ContextBuilder } from "./graph/traversal/ContextBuilder";
import { GraphViewPanel } from "./providers/graphViewPanel";
import { SettingsProvider } from "./providers/settingsProvider";
import { SidebarProvider, SidebarState } from "./providers/sidebarProvider";
import { EmbeddingService } from "./services/embeddingService";
import { CopilotParticipant } from "./services/copilotParticipant";

let graphDatabase: GraphDatabase | undefined;
let fileWatcher: FileWatcher | undefined;
let copilotParticipant: CopilotParticipant | undefined;
let graphViewPanel: GraphViewPanel | undefined;
let settingsProvider: SettingsProvider | undefined;
let outputChannel: vscode.OutputChannel | undefined;
let errorChannel: vscode.OutputChannel | undefined;

function createLogger(channel: vscode.OutputChannel): Logger {
  return {
    debug: (message, context) => channel.appendLine(`[debug] ${message}${context ? ` ${JSON.stringify(context)}` : ""}`),
    info: (message, context) => channel.appendLine(`[info] ${message}${context ? ` ${JSON.stringify(context)}` : ""}`),
    warn: (message, context) => channel.appendLine(`[warn] ${message}${context ? ` ${JSON.stringify(context)}` : ""}`),
    error: (message, context) => channel.appendLine(`[error] ${message}${context ? ` ${JSON.stringify(context)}` : ""}`)
  };
}

async function ensureWorkspaceGitignore(workspaceRoot: vscode.Uri): Promise<void> {
  const gitignorePath = path.join(workspaceRoot.fsPath, ".gitignore");
  const requiredEntries = [".vscode/code-ingest/", ".vscode/code-ingest/graph.db"];

  let current = "";
  try {
    current = await fs.readFile(gitignorePath, "utf8");
  } catch {
    current = "";
  }

  const missing = requiredEntries.filter((entry) => !current.includes(entry));
  if (missing.length === 0) {
    return;
  }

  const next = `${current.trimEnd()}\n${missing.join("\n")}\n`.trimStart();
  await fs.writeFile(gitignorePath, next, "utf8");
}

async function detectChangedFiles(database: GraphDatabase, workspaceRoot: vscode.Uri): Promise<string[]> {
  const changed: string[] = [];
  for (const record of database.getIndexedFiles()) {
    const filePath = path.join(workspaceRoot.fsPath, record.relativePath);
    try {
      const stats = await fs.stat(filePath);
      if (stats.mtimeMs > record.lastIndexed) {
        changed.push(record.relativePath);
      }
    } catch {
      changed.push(record.relativePath);
    }
  }
  return changed;
}

async function buildSidebarState(
  database: GraphDatabase,
  settingsProvider: () => ReturnType<typeof getGraphSettings>,
  status: SidebarState["status"] = "ready"
): Promise<SidebarState> {
  const stats = database.getStats();
  const activeFile = vscode.window.activeTextEditor?.document.uri.fsPath;
  let dependencyCount = 0;
  let dependentCount = 0;

  if (activeFile && vscode.workspace.workspaceFolders?.[0]) {
    const relativePath = path.relative(vscode.workspace.workspaceFolders[0].uri.fsPath, activeFile).replace(/\\/gu, "/");
    const node = database.getNodeByRelativePath(relativePath);
    if (node) {
      dependencyCount = database.getNeighbors([node.id], "outgoing").edges.length;
      dependentCount = database.getNeighbors([node.id], "incoming").edges.length;
    }
  }

  return {
    status,
    nodeCount: stats.nodeCount,
    edgeCount: stats.edgeCount,
    fileCount: stats.fileCount,
    lastIndexed: stats.lastIndexed,
    databaseSizeBytes: stats.databaseSizeBytes,
    activeFile,
    dependencyCount,
    dependentCount,
    settings: {
      hopDepth: settingsProvider().hopDepth,
      defaultNodeMode: settingsProvider().defaultNodeMode,
      excludePatterns: settingsProvider().excludePatterns
    }
  };
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  outputChannel = vscode.window.createOutputChannel("Code-Ingest");
  errorChannel = vscode.window.createOutputChannel("Code-Ingest Errors");
  context.subscriptions.push(outputChannel, errorChannel);

  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    outputChannel.appendLine("[activation] No workspace folder detected.");
    registerDigestCommand(context, { outputChannel, errorChannel });
    return;
  }

  await ensureWorkspaceGitignore(workspaceFolder.uri);

  const graphSettings = () => getGraphSettings(workspaceFolder);
  const configurationService = new ConfigurationService();
  const logger = createLogger(errorChannel);
  const reporter = new ErrorReporter(configurationService, logger);
  const gitignoreService = new GitignoreService();
  const filterService = new FilterService({
    workspaceRoot: workspaceFolder.uri.fsPath,
    gitignoreService
  });
  const fileScanner = new FileScanner(workspaceFolder.uri);

  graphDatabase = new GraphDatabase(workspaceFolder.uri.fsPath, { outputChannel });
  graphDatabase.open();
  outputChannel.appendLine(`[activation] Graph database initialized at ${graphDatabase.databasePath}`);

  const traversal = new GraphTraversal(graphDatabase);
  const embeddingService = new EmbeddingService(graphDatabase, outputChannel);
  const contextBuilder = new ContextBuilder({
    tokenBudget: graphSettings().tokenBudget,
    includeSourceContent: graphSettings().includeSourceContent,
    redactSecrets: graphSettings().redactSecrets
  });
  const graphIndexer = new GraphIndexer({
    workspaceRoot: workspaceFolder.uri,
    fileScanner,
    filterService,
    graphDatabase,
    getSettings: graphSettings,
    outputChannel,
    embeddingService
  });

  const sendToChat = async (target?: string | string[]): Promise<void> => {
    if (!copilotParticipant) {
      void vscode.window.showWarningMessage("Code-Ingest chat participant is unavailable in this VS Code build.");
      return;
    }

    const payload = await copilotParticipant.createContextPayload(target);
    await vscode.env.clipboard.writeText(payload);

    const targetFiles = Array.isArray(target)
      ? target.filter((value): value is string => typeof value === "string")
      : typeof target === "string"
        ? [target]
        : [];
    let query = "@code-ingest /context";
    if (targetFiles.length === 1) {
      const relativePath = path.relative(workspaceFolder.uri.fsPath, targetFiles[0]).replace(/\\/gu, "/");
      query = `@code-ingest /context ${relativePath}`;
    }

    try {
      await vscode.commands.executeCommand("workbench.action.chat.open", {
        query
      });
    } catch {
      void vscode.window.showInformationMessage("Code-Ingest context copied to clipboard.");
      return;
    }

    const statusMessage = targetFiles.length > 1
      ? "Code-Ingest context for the selected nodes copied to clipboard and chat opened."
      : "Code-Ingest context copied to clipboard and chat opened.";
    void vscode.window.showInformationMessage(statusMessage);
  };

  graphViewPanel = new GraphViewPanel({
    extensionUri: context.extensionUri,
    graphDatabase,
    traversal,
    getSettings: graphSettings,
    outputChannel,
    onSendToChat: sendToChat
  });

  settingsProvider = new SettingsProvider({
    extensionUri: context.extensionUri,
    getSettings: graphSettings
  });

  const sidebarProvider = new SidebarProvider({
    extensionUri: context.extensionUri,
    onRebuildGraph: async () => {
      const result = await runFullIndexWithProgress();
      await onIndexed(result);
    },
    onOpenGraphView: async (filePath) => {
      await graphViewPanel?.createOrShow(filePath);
    },
    onSendToChat: async (filePath) => {
      await sendToChat(filePath);
    },
    onOpenSettings: async () => {
      await settingsProvider?.createOrShow();
    },
    onExport: async (mode, piiPolicy) => {
      let command: string;
      switch (mode) {
        case "raw": command = "codeIngest.exportRaw"; break;
        case "clean": command = "codeIngest.exportClean"; break;
        case "graph": command = "codeIngest.exportGraph"; break;
      }
      await vscode.commands.executeCommand(command, piiPolicy);
    }
  });

  context.subscriptions.push(vscode.window.registerWebviewViewProvider(SidebarProvider.viewType, sidebarProvider));

  const onIndexed = async (result: GraphIndexResult): Promise<void> => {
    outputChannel?.appendLine(`[indexer] Indexed ${result.indexedFiles} file(s) in ${result.durationMs}ms.`);
    sidebarProvider.setState(await buildSidebarState(graphDatabase!, graphSettings));
    await graphViewPanel?.refresh();
    await settingsProvider?.postState();
  };

  const setSidebarStatus = async (status: SidebarState["status"]): Promise<void> => {
    sidebarProvider.setState(await buildSidebarState(graphDatabase!, graphSettings, status));
  };

  const runFullIndexWithProgress = async (): Promise<GraphIndexResult> => {
    await setSidebarStatus("indexing");
    outputChannel?.appendLine("[activation] Building graph from workspace files.");

    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Code-Ingest: Building graph…",
        cancellable: false
      },
      async (progress) => {
        progress.report({ increment: 10, message: "Scanning workspace" });
        const result = await graphIndexer.indexWorkspace();
        progress.report({ increment: 90, message: `Indexed ${result.indexedFiles} files` });
        return result;
      }
    );
  };

  copilotParticipant = new CopilotParticipant({
    extensionUri: context.extensionUri,
    graphDatabase,
    traversal,
    contextBuilder,
    embeddingService,
    settings: graphSettings(),
    outputChannel,
    onFocusFile: async (filePath) => {
      await graphViewPanel?.focusFile(filePath);
    }
  });
  copilotParticipant.register();

  registerDigestCommand(context, { outputChannel, errorChannel });
  registerExportCommands(context, {
    outputChannel,
    errorChannel,
    graphDatabase
  });
  registerGraphCommands(context, {
    graphIndexer,
    graphDatabase,
    graphViewPanel,
    settingsProvider,
    outputChannel,
    onSendToChat: sendToChat,
    onIndexed
  });

  const indexState = graphDatabase.getIndexState();
  const shouldRebuild = graphSettings().rebuildOnActivation || graphDatabase.needsSchemaUpgrade();
  const changedFiles = shouldRebuild ? [] : await detectChangedFiles(graphDatabase, workspaceFolder.uri);
  if (shouldRebuild || !indexState) {
    await onIndexed(await runFullIndexWithProgress());
  } else if (changedFiles.length > 0) {
    outputChannel.appendLine(`[activation] Detected ${changedFiles.length} changed file(s); running delta re-index.`);
    await setSidebarStatus("indexing");
    await onIndexed(await graphIndexer.reindexRelativePaths(changedFiles));
  } else {
    outputChannel.appendLine("[activation] Graph loaded from cache.");
    sidebarProvider.setState(await buildSidebarState(graphDatabase, graphSettings));
  }

  fileWatcher = new FileWatcher({
    workspaceRoot: workspaceFolder.uri,
    debounceMs: graphSettings().watcherDebounceMs,
    outputChannel,
    onFilesChanged: async (relativePaths) => {
      await setSidebarStatus("indexing");
      const result = await graphIndexer.reindexRelativePaths(relativePaths);
      await onIndexed(result);
    }
  });
  context.subscriptions.push(fileWatcher);

  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(async (event) => {
    if (
      event.affectsConfiguration("codeIngest.graph") ||
      event.affectsConfiguration("codeIngest.indexing") ||
      event.affectsConfiguration("codeIngest.copilot") ||
      event.affectsConfiguration("codeIngest.display")
    ) {
      sidebarProvider.setState(await buildSidebarState(graphDatabase!, graphSettings));
      await graphViewPanel?.refresh();
      await settingsProvider?.postState();
    }
  }));

  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(async (editor) => {
    sidebarProvider.setState(await buildSidebarState(graphDatabase!, graphSettings));
    if (editor && graphSettings().autoFocusOnEditorChange) {
      await graphViewPanel?.focusFile(editor.document.uri.fsPath);
    }
  }));
}

export function deactivate(): void {
  fileWatcher?.dispose();
  graphViewPanel?.dispose();
  settingsProvider?.dispose();
  copilotParticipant?.dispose();
  graphDatabase?.dispose();
  outputChannel?.dispose();
  errorChannel?.dispose();
}
