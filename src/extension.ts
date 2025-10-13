import { performance } from "node:perf_hooks";
import * as vscode from "vscode";
import { registerAllCommands } from "./commands";
import { hydrateRedactionOverride } from "./commands/redactionCommands";
import type { CommandServices } from "./commands/types";
import { COMMAND_MAP } from "./commands/commandMap";
import { DashboardViewProvider } from "./providers/dashboardViewProvider";
import { ConfigurationService } from "./services/configurationService";
import { Diagnostics } from "./services/diagnostics";
import { ErrorReporter } from "./services/errorReporter";
import { GitignoreService } from "./services/gitignoreService";
import { WorkspaceManager } from "./services/workspaceManager";
import { DiagnosticService } from "./services/diagnosticService";
import { PerformanceMonitor } from "./services/performanceMonitor";
import { WebviewPanelManager } from "./webview/webviewPanelManager";
import { DEFAULT_CONFIG } from "./config/constants";
import type { Logger } from "./utils/gitProcessManager";
import { GitProcessManager } from "./utils/gitProcessManager";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

let errorReporter: ErrorReporter | undefined;
let outputChannel: vscode.OutputChannel | undefined;
let activationTelemetry: Telemetry | undefined;

function formatLogContext(context?: Record<string, unknown>): string {
  if (!context) {
    return "";
  }

  try {
    const serialized = JSON.stringify(context);
    return serialized && serialized !== "{}" ? ` ${serialized}` : "";
  } catch {
    return "";
  }
}

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
      const err = error as Error;
      errorChannel.report(err, { command: commandId });

      const actions = ["Details", "Report"] as const;
      const selection = await vscode.window.showErrorMessage(
        `Code Ingest: Command failed (${commandId}). ${err.message}`,
        ...actions
      );

      if (selection === "Details") {
        outputChannel?.show(true);
      } else if (selection === "Report") {
        const payload = {
          command: commandId,
          message: err.message,
          stack: err.stack,
          time: new Date().toISOString()
        };
        try {
          await vscode.env.clipboard.writeText(JSON.stringify(payload, null, 2));
          const openIssue = await vscode.window.showInformationMessage(
            "Error report copied to clipboard. Open issue page?",
            "Open Issue",
            "Cancel"
          );
          if (openIssue === "Open Issue") {
            void vscode.env.openExternal(vscode.Uri.parse("https://github.com/mrzeeshanahmed/code-ingest/issues/new"));
          }
        } catch (e) {
          outputChannel?.appendLine(`[report-failed] Failed to copy report: ${(e as Error).message}`);
        }
      }
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

  // Ensure webview resources are present in out/resources/webview - helpful in development
  try {
    const webviewOutIndex = path.join(context.extensionPath, "out", "resources", "webview", "index.html");
    if (!fs.existsSync(webviewOutIndex)) {
      outputChannel.appendLine("[activation] Webview build artifacts not found. Running webview copy script...");
      const script = path.join(context.extensionPath, "scripts", "copyWebviewResources.js");
      const result = spawnSync(process.execPath, [script], { cwd: context.extensionPath, encoding: "utf8" });
      if (result.error) {
        errorChannel.appendLine(`[activation] Failed to run webview copy script: ${result.error.message}`);
      } else if (result.status !== 0) {
        errorChannel.appendLine(`[activation] Webview copy script exited with code ${result.status}: ${result.stderr}`);
      } else {
        outputChannel.appendLine("[activation] Webview assets copied successfully.");
      }
    }
  } catch (err) {
    errorChannel.appendLine(`[activation] Webview asset check failed: ${(err as Error).message}`);
  }

  const diagnostics = new Diagnostics();

  const diagnosticsAdapter = {
    addError: (message: string) => {
      errorReporter?.report(new Error(message), { source: "configuration" });
      errorChannel.appendLine(`[config-error] ${message}`);
    },
    addWarning: (message: string) => {
      errorChannel.appendLine(`[config-warning] ${message}`);
    }
  } satisfies Parameters<typeof ConfigurationService.getWorkspaceConfig>[1];

  const workspaceConfig = (() => {
    try {
      return ConfigurationService.getWorkspaceConfig(undefined, diagnosticsAdapter);
    } catch (error) {
      errorChannel.appendLine(
        `[config-error] Failed to read workspace configuration: ${(error as Error).message}`
      );
      return DEFAULT_CONFIG;
    }
  })();

  const configurationService = new ConfigurationService({ ...DEFAULT_CONFIG, ...workspaceConfig }, diagnosticsAdapter);

  const logger: Logger = {
    debug: (message, context) => outputChannel?.appendLine(`[debug] ${message}${formatLogContext(context)}`),
    info: (message, context) => outputChannel?.appendLine(`[info] ${message}${formatLogContext(context)}`),
    warn: (message, context) => errorChannel.appendLine(`[warn] ${message}${formatLogContext(context)}`),
    error: (message, context) => errorChannel.appendLine(`[error] ${message}${formatLogContext(context)}`)
  };

  const reporter = new ErrorReporter(configurationService, logger);
  errorReporter = reporter;
  context.subscriptions.push(reporter);

  activationTelemetry = new Telemetry(outputChannel, !isDevelopment);
  activationTelemetry.start("activation");

  const gitignoreService = new GitignoreService();
  const workspaceManager = new WorkspaceManager(diagnostics, gitignoreService);
  await workspaceManager.initialize();
  hydrateRedactionOverride(context, workspaceManager);

  const performanceMonitor = new PerformanceMonitor(logger, configurationService);
  const gitProcessManager = new GitProcessManager(logger, errorReporter);
  const diagnosticService = new DiagnosticService(configurationService, performanceMonitor, errorReporter, gitProcessManager, logger);
  context.subscriptions.push({ dispose: () => void performanceMonitor.dispose() });

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

  const webviewPanelManager = new WebviewPanelManager(context.extensionUri);

  const dashboardViewProvider = new DashboardViewProvider(context.extensionUri, webviewPanelManager);
  const dashboardDisposable = vscode.window.registerWebviewViewProvider(
    DashboardViewProvider.viewType,
    dashboardViewProvider
  );
  context.subscriptions.push(dashboardDisposable, { dispose: () => dashboardViewProvider.dispose() });

  const buildPanelState = (): Record<string, unknown> => {
    const configSnapshot = configurationService.getConfig();
    const workspaceState = workspaceManager.getStateSnapshot();

    const configPayload = { ...configSnapshot, redactionOverride: workspaceState.redactionOverride };

    return {
      config: configPayload,
      diagnostics: diagnostics.getAll(),
      tree: workspaceState.tree,
      selection: workspaceState.selection,
      expandState: workspaceState.expandState,
      warnings: workspaceState.warnings,
      status: workspaceState.status,
      scanId: workspaceState.scanId,
      totalFiles: workspaceState.totalFiles,
      workspaceFolder: workspaceState.workspaceFolder,
      redactionOverride: workspaceState.redactionOverride
    } satisfies Record<string, unknown>;
  };

  const services: CommandServices = {
    diagnostics,
    gitignoreService,
    workspaceManager,
    webviewPanelManager,
    performanceMonitor,
    diagnosticService,
    configurationService,
    errorReporter: reporter,
    extensionUri: context.extensionUri
  };

  registerAllCommands(context, services);

  webviewPanelManager.setStateSnapshot(buildPanelState(), { emit: false });

  const manualCommands: Array<[string, (...args: unknown[]) => Promise<unknown> | unknown]> = [
    [
      COMMAND_MAP.WEBVIEW_TO_HOST.WEBVIEW_READY,
      async () => {
        if (!webviewPanelManager.tryRestoreState()) {
          webviewPanelManager.setStateSnapshot(buildPanelState());
          webviewPanelManager.tryRestoreState();
        }
      }
    ],
    ["codeIngest.openDashboardPanel", () => webviewPanelManager.createAndShowPanel()],
    [
      "codeIngest.showPerformanceDashboard",
      async () => {
        await vscode.commands.executeCommand("workbench.view.extension.codeIngest");
        await vscode.commands.executeCommand(`${DashboardViewProvider.viewType}.focus`);
      }
    ],
    ["codeIngest.flushErrorReports", async () => {
      await errorReporter?.flushErrors();
      await vscode.window.showInformationMessage("Code Ingest: Error reports flushed to output channel.");
    }],
    ["codeIngest.viewMetrics", async () => {
      outputChannel?.appendLine("[metrics] Dashboard and services operational.");
      await vscode.window.showInformationMessage(`Code Ingest metrics available in output channel.`);
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

  const configListener = vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration("codeIngest")) {
      outputChannel?.appendLine("[config] codeIngest configuration changed");
      webviewPanelManager.setStateSnapshot(buildPanelState());
    }
  });
  context.subscriptions.push(configListener);
  activationTelemetry.end("activation", { workspaceFolders: vscode.workspace.workspaceFolders?.length ?? 0 });
  const activationDuration = Math.round(performance.now() - activationStart);
  outputChannel.appendLine(`[activation] Code Ingest activated in ${activationDuration}ms`);

  context.subscriptions.push({ dispose: () => diagnostics.clear() });
  context.subscriptions.push({ dispose: () => void errorReporter?.flushErrors() });

  if (isDevelopment) {
    outputChannel.appendLine("[activation] Development mode detected; telemetry disabled.");
    const reloadWatcher = vscode.workspace.onDidSaveTextDocument((document) => {
      if (document.fileName.startsWith(context.extensionPath)) {
        outputChannel?.appendLine(`[reload] Detected change to ${document.fileName}`);
        void vscode.window.showInformationMessage(`Code Ingest: Detected change to ${document.fileName}`, "Reload Window").then((choice) => {
          if (choice === "Reload Window") {
            void vscode.commands.executeCommand("workbench.action.reloadWindow");
          }
        });
      }
    });
    context.subscriptions.push(reloadWatcher);
  }
}

export function deactivate(): void {
  outputChannel?.appendLine("[deactivation] Shutting down Code Ingest extension...");
  void errorReporter?.flushErrors();
  activationTelemetry?.dispose();
  // Resources registered with context.subscriptions are disposed automatically.
}
