import { performance } from "node:perf_hooks";
import * as vscode from "vscode";
import { registerAllCommands } from "./commands";
import type { CommandServices } from "./commands/types";
import { DashboardViewProvider } from "./providers/dashboardViewProvider";
import { CodeIngestTreeProvider } from "./tree/codeIngestTreeProvider";
import { ConfigurationService } from "./services/configurationService";
import { Diagnostics } from "./services/diagnostics";
import { ErrorReporter } from "./services/errorReporter";
import { GitignoreService } from "./services/gitignoreService";
import { WorkspaceManager } from "./services/workspaceManager";
import { WebviewPanelManager } from "./webview/webviewPanelManager";

let errorReporter: ErrorReporter | undefined;
let outputChannel: vscode.OutputChannel | undefined;
let activationTelemetry: Telemetry | undefined;

class Telemetry {
  private readonly timings = new Map<string, number>();

  constructor(private readonly channel: vscode.OutputChannel, private readonly enabled: boolean) {}

  start(name: string): void {
    if (!this.enabled) {
      return;
    }
    this.timings.set(name, performance.now());
  }

  end(name: string, extra?: Record<string, unknown>): void {
    if (!this.enabled) {
      return;
    }
    const start = this.timings.get(name);
    if (typeof start !== "number") {
      return;
    }
    const duration = Math.round(performance.now() - start);
    const payload = extra ? ` | ${JSON.stringify(extra)}` : "";
    this.channel.appendLine(`[telemetry] ${name} completed in ${duration}ms${payload}`);
    this.timings.delete(name);
  }

  dispose(): void {
    this.timings.clear();
  }
}

function createCommandWrapper(
  context: vscode.ExtensionContext,
  commandId: string,
  handler: (...args: unknown[]) => unknown | Promise<unknown>,
  errorChannel: ErrorReporter
): vscode.Disposable {
  const wrapped = async (...args: unknown[]): Promise<unknown> => {
    outputChannel?.appendLine(`[command] ${commandId} invoked`);
    const start = performance.now();
    try {
      const result = await handler(...args);
      outputChannel?.appendLine(`[command] ${commandId} completed in ${Math.round(performance.now() - start)}ms`);
      return result;
    } catch (error) {
      errorChannel.report(error, { command: commandId });
      void vscode.window.showErrorMessage(`Code Ingest: Command failed (${commandId}). See error output for details.`);
      throw error;
    }
  };

  const disposable = vscode.commands.registerCommand(commandId, wrapped);
  context.subscriptions.push(disposable);
  return disposable;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const activationStart = performance.now();
  const isDevelopment = context.extensionMode !== vscode.ExtensionMode.Production;

  outputChannel = vscode.window.createOutputChannel("Code Ingest");
  const errorChannel = vscode.window.createOutputChannel("Code Ingest Errors");
  context.subscriptions.push(outputChannel, errorChannel);
  outputChannel.appendLine("[activation] Starting Code Ingest activation sequence...");

  errorReporter = new ErrorReporter(errorChannel);
  context.subscriptions.push(errorReporter);

  activationTelemetry = new Telemetry(outputChannel, !isDevelopment);
  activationTelemetry.start("activation");

  const diagnostics = new Diagnostics();
  const gitignoreService = new GitignoreService();
  const workspaceManager = new WorkspaceManager(diagnostics, gitignoreService);

  const processHandlers: Array<() => void> = [];
  const uncaughtExceptionHandler = (error: unknown) => {
    errorReporter?.report(error, { source: "uncaughtException" });
  };
  const unhandledRejectionHandler = (reason: unknown) => {
    errorReporter?.report(reason, { source: "unhandledRejection" });
  };
  process.on("uncaughtException", uncaughtExceptionHandler);
  process.on("unhandledRejection", unhandledRejectionHandler);
  processHandlers.push(() => process.off("uncaughtException", uncaughtExceptionHandler));
  processHandlers.push(() => process.off("unhandledRejection", unhandledRejectionHandler));
  context.subscriptions.push({ dispose: () => processHandlers.forEach((dispose) => dispose()) });

  const configurationDiagnostics = {
    addError: (message: string) => errorReporter?.report(new Error(message), { source: "configuration" }),
    addWarning: (message: string) => outputChannel?.appendLine(`[config-warning] ${message}`)
  };

  try {
    ConfigurationService.getWorkspaceConfig(undefined, configurationDiagnostics);
  } catch (error) {
    errorReporter.report(error, { source: "configuration" });
  }

  const treeProviders = new Map<string, CodeIngestTreeProvider>();
  const treeViews = new Map<string, vscode.TreeView<vscode.TreeItem>>();
  const ensureTreeForFolder = (folder: vscode.WorkspaceFolder): void => {
    const key = folder.uri.fsPath;
    if (treeProviders.has(key)) {
      return;
    }
    const provider = new CodeIngestTreeProvider(folder);
    const view = vscode.window.createTreeView("codeIngestExplorer", {
      treeDataProvider: provider,
      showCollapseAll: true
    });
    treeProviders.set(key, provider);
    treeViews.set(key, view);
    context.subscriptions.push(view);
  };

  vscode.workspace.workspaceFolders?.forEach(ensureTreeForFolder);
  const workspaceWatcher = vscode.workspace.onDidChangeWorkspaceFolders((event) => {
    event.added.forEach(ensureTreeForFolder);
    event.removed.forEach((folder) => {
      const key = folder.uri.fsPath;
      const view = treeViews.get(key);
      if (view) {
        view.dispose();
        treeViews.delete(key);
      }
      treeProviders.delete(key);
    });
  });
  context.subscriptions.push(workspaceWatcher);

  const webviewPanelManager = new WebviewPanelManager(context.extensionUri);
  const dashboardProvider = new DashboardViewProvider(context.extensionUri, errorReporter);
  const webviewViewDisposable = vscode.window.registerWebviewViewProvider("codeIngestDashboard", dashboardProvider, {
    webviewOptions: {
      retainContextWhenHidden: true
    }
  });
  context.subscriptions.push(webviewViewDisposable);

  const services: CommandServices = {
    diagnostics,
    gitignoreService,
    workspaceManager,
    webviewPanelManager,
    treeProviders
  };

  registerAllCommands(context, services);

  const manualCommands: Array<[string, (...args: unknown[]) => Promise<unknown> | unknown]> = [
    ["codeIngest.openDashboardPanel", () => webviewPanelManager.createAndShowPanel()],
    ["codeIngest.flushErrorReports", async () => {
      errorReporter?.flush();
      await vscode.window.showInformationMessage("Code Ingest: Error reports flushed to output channel.");
    }],
    ["codeIngest.viewMetrics", async () => {
      const message = `Tree providers: ${treeProviders.size}`;
      outputChannel?.appendLine(`[metrics] ${message}`);
      await vscode.window.showInformationMessage(`Code Ingest metrics available in output channel.`);
    }],
    ["codeIngest.toggleRedactionOverride", async () => {
      const key = "codeIngest.redactionOverride";
      const current = context.globalState.get<boolean>(key, false);
      const next = !current;
      await context.globalState.update(key, next);
      outputChannel?.appendLine(`[redaction] override set to ${next}`);
      await vscode.window.showInformationMessage(`Code Ingest redaction override ${next ? "enabled" : "disabled"}.`);
      return next;
    }],
    ["codeIngest.selectNone", () => vscode.commands.executeCommand("codeIngest.deselectAll")],
    ["codeIngest.loadRemoteRepo", () => vscode.commands.executeCommand("codeIngest.ingestRemoteRepo")],
    ["codeIngest.invertSelection", async () => {
      await vscode.window.showInformationMessage("Code Ingest: Invert selection is not yet implemented.");
    }]
  ];

  manualCommands.forEach(([id, handler]) => {
    createCommandWrapper(context, id, handler, errorReporter!);
  });

  workspaceManager.initialize();
  const configListener = vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration("codeIngest")) {
      outputChannel?.appendLine("[config] codeIngest configuration changed");
    }
  });
  context.subscriptions.push(configListener);
  activationTelemetry.end("activation", { workspaceFolders: vscode.workspace.workspaceFolders?.length ?? 0 });
  const activationDuration = Math.round(performance.now() - activationStart);
  outputChannel.appendLine(`[activation] Code Ingest activated in ${activationDuration}ms`);

  context.subscriptions.push({ dispose: () => diagnostics.clear() });
  context.subscriptions.push({ dispose: () => errorReporter?.flush() });

  if (isDevelopment) {
    outputChannel.appendLine("[activation] Development mode detected; telemetry disabled.");
    const reloadWatcher = vscode.workspace.onDidSaveTextDocument((document) => {
      if (document.fileName.startsWith(context.extensionPath)) {
        outputChannel?.appendLine(`[reload] Detected change to ${document.fileName}`);
      }
    });
    context.subscriptions.push(reloadWatcher);
  }
}

export function deactivate(): void {
  outputChannel?.appendLine("[deactivation] Shutting down Code Ingest extension...");
  errorReporter?.flush();
  activationTelemetry?.dispose();
  // Resources registered with context.subscriptions are disposed automatically.
}
