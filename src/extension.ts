import { performance } from "node:perf_hooks";
import * as vscode from "vscode";
import { registerAllCommands, markSelectionHandlersReady } from "./commands";
import { hydrateRedactionOverride } from "./commands/redactionCommands";
import type { CommandServices } from "./commands/types";
import { COMMAND_MAP } from "./commands/commandMap";
import { DashboardViewProvider } from "./providers/dashboardViewProvider";
import { CodeIngestPanel } from "./providers/codeIngestPanel";
import { loadCommandValidator } from "./providers/commandValidator";
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
import { wrapError, type ErrorWithMetadata } from "./utils/errorHandling";
import * as path from "node:path";
import * as fsPromises from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { spawn } from "node:child_process";
import { OutputWriter } from "./services/outputWriter";

let errorReporter: ErrorReporter | undefined;
let outputChannel: vscode.OutputChannel | undefined;
let activationTelemetry: Telemetry | undefined;

const WEBVIEW_COMMAND_IDS = new Set<string>(Object.values(COMMAND_MAP.WEBVIEW_TO_HOST));

const REQUIRED_WEBVIEW_ASSETS = ["index.html", "main.js", "styles.css", "store.js"] as const;

type EnsureWebviewResourcesFn = () => Promise<void>;

interface ShowErrorPayload {
  title: string;
  message: string;
  runId?: string;
}

function extractShowErrorPayload(error: unknown): ShowErrorPayload | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  const details = (error as { showError?: unknown }).showError;
  if (!details || typeof details !== "object") {
    return undefined;
  }

  const title = (details as { title?: unknown }).title;
  const message = (details as { message?: unknown }).message;
  const runIdValue = (details as { runId?: unknown }).runId;
  if (typeof title !== "string" || typeof message !== "string") {
    return undefined;
  }

  const payload: ShowErrorPayload = {
    title,
    message
  };

  if (typeof runIdValue === "string" && runIdValue) {
    payload.runId = runIdValue;
  }

  return payload;
}

function createWebviewResourceEnsurer(
  extensionPath: string,
  logChannel: vscode.OutputChannel,
  errorChannel: vscode.OutputChannel
): EnsureWebviewResourcesFn {
  let inFlight: Promise<void> | undefined;

  const logLines = (lines: string[], target: vscode.OutputChannel, prefix: string): void => {
    lines.filter(Boolean).forEach((line) => target.appendLine(`${prefix}${line}`));
  };

  const runCopyScript = async (): Promise<void> => {
    const script = path.join(extensionPath, "scripts", "copyWebviewResources.js");
    logChannel.appendLine("[activation] Running webview asset copy script...");

    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [script], {
        cwd: extensionPath,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env }
      });

      child.stdout?.on("data", (chunk) => {
        const lines = chunk.toString().split(/\r?\n/);
        logLines(lines, logChannel, "[copy-webview] ");
      });

      child.stderr?.on("data", (chunk) => {
        const lines = chunk.toString().split(/\r?\n/);
        logLines(lines, errorChannel, "[copy-webview] ");
      });

      child.on("error", (error) => {
        reject(error);
      });

      child.on("close", (code) => {
        if (code === 0) {
          resolve();
          return;
        }
        reject(new Error(`Webview asset copy script exited with code ${code ?? "unknown"}`));
      });
    });
  };

  const getMissingAssets = async (): Promise<string[]> => {
    const destination = path.join(extensionPath, "out", "resources", "webview");
    const missing: string[] = [];

    await Promise.all(
      REQUIRED_WEBVIEW_ASSETS.map(async (asset) => {
        const assetPath = path.join(destination, asset);
        try {
          await fsPromises.access(assetPath, fsConstants.R_OK);
        } catch (error) {
          const errno = (error as NodeJS.ErrnoException)?.code;
          if (errno !== "ENOENT") {
            errorChannel.appendLine(
              `[activation] Failed to access required webview asset ${asset}: ${(error as Error).message}`
            );
          }
          missing.push(asset);
        }
      })
    );

    return missing;
  };

  const ensure = async (): Promise<void> => {
    const missingBefore = await getMissingAssets();
    if (missingBefore.length === 0) {
      logChannel.appendLine("[activation] Webview assets verified.");
      return;
    }

    logChannel.appendLine(
      `[activation] Required webview asset(s) missing: ${missingBefore.join(", ")}. Attempting to regenerate...`
    );

    try {
      await runCopyScript();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errorChannel.appendLine(`[activation] Failed to regenerate webview assets: ${message}`);
      throw error instanceof Error ? error : new Error(message);
    }

    const missingAfter = await getMissingAssets();
    if (missingAfter.length > 0) {
      const message = `Webview assets are still missing after regeneration: ${missingAfter.join(", ")}`;
      errorChannel.appendLine(`[activation] ${message}`);
      throw new Error(message);
    }

    logChannel.appendLine("[activation] Webview assets regenerated successfully.");
  };

  return () => {
    if (!inFlight) {
      inFlight = ensure().catch((error) => {
        inFlight = undefined;
        throw error;
      });
    }
    return inFlight;
  };
}

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
  errorChannel: ErrorReporter,
  services?: CommandServices
): vscode.Disposable {
  const wrapped = async (...args: unknown[]): Promise<unknown> => {
    outputChannel?.appendLine(`[command] ${commandId} invoked`);
    const start = performance.now();
    let commandArgs = args;

    if (WEBVIEW_COMMAND_IDS.has(commandId)) {
      try {
        const validator = await loadCommandValidator();
        const validation = validator?.(commandId, args[0]) ?? { ok: true, value: args[0] };
        if (!validation || validation.ok !== true) {
          const reason = validation?.reason ?? "validation_failed";
          const message = `Command ${commandId} rejected: ${reason}`;
          outputChannel?.appendLine(`[command] ${message}`);
          if (services) {
            services.diagnostics.add(message);
            services.webviewPanelManager.sendCommand(COMMAND_MAP.HOST_TO_WEBVIEW.SHOW_ERROR, {
              title: "Invalid request",
              message
            });
          }
          return { ok: false, reason };
        }

        if (validation.value !== undefined && (validation.value !== args[0] || args.length > 0)) {
          const nextArgs = [...args];
          nextArgs[0] = validation.value;
          commandArgs = nextArgs;
        }
      } catch (validationError) {
        const validationMessage = validationError instanceof Error ? validationError.message : String(validationError);
        outputChannel?.appendLine(`[command] Failed to validate payload for ${commandId}: ${validationMessage}`);
      }
    }

    try {
      const result = await handler(...commandArgs);
      outputChannel?.appendLine(`[command] ${commandId} completed in ${Math.round(performance.now() - start)}ms`);
      return result;
    } catch (error) {
      const wrappedError = wrapError(error, { commandId });
      const errorWithMetadata = wrappedError as ErrorWithMetadata;
      const existingMetadata = (errorWithMetadata.metadata ?? {}) as Record<string, unknown>;
      const reportMetadata: Record<string, unknown> = { ...existingMetadata };

      if (typeof reportMetadata.commandId !== "string") {
        reportMetadata.commandId = commandId;
      }
      if (typeof reportMetadata.stage !== "string") {
        reportMetadata.stage = "command";
      }
      if (typeof reportMetadata.runId !== "string") {
        const runIdCandidate =
          typeof (wrappedError as { runId?: unknown }).runId === "string"
            ? (wrappedError as { runId?: string }).runId
            : undefined;
        if (runIdCandidate) {
          reportMetadata.runId = runIdCandidate;
        }
      }
      (errorWithMetadata as { metadata: Record<string, unknown> }).metadata = reportMetadata;

      errorChannel.report(wrappedError, {
        command: commandId,
        source: "commandWrapper",
        metadata: reportMetadata
      });

      const defaultShowError: ShowErrorPayload | undefined = wrappedError.message
        ? { title: "Command failed", message: wrappedError.message }
        : undefined;
      const explicitShowError = extractShowErrorPayload(wrappedError) ?? defaultShowError;

      const wasHandled = Boolean((wrappedError as { handledByHost?: boolean }).handledByHost);
      if (!wasHandled && services && WEBVIEW_COMMAND_IDS.has(commandId) && explicitShowError) {
        const payload: ShowErrorPayload = {
          title: explicitShowError.title,
          message: explicitShowError.message
        };
        const payloadRunId =
          explicitShowError.runId ?? (typeof reportMetadata.runId === "string" ? (reportMetadata.runId as string) : undefined);
        if (payloadRunId) {
          payload.runId = payloadRunId;
          reportMetadata.runId = payloadRunId;
          (errorWithMetadata as { metadata: Record<string, unknown> }).metadata = reportMetadata;
        }
        services.webviewPanelManager.sendCommand(COMMAND_MAP.HOST_TO_WEBVIEW.SHOW_ERROR, payload);
        (wrappedError as { handledByHost?: boolean }).handledByHost = true;
      }

      const handledByHost = Boolean((wrappedError as { handledByHost?: boolean }).handledByHost);

      if (!handledByHost) {
        const actions = ["Details", "Report"] as const;
        const selection = await vscode.window.showErrorMessage(
          `Code Ingest: Command failed (${commandId}). ${wrappedError.message}`,
          ...actions
        );

        if (selection === "Details") {
          outputChannel?.show(true);
        } else if (selection === "Report") {
          const payload = {
            command: commandId,
            message: wrappedError.message,
            stack: wrappedError.stack,
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
      } else {
        outputChannel?.appendLine(
          `[command] ${commandId} rejected by handler: ${wrappedError.message || "handled without message"}`
        );
      }
      throw wrappedError;
    }
  };

  const disposable = vscode.commands.registerCommand(commandId, wrapped);
  context.subscriptions.push(disposable);
  return disposable;
}

async function verifyWebviewCommandRegistration(errorChannel: vscode.OutputChannel): Promise<void> {
  const expected = new Set(Object.values(COMMAND_MAP.WEBVIEW_TO_HOST));
  const available = new Set(await vscode.commands.getCommands(true));
  const missing = Array.from(expected).filter((commandId) => !available.has(commandId));

  if (missing.length > 0) {
    const message = `Missing host command registrations: ${missing.join(", ")}`;
    errorChannel.appendLine(`[activation] ${message}`);
    throw new Error(message);
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const activationStart = performance.now();
  const isDevelopment = context.extensionMode !== vscode.ExtensionMode.Production;

  outputChannel = vscode.window.createOutputChannel("Code Ingest");
  const errorChannel = vscode.window.createOutputChannel("Code Ingest Errors");
  CodeIngestPanel.registerHandlerErrorChannel(errorChannel);
  context.subscriptions.push(outputChannel, errorChannel);
  outputChannel.appendLine("[activation] Starting Code Ingest activation sequence...");

  const ensureWebviewResourcesReady = createWebviewResourceEnsurer(
    context.extensionPath,
    outputChannel,
    errorChannel
  );

  try {
    await ensureWebviewResourcesReady();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    errorChannel.appendLine(`[activation] Aborting activation: ${message}`);
    const selection = await vscode.window.showErrorMessage(
      `Code Ingest failed to prepare required webview assets: ${message}`,
      "View Logs"
    );
    if (selection === "View Logs") {
      errorChannel.show(true);
    }
    throw error;
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
  const workspaceManager = new WorkspaceManager(diagnostics, gitignoreService, {
    loadConfiguration: () => configurationService.getConfig()
  });
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

  const webviewPanelManager = new WebviewPanelManager(
    context.extensionUri,
    ensureWebviewResourcesReady,
    diagnostics,
    performanceMonitor
  );
  const outputWriter = new OutputWriter({
    window: vscode.window,
    workspace: vscode.workspace,
    clipboard: vscode.env.clipboard,
    errorReporter: reporter,
    errorChannel
  });

  const dashboardViewProvider = new DashboardViewProvider(
    context.extensionUri,
    webviewPanelManager,
    ensureWebviewResourcesReady,
    reporter
  );
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
    extensionUri: context.extensionUri,
    outputWriter
  };

  registerAllCommands(context, services, (commandId, handler) =>
    createCommandWrapper(context, commandId, handler, reporter, services)
  );

  webviewPanelManager.setStateSnapshot(buildPanelState(), { emit: false });

  const manualCommands: Array<[string, (...args: unknown[]) => Promise<unknown> | unknown]> = [
    [
      COMMAND_MAP.WEBVIEW_TO_HOST.WEBVIEW_READY,
      async () => {
        CodeIngestPanel.notifyWebviewReady();
        markSelectionHandlersReady();
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
    ["codeIngest.invertSelection", async () => {
      await vscode.window.showInformationMessage("Code Ingest: Invert selection is not yet implemented.");
    }]
  ];

  manualCommands.forEach(([id, handler]) => {
    createCommandWrapper(context, id, handler, errorReporter!);
  });

  await verifyWebviewCommandRegistration(errorChannel);

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

export const __testing = {
  createCommandWrapper
};
