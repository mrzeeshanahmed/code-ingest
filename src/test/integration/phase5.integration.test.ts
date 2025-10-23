import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, jest } from "@jest/globals";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";

import { COMMAND_MAP } from "../../commands/commandMap";
import { registerGenerateDigestCommand } from "../../commands/generateDigest";
import { registerIngestRemoteRepoCommand } from "../../commands/ingestRemoteRepo";
import { registerSelectionCommands, markSelectionHandlersReady, __testing as selectionTesting } from "../../commands/selectionCommands";
import type { CommandRegistrar, CommandServices } from "../../commands/types";
import { DEFAULT_CONFIG } from "../../config/constants";
import { ConfigurationService } from "../../services/configurationService";
import { Diagnostics } from "../../services/diagnostics";
import { GitignoreService } from "../../services/gitignoreService";
import { WorkspaceManager } from "../../services/workspaceManager";
import { DigestGenerator, type DigestResult } from "../../services/digestGenerator";
import * as formatterFactory from "../../formatters/factory";
import { cleanupTempWorkspaces, createTempWorkspace, mockWorkspaceFolders, seedWorkspaceFile } from "../support/integrationUtils";
import { configureWorkspaceEnvironment } from "../support/workspaceEnvironment";

jest.mock("../../services/githubService", () => {
  return {
    authenticate: jest.fn(async () => "token"),
    partialClone: jest.fn(async () => ({ tempDir: latestRemoteTempDir })),
    resolveRefToSha: jest.fn(async () => "deadbeefcafebabe")
  };
});

jest.mock("../../utils/procRedact", () => ({
  spawnGitPromise: jest.fn(async () => undefined)
}));

jest.mock("../../utils/digestFormatters", () => ({
  formatDigest: jest.fn(() => "REMOTE DIGEST PREVIEW\n\nFiles: 1"),
  buildDigestSummaryTable: jest.fn(() => ""),
  formatDigestSummary: jest.fn(() => "")
}));

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  let reject!: Deferred<T>["reject"];
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitForCondition<T>(evaluate: () => T | undefined, timeoutMs = 2000, stepMs = 20): Promise<T> {
  const start = Date.now();
  while (true) {
    const result = evaluate();
    if (result !== undefined) {
      return result;
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error("Condition not met within timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

let latestRemoteTempDir = "";

const withProgressMock = vscode.window.withProgress as unknown as jest.MockedFunction<typeof vscode.window.withProgress>;
const showWarningMessageMock = vscode.window.showWarningMessage as unknown as jest.MockedFunction<typeof vscode.window.showWarningMessage>;
const showInformationMessageMock = vscode.window.showInformationMessage as unknown as jest.MockedFunction<typeof vscode.window.showInformationMessage>;

type RecordingEvent =
  | { kind: "state"; operation: string; update: Parameters<CommandServices["webviewPanelManager"]["updateOperationState"]>[1]; emit?: boolean }
  | { kind: "progress"; operation: string; progressId: string; update: Parameters<CommandServices["webviewPanelManager"]["updateOperationProgress"]>[2]; emit?: boolean }
  | { kind: "clear"; progressId: string; emit?: boolean }
  | { kind: "command"; command: string; payload: unknown }
  | { kind: "snapshot"; state: Record<string, unknown> | undefined; emit?: boolean };

type ProgressEvent = Extract<RecordingEvent, { kind: "progress" }>;
type StateEvent = Extract<RecordingEvent, { kind: "state" }>;
type ClearEvent = Extract<RecordingEvent, { kind: "clear" }>;

const isProgressEvent = (event: RecordingEvent): event is ProgressEvent => event.kind === "progress";
const isStateEvent = (event: RecordingEvent): event is StateEvent => event.kind === "state";
const isClearEvent = (event: RecordingEvent): event is ClearEvent => event.kind === "clear";

class RecordingWebviewPanelManager {
  public readonly events: RecordingEvent[] = [];

  public createAndShowPanel = jest.fn(async () => undefined);

  public setStateSnapshot = (state: Record<string, unknown> | undefined, options?: { emit?: boolean }) => {
    const event: RecordingEvent = options?.emit === undefined
      ? { kind: "snapshot", state }
      : { kind: "snapshot", state, emit: options.emit };
    this.events.push(event);
  };

  public sendCommand = (command: string, payload: unknown) => {
    this.events.push({ kind: "command", command, payload });
  };

  public getStateSnapshot = jest.fn(() => ({}));

  public tryRestoreState = jest.fn(() => false);

  public updateOperationState: CommandServices["webviewPanelManager"]["updateOperationState"] = (operation, update, options) => {
    const event: RecordingEvent = options?.emit === undefined
      ? { kind: "state", operation, update }
      : { kind: "state", operation, update, emit: options.emit };
    this.events.push(event);
  };

  public updateOperationProgress: CommandServices["webviewPanelManager"]["updateOperationProgress"] = (operation, progressId, update, options) => {
    const event: RecordingEvent = options?.emit === undefined
      ? { kind: "progress", operation, progressId, update }
      : { kind: "progress", operation, progressId, update, emit: options.emit };
    this.events.push(event);
  };

  public clearOperationProgress: CommandServices["webviewPanelManager"]["clearOperationProgress"] = (progressId, options) => {
    const event: RecordingEvent = options?.emit === undefined
      ? { kind: "clear", progressId }
      : { kind: "clear", progressId, emit: options.emit };
    this.events.push(event);
  };
}

const REMOTE_REPO_URL = "https://github.com/acme/project";

function buildDigestResult(tokens: number, includedFiles: number, label: string): DigestResult {
  const generatedAt = new Date();
  return {
    content: {
      files: [],
      summary: {
        overview: {
          totalFiles: includedFiles,
          includedFiles,
          skippedFiles: 0,
          binaryFiles: 0,
          totalTokens: tokens
        },
        tableOfContents: [],
        notes: []
      },
      metadata: {
        generatedAt,
        workspaceRoot: `/workspace/${label}`,
        totalFiles: includedFiles,
        includedFiles,
        skippedFiles: 0,
        binaryFiles: 0,
        tokenEstimate: tokens,
        processingTime: 1,
        redactionApplied: false,
        generatorVersion: "test"
      }
    },
    statistics: {
      filesProcessed: includedFiles,
      totalTokens: tokens,
      processingTime: 1,
      warnings: [],
      errors: []
    },
    redactionApplied: false,
    truncationApplied: false
  } satisfies DigestResult;
}

const ORIGINAL_READ_DIRECTORY = (vscode.workspace.fs as { readDirectory?: typeof vscode.workspace.fs.readDirectory }).readDirectory;
const ORIGINAL_STAT = (vscode.workspace.fs as { stat?: typeof vscode.workspace.fs.stat }).stat;
const ORIGINAL_READ_FILE = (vscode.workspace.fs as { readFile?: typeof vscode.workspace.fs.readFile }).readFile;

function ensureVsCodeFileType(): void {
  const vsAny = vscode as unknown as { FileType?: typeof vscode.FileType };
  if (!vsAny.FileType) {
    vsAny.FileType = {
      Unknown: 0,
      File: 1,
      Directory: 2,
      SymbolicLink: 64
    } as typeof vscode.FileType;
  }
}

function bridgeVsCodeFs(): void {
  ensureVsCodeFileType();
  const fileType = (vscode as unknown as { FileType: typeof vscode.FileType }).FileType;

  (vscode.workspace.fs as { readDirectory?: typeof vscode.workspace.fs.readDirectory }).readDirectory = jest.fn(async (uri: vscode.Uri) => {
    const entries = await fs.readdir(uri.fsPath, { withFileTypes: true });
    return entries.map((entry) => [
      entry.name,
      entry.isDirectory() ? fileType.Directory : entry.isSymbolicLink() ? fileType.SymbolicLink : fileType.File
    ]) as [string, vscode.FileType][];
  });

  (vscode.workspace.fs as { stat?: typeof vscode.workspace.fs.stat }).stat = jest.fn(async (uri: vscode.Uri) => {
    const stats = await fs.stat(uri.fsPath);
    return {
      type: stats.isDirectory() ? fileType.Directory : stats.isSymbolicLink() ? fileType.SymbolicLink : fileType.File,
      ctime: stats.ctimeMs,
      mtime: stats.mtimeMs,
      size: stats.size
    } satisfies vscode.FileStat;
  });

  (vscode.workspace.fs as { readFile?: typeof vscode.workspace.fs.readFile }).readFile = jest.fn(async (uri: vscode.Uri) => {
    const buffer = await fs.readFile(uri.fsPath);
    return new Uint8Array(buffer);
  });
}

describe("Phase 5 integration", () => {
  let workspaceRoot: string;
  let disposeWorkspaceFolders: () => void;
  let diagnostics: Diagnostics;
  let gitignoreService: GitignoreService;
  let workspaceManager: WorkspaceManager;
  let configurationService: ConfigurationService;
  let webviewPanelManager: RecordingWebviewPanelManager;
  let services: CommandServices;
  let remoteDigestDeferred: Deferred<DigestResult>;
  let remoteDigestResult: DigestResult;
  let localDigestResult: DigestResult;

  beforeAll(() => {
    bridgeVsCodeFs();
  });

  afterAll(() => {
    if (ORIGINAL_READ_DIRECTORY) {
      (vscode.workspace.fs as { readDirectory?: typeof vscode.workspace.fs.readDirectory }).readDirectory = ORIGINAL_READ_DIRECTORY;
    }
    if (ORIGINAL_STAT) {
      (vscode.workspace.fs as { stat?: typeof vscode.workspace.fs.stat }).stat = ORIGINAL_STAT;
    }
    if (ORIGINAL_READ_FILE) {
      (vscode.workspace.fs as { readFile?: typeof vscode.workspace.fs.readFile }).readFile = ORIGINAL_READ_FILE;
    }
    cleanupTempWorkspaces();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    selectionTesting.resetReadiness();

    workspaceRoot = createTempWorkspace("code-ingest-phase5-");
    configureWorkspaceEnvironment(workspaceRoot);
    disposeWorkspaceFolders = mockWorkspaceFolders(workspaceRoot);
    await seedWorkspaceFile(workspaceRoot, path.join("src", "index.ts"), "export const answer = 42;\n");
    await seedWorkspaceFile(workspaceRoot, path.join("docs", "readme.md"), "# Docs\n");

    latestRemoteTempDir = path.join(workspaceRoot, ".remote-clone");
    await fs.mkdir(path.join(latestRemoteTempDir, "pkg"), { recursive: true });
    await fs.writeFile(path.join(latestRemoteTempDir, "pkg", "remote.ts"), "export const remote = true;\n", "utf8");

    diagnostics = new Diagnostics();
    gitignoreService = new GitignoreService();
    workspaceManager = new WorkspaceManager(diagnostics, gitignoreService);
    await workspaceManager.initialize();

    configurationService = new ConfigurationService(
      {
        ...DEFAULT_CONFIG,
        workspaceRoot,
        include: ["**/*"],
        exclude: []
      },
      {
        addError: jest.fn(),
        addWarning: jest.fn()
      }
    );
    configurationService.loadConfig();

    webviewPanelManager = new RecordingWebviewPanelManager();

    const outputWriter = {
      resolveConfiguredTarget: jest.fn(() => ({ type: "file", path: path.join(workspaceRoot, "digest.md") })),
      writeOutput: jest.fn(async (options?: { progressCallback?: (progress: { phase: string; bytesWritten: number; totalBytes: number; currentOperation?: string }) => void }) => {
        options?.progressCallback?.({ phase: "preparing", bytesWritten: 0, totalBytes: 100, currentOperation: "Preparing digest output" });
        options?.progressCallback?.({ phase: "writing", bytesWritten: 50, totalBytes: 100, currentOperation: "Writing digest file…" });
        options?.progressCallback?.({ phase: "complete", bytesWritten: 100, totalBytes: 100, currentOperation: "Digest file opened" });
        return {
          success: true,
          uri: vscode.Uri.file(path.join(workspaceRoot, "digest.md")),
          bytesWritten: 100,
          writeTime: 5,
          target: { type: "file", path: path.join(workspaceRoot, "digest.md") }
        };
      }),
      writeStream: jest.fn()
    };

    services = {
      diagnostics,
      gitignoreService,
      workspaceManager,
      webviewPanelManager: webviewPanelManager as unknown as CommandServices["webviewPanelManager"],
      performanceMonitor: {} as CommandServices["performanceMonitor"],
      diagnosticService: {} as CommandServices["diagnosticService"],
      configurationService,
      errorReporter: { report: jest.fn() } as unknown as CommandServices["errorReporter"],
      extensionUri: vscode.Uri.file(workspaceRoot),
      outputWriter: outputWriter as unknown as CommandServices["outputWriter"]
    };

    remoteDigestDeferred = createDeferred<DigestResult>();
    remoteDigestResult = buildDigestResult(24, 3, "remote");
    localDigestResult = buildDigestResult(18, 2, "local");

    const digestSpy = jest.spyOn(DigestGenerator.prototype, "generateDigest");
    digestSpy.mockImplementation(async () => localDigestResult);
    digestSpy.mockImplementationOnce(() => remoteDigestDeferred.promise);

    jest.spyOn(formatterFactory, "createFormatter").mockReturnValue({
      finalize: jest.fn(() => "formatted"),
      supportsStreaming: jest.fn(() => false),
      streamSectionsAsync: jest.fn()
    } as unknown as ReturnType<typeof formatterFactory.createFormatter>);

    withProgressMock.mockImplementation(async (_options, task) => {
      const source = new vscode.CancellationTokenSource();
      try {
        return await task({ report: jest.fn() }, source.token);
      } finally {
        source.dispose();
      }
    });
    showWarningMessageMock.mockResolvedValue(undefined);
    showInformationMessageMock.mockResolvedValue(undefined);

    const context = { subscriptions: [] } as unknown as vscode.ExtensionContext;
    const registrar: CommandRegistrar = (commandId, handler) => vscode.commands.registerCommand(commandId, handler);

    registerSelectionCommands(context, services, registrar);
    registerGenerateDigestCommand(context, services, registrar);
    registerIngestRemoteRepoCommand(context, services, registrar);
    markSelectionHandlersReady();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    disposeWorkspaceFolders();
  });

  it("serializes overlapping operations while isolating progress channels", async () => {
    const commandRegistry = vscode.commands as unknown as {
      __getRegisteredCommands(): Map<string, (...args: unknown[]) => unknown>;
    };
    const handlers = commandRegistry.__getRegisteredCommands();
    const remoteHandler = handlers.get(COMMAND_MAP.WEBVIEW_TO_HOST.LOAD_REMOTE_REPO);
    const selectAllHandler = handlers.get(COMMAND_MAP.WEBVIEW_TO_HOST.SELECT_ALL);
    const digestHandler = handlers.get(COMMAND_MAP.WEBVIEW_TO_HOST.GENERATE_DIGEST);

    if (!remoteHandler || !selectAllHandler || !digestHandler) {
      throw new Error("Required command handler not registered");
    }

    const remotePromise = Promise.resolve(remoteHandler({ repoUrl: REMOTE_REPO_URL, ref: "main" }));

    const remoteProgressEvent = await waitForCondition(() =>
      webviewPanelManager.events.find((event): event is ProgressEvent => isProgressEvent(event) && event.update?.phase === "ingest")
    );
    const remoteProgressId = remoteProgressEvent.progressId;
    expect(remoteProgressId).toMatch(/^remote-/);

    const selectionOutcome = await Promise.resolve(selectAllHandler());
    expect(selectionOutcome).toMatchObject({ ok: true });
    const diagnosticMessages = diagnostics.getAll();
    expect(diagnosticMessages.some((message) => message.includes("Selected"))).toBe(true);

    const digestPromise = Promise.resolve(digestHandler({ selectedFiles: ["src/index.ts"] }));

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(webviewPanelManager.events.filter(isClearEvent).length).toBe(0);

    remoteDigestDeferred.resolve(remoteDigestResult);
    await remotePromise;

    const remoteCleared = await waitForCondition(() =>
      webviewPanelManager.events.find((event): event is ClearEvent => isClearEvent(event) && event.progressId === remoteProgressId)
    );
    expect(remoteCleared).toBeDefined();

    await digestPromise;

    const progressEvents = webviewPanelManager.events.filter(isProgressEvent);
    const progressIds = progressEvents.map((event) => event.progressId);
    const digestProgressId = progressIds.find((id) => id !== remoteProgressId);
    expect(digestProgressId).toBeDefined();

    const clearedIds = webviewPanelManager.events.filter(isClearEvent).map((event) => event.progressId);
    expect(clearedIds).toEqual(expect.arrayContaining([remoteProgressId, digestProgressId!]));

    const stateMessages = webviewPanelManager.events
      .filter(isStateEvent)
      .map((event) => event.update?.message ?? "");
    expect(stateMessages.some((message) => message.includes("remote"))).toBe(true);
    expect(stateMessages.some((message) => message.includes("Digest ready"))).toBe(true);

    const finalDiagnostics = diagnostics.getAll();
    expect(finalDiagnostics.some((message) => message.includes("Starting remote ingestion"))).toBe(true);
    expect(finalDiagnostics.some((message) => message.includes("Digest generated"))).toBe(true);
  });
});
