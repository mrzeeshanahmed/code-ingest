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
import { GitActivityMonitor } from "./graph/indexer/GitActivityMonitor";
import { GraphIndexer, GraphIndexResult } from "./graph/indexer/GraphIndexer";
import { GraphTraversal } from "./graph/traversal/GraphTraversal";
import { ContextBuilder } from "./graph/traversal/ContextBuilder";
import { GraphViewPanel } from "./providers/graphViewPanel";
import { SettingsProvider } from "./providers/settingsProvider";
import { SidebarProvider, SidebarState } from "./providers/sidebarProvider";
import { EmbeddingService } from "./services/embeddingService";
import { CopilotParticipant } from "./services/copilotParticipant";
import { RootRuntime, RootRuntimeRegistry } from "./graph/indexer/rootRuntimeRegistry";

let outputChannel: vscode.OutputChannel | undefined;
let errorChannel: vscode.OutputChannel | undefined;
let rootRegistry: RootRuntimeRegistry | undefined;
let copilotParticipant: CopilotParticipant | undefined;
let graphViewPanel: GraphViewPanel | undefined;
let settingsProvider: SettingsProvider | undefined;

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

type InitState = "trust-locked" | "not-initialized" | "initializing" | "ready";

function getActiveRoot(): vscode.WorkspaceFolder | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return undefined;
  }
  if (folders.length === 1) {
    return folders[0];
  }
  const activeEditor = vscode.window.activeTextEditor;
  if (activeEditor) {
    for (const folder of folders) {
      const rel = path.relative(folder.uri.fsPath, activeEditor.document.uri.fsPath);
      if (!rel.startsWith("..") && !path.isAbsolute(rel)) {
        return folder;
      }
    }
  }
  return folders[0];
}

async function initializeRoot(
  context: vscode.ExtensionContext,
  workspaceFolder: vscode.WorkspaceFolder
): Promise<RootRuntime> {
  outputChannel?.appendLine(`[activation] Initializing root: ${workspaceFolder.uri.fsPath}`);

  await ensureWorkspaceGitignore(workspaceFolder.uri);

  const graphSettings = () => getGraphSettings(workspaceFolder);
  const configurationService = new ConfigurationService();
  const logger = createLogger(errorChannel!);
  const reporter = new ErrorReporter(configurationService, logger);
  const gitignoreService = new GitignoreService();
  const filterService = new FilterService({
    workspaceRoot: workspaceFolder.uri.fsPath,
    gitignoreService
  });
  const fileScanner = new FileScanner(workspaceFolder.uri);

  const graphDatabase = new GraphDatabase(workspaceFolder.uri.fsPath, outputChannel ? { outputChannel } : {});
  await graphDatabase.open();
  outputChannel?.appendLine(`[activation] Graph database initialized at ${graphDatabase.databasePath}`);

  const traversal = new GraphTraversal(graphDatabase);
  const embeddingService = new EmbeddingService(workspaceFolder.uri.fsPath, graphDatabase, outputChannel);
  const contextBuilder = new ContextBuilder({
    tokenBudget: graphSettings().tokenBudget,
    includeSourceContent: graphSettings().includeSourceContent,
    redactSecrets: graphSettings().redactSecrets
  });
  const graphIndexer = new GraphIndexer({
    workspaceRoot: workspaceFolder.uri,
    extensionUri: context.extensionUri,
    fileScanner,
    filterService,
    graphDatabase,
    getSettings: graphSettings,
    ...(outputChannel ? { outputChannel } : {})
  });

  const gitActivityMonitor = new GitActivityMonitor({
    ...(outputChannel ? { outputChannel } : {}),
    onActivityStart: () => {
      outputChannel?.appendLine("[git-monitor] Git activity detected; pausing watchers.");
    },
    onActivityEnd: () => {
      outputChannel?.appendLine("[git-monitor] Git activity ended; resuming watchers.");
    }
  });

  const relativePattern = new vscode.RelativePattern(workspaceFolder, "**/*");
  const fileWatcher = new FileWatcher({
    workspaceRoot: workspaceFolder.uri,
    relativePattern,
    debounceMs: graphSettings().watcherDebounceMs,
    ...(outputChannel ? { outputChannel } : {}),
    isPaused: () => gitActivityMonitor.isGitActive(),
    onFilesChanged: async (relativePaths) => {
      const runtime = rootRegistry?.getRuntime(workspaceFolder.uri);
      if (!runtime) return;
      await runtime.graphDatabase.writerQueue.waitForQuiescent();
      const result = await graphIndexer.reindexRelativePaths(relativePaths);
      outputChannel?.appendLine(`[watcher] Reindexed ${result.indexedFiles} file(s) in ${result.durationMs}ms.`);
    }
  });

  const runtime: RootRuntime = {
    workspaceFolder,
    graphDatabase,
    fileWatcher,
    gitActivityMonitor,
    graphIndexer,
    disposables: [fileWatcher]
  };

  rootRegistry?.register(runtime);

  const indexState = graphDatabase.getIndexState();
  const shouldRebuild = graphSettings().rebuildOnActivation || graphDatabase.needsSchemaUpgrade();
  const changedFiles = shouldRebuild ? [] : await detectChangedFiles(graphDatabase, workspaceFolder.uri);

  if (shouldRebuild || !indexState) {
    outputChannel?.appendLine("[activation] Running full rebuild.");
    const result = await graphIndexer.indexWorkspace();
    outputChannel?.appendLine(`[activation] Full rebuild complete: ${result.indexedFiles} file(s).`);
  } else if (changedFiles.length > 0) {
    outputChannel?.appendLine(`[activation] Detected ${changedFiles.length} changed file(s); running delta re-index.`);
    await graphIndexer.reindexRelativePaths(changedFiles);
  } else {
    outputChannel?.appendLine("[activation] Graph loaded from cache.");
  }

  return runtime;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  outputChannel = vscode.window.createOutputChannel("Code-Ingest");
  errorChannel = vscode.window.createOutputChannel("Code-Ingest Errors");
  context.subscriptions.push(outputChannel, errorChannel);

  rootRegistry = new RootRuntimeRegistry();
  context.subscriptions.push(rootRegistry);

  registerDigestCommand(context, { outputChannel, errorChannel });
  registerExportCommands(context, {
    outputChannel,
    errorChannel,
    graphDatabase: undefined as unknown as GraphDatabase
  });

  // Trust gate: all graph features require trusted workspace.
  if (!vscode.workspace.isTrusted) {
    outputChannel.appendLine("[activation] Workspace is not trusted; graph features disabled.");
    return;
  }

  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    outputChannel.appendLine("[activation] No workspace folder detected.");
    return;
  }

  // Initialize all roots.
  for (const folder of workspaceFolders) {
    try {
      await initializeRoot(context, folder);
    } catch (error) {
      outputChannel?.appendLine(`[activation] Failed to initialize root ${folder.uri.fsPath}: ${(error as Error).message}`);
    }
  }

  // Multi-root disposal.
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders((event) => {
      for (const removed of event.removed) {
        outputChannel?.appendLine(`[activation] Removing root: ${removed.uri.fsPath}`);
        rootRegistry?.unregister(removed.uri);
      }
      for (const added of event.added) {
        outputChannel?.appendLine(`[activation] Adding root: ${added.uri.fsPath}`);
        void initializeRoot(context, added);
      }
    })
  );

  const activeRuntime = (): RootRuntime | undefined => {
    const root = getActiveRoot();
    return root ? rootRegistry?.getRuntime(root.uri) : undefined;
  };

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
      const activeRoot = getActiveRoot();
      if (activeRoot) {
        const relativePath = path.relative(activeRoot.uri.fsPath, targetFiles[0]).replace(/\\/gu, "/");
        query = `@code-ingest /context ${relativePath}`;
      }
    }

    try {
      await vscode.commands.executeCommand("workbench.action.chat.open", { query });
    } catch {
      void vscode.window.showInformationMessage("Code-Ingest context copied to clipboard.");
      return;
    }

    const statusMessage = targetFiles.length > 1
      ? "Code-Ingest context for the selected nodes copied to clipboard and chat opened."
      : "Code-Ingest context copied to clipboard and chat opened.";
    void vscode.window.showInformationMessage(statusMessage);
  };

  const runtime = activeRuntime();
  if (!runtime) {
    return;
  }

  graphViewPanel = new GraphViewPanel({
    extensionUri: context.extensionUri,
    graphDatabase: runtime.graphDatabase,
    traversal: new GraphTraversal(runtime.graphDatabase),
    getSettings: () => getGraphSettings(runtime.workspaceFolder),
    outputChannel,
    onSendToChat: sendToChat
  });

  settingsProvider = new SettingsProvider({
    extensionUri: context.extensionUri,
    getSettings: () => getGraphSettings(runtime.workspaceFolder)
  });

  const sidebarProvider = new SidebarProvider({
    extensionUri: context.extensionUri,
    onRebuildGraph: async () => {
      const result = await runtime.graphIndexer.indexWorkspace();
      outputChannel?.appendLine(`[sidebar] Rebuilt graph: ${result.indexedFiles} file(s).`);
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

  const updateSidebar = async (): Promise<void> => {
    const rt = activeRuntime();
    if (!rt) return;
    sidebarProvider.setState(await buildSidebarState(rt.graphDatabase, () => getGraphSettings(rt.workspaceFolder)));
  };

  copilotParticipant = new CopilotParticipant({
    extensionUri: context.extensionUri,
    graphDatabase: runtime.graphDatabase,
    traversal: new GraphTraversal(runtime.graphDatabase),
    contextBuilder: new ContextBuilder({
      tokenBudget: getGraphSettings(runtime.workspaceFolder).tokenBudget,
      includeSourceContent: getGraphSettings(runtime.workspaceFolder).includeSourceContent,
      redactSecrets: getGraphSettings(runtime.workspaceFolder).redactSecrets
    }),
    embeddingService: new EmbeddingService(runtime.workspaceFolder.uri.fsPath, runtime.graphDatabase, outputChannel),
    settings: getGraphSettings(runtime.workspaceFolder),
    outputChannel,
    onFocusFile: async (filePath) => {
      await graphViewPanel?.focusFile(filePath);
    }
  });
  copilotParticipant.register();

  registerGraphCommands(context, {
    graphIndexer: runtime.graphIndexer,
    graphDatabase: runtime.graphDatabase,
    graphViewPanel,
    settingsProvider,
    outputChannel,
    onSendToChat: sendToChat,
    onIndexed: async (result: GraphIndexResult) => {
      outputChannel?.appendLine(`[indexer] Indexed ${result.indexedFiles} file(s) in ${result.durationMs}ms.`);
      await updateSidebar();
      await graphViewPanel?.refresh();
      await settingsProvider?.postState();
    }
  });

  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(async (event) => {
    if (
      event.affectsConfiguration("codeIngest.graph") ||
      event.affectsConfiguration("codeIngest.indexing") ||
      event.affectsConfiguration("codeIngest.copilot") ||
      event.affectsConfiguration("codeIngest.display")
    ) {
      await updateSidebar();
      await graphViewPanel?.refresh();
      await settingsProvider?.postState();
    }
  }));

  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(async (editor) => {
    await updateSidebar();
    const gs = activeRuntime() ? getGraphSettings(activeRuntime()!.workspaceFolder) : undefined;
    if (editor && gs?.autoFocusOnEditorChange) {
      await graphViewPanel?.focusFile(editor.document.uri.fsPath);
    }
  }));

  await updateSidebar();
}

export function deactivate(): void {
  graphViewPanel?.dispose();
  settingsProvider?.dispose();
  copilotParticipant?.dispose();
  rootRegistry?.dispose();
  outputChannel?.dispose();
  errorChannel?.dispose();
}
