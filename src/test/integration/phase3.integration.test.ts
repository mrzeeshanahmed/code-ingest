import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, jest } from "@jest/globals";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";

import { registerSelectionCommands, markSelectionHandlersReady, __testing as selectionTesting } from "../../commands/selectionCommands";
import { registerGenerateDigestCommand } from "../../commands/generateDigest";
import type { CommandRegistrar, CommandServices } from "../../commands/types";
import { COMMAND_MAP } from "../../commands/commandMap";
import { Diagnostics } from "../../services/diagnostics";
import { GitignoreService } from "../../services/gitignoreService";
import { WorkspaceManager } from "../../services/workspaceManager";
import { ConfigurationService } from "../../services/configurationService";
import { DEFAULT_CONFIG } from "../../config/constants";
import { DigestGenerator, type DigestResult } from "../../services/digestGenerator";
import type { OutputWriter, OutputTarget, WriteResult, WriteOptions } from "../../services/outputWriter";
import { configureWorkspaceEnvironment, resetWorkspaceEnvironment } from "../support/workspaceEnvironment";
import { createTempWorkspace, cleanupTempWorkspaces, mockWorkspaceFolders, seedWorkspaceFile } from "../support/integrationUtils";

const ORIGINAL_READ_DIRECTORY = (vscode.workspace.fs as { readDirectory?: typeof vscode.workspace.fs.readDirectory }).readDirectory;
const ORIGINAL_STAT = (vscode.workspace.fs as { stat?: typeof vscode.workspace.fs.stat }).stat;
const ORIGINAL_READ_FILE = (vscode.workspace.fs as { readFile?: typeof vscode.workspace.fs.readFile }).readFile;

const ensureFileType = () => {
  const vsAny = vscode as unknown as { FileType?: typeof vscode.FileType };
  if (!vsAny.FileType) {
    const fallback = {
      Unknown: 0,
      File: 1,
      Directory: 2,
      SymbolicLink: 64
    } as const;
    vsAny.FileType = fallback as unknown as typeof vscode.FileType;
  }
};

const wireNodeFileSystemBridges = () => {
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
};

describe("Phase 3 integration", () => {
  let workspaceRoot: string;
  let disposeWorkspaceFolders: () => void;
  let diagnostics: Diagnostics;
  let gitignoreService: GitignoreService;
  let workspaceManager: WorkspaceManager;
  let configurationService: ConfigurationService;
  let selectAllSpy: jest.SpiedFunction<WorkspaceManager["selectAll"]>;
  let digestSpy: jest.SpiedFunction<DigestGenerator["generateDigest"]>;
  let outputWriterResolveConfiguredTarget: jest.Mock;
  let outputWriterWriteOutput: jest.Mock;
  let outputWriter: OutputWriter;
  const webviewPanelManager = {
    setStateSnapshot: jest.fn(),
    sendCommand: jest.fn(),
    tryRestoreState: jest.fn(),
    createAndShowPanel: jest.fn().mockImplementation(async () => undefined)
  } as unknown as CommandServices["webviewPanelManager"];

  beforeAll(() => {
    ensureFileType();
    wireNodeFileSystemBridges();
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
    selectionTesting.resetReadiness();
    jest.clearAllMocks();
    workspaceRoot = createTempWorkspace("code-ingest-phase3-");
    configureWorkspaceEnvironment(workspaceRoot);
    disposeWorkspaceFolders = mockWorkspaceFolders(workspaceRoot);
    await seedWorkspaceFile(workspaceRoot, path.join("src", "index.ts"), "export const value = 1;\n");

    diagnostics = new Diagnostics();
    gitignoreService = new GitignoreService();
    workspaceManager = new WorkspaceManager(diagnostics, gitignoreService);
    await workspaceManager.initialize();

    configurationService = new ConfigurationService({
      ...DEFAULT_CONFIG,
      workspaceRoot,
      include: ["**/*"],
      exclude: []
    }, {
      addError: jest.fn(),
      addWarning: jest.fn()
    });
    configurationService.loadConfig();

    const mockDigest: DigestResult = {
      content: {
        files: [],
        summary: {
          overview: {
            totalFiles: 1,
            includedFiles: 1,
            skippedFiles: 0,
            binaryFiles: 0,
            totalTokens: 12
          },
          tableOfContents: [],
          notes: []
        },
        metadata: {
          generatedAt: new Date(),
          workspaceRoot,
          totalFiles: 1,
          includedFiles: 1,
          skippedFiles: 0,
          binaryFiles: 0,
          tokenEstimate: 12,
          processingTime: 1,
          redactionApplied: false,
          generatorVersion: "test"
        }
      },
      statistics: {
        filesProcessed: 1,
        totalTokens: 12,
        processingTime: 1,
        warnings: [],
        errors: []
      },
      redactionApplied: false,
      truncationApplied: false
    } satisfies DigestResult;

    digestSpy = jest.spyOn(DigestGenerator.prototype, "generateDigest").mockResolvedValue(mockDigest);
    selectAllSpy = jest.spyOn(workspaceManager, "selectAll");

    outputWriterResolveConfiguredTarget = jest.fn(() => ({
      type: "file",
      path: path.join(workspaceRoot, "code-ingest.md")
    }) satisfies OutputTarget);
    outputWriterWriteOutput = jest.fn(async () => ({
      success: true,
      bytesWritten: 256,
      writeTime: 5,
      target: { type: "file", path: path.join(workspaceRoot, "code-ingest.md") },
      uri: vscode.Uri.file(path.join(workspaceRoot, "code-ingest.md"))
    }) satisfies WriteResult);
    outputWriter = {
      resolveConfiguredTarget: outputWriterResolveConfiguredTarget as unknown as OutputWriter["resolveConfiguredTarget"],
      writeOutput: outputWriterWriteOutput as unknown as OutputWriter["writeOutput"]
    } as OutputWriter;

    const errorReporter = { report: jest.fn(), dispose: jest.fn() };

    const services: CommandServices = {
      diagnostics,
      gitignoreService,
      workspaceManager,
      webviewPanelManager,
      performanceMonitor: {} as CommandServices["performanceMonitor"],
      diagnosticService: {} as CommandServices["diagnosticService"],
      configurationService,
      errorReporter: errorReporter as unknown as CommandServices["errorReporter"],
      extensionUri: vscode.Uri.file(workspaceRoot),
      outputWriter
    };

    const context = { subscriptions: [] } as unknown as vscode.ExtensionContext;
    const registrar: CommandRegistrar = (id, handler) => vscode.commands.registerCommand(id, handler);

    registerSelectionCommands(context, services, registrar);
    registerGenerateDigestCommand(context, services, registrar);
  });

  afterEach(() => {
    digestSpy.mockRestore();
    selectAllSpy.mockRestore();
    disposeWorkspaceFolders?.();
    resetWorkspaceEnvironment();
  });

  it("runs the digest pipeline after select-all without triggering empty-selection errors", async () => {
    markSelectionHandlersReady();

    await expect(vscode.commands.executeCommand(COMMAND_MAP.WEBVIEW_TO_HOST.SELECT_ALL)).resolves.toBeDefined();
    expect(workspaceManager.getSelection().length).toBeGreaterThan(0);

    await expect(vscode.commands.executeCommand(COMMAND_MAP.WEBVIEW_TO_HOST.GENERATE_DIGEST, {})).resolves.toBeUndefined();

    const showErrorCalls = (webviewPanelManager.sendCommand as unknown as jest.Mock).mock.calls.filter((call) => call[0] === COMMAND_MAP.HOST_TO_WEBVIEW.SHOW_ERROR);
    const emptySelectionErrorRaised = showErrorCalls.some(([, payload]) => {
      const candidate = payload as { message?: string } | undefined;
      return typeof candidate?.message === "string" && candidate.message.includes("No files selected");
    });

    expect(emptySelectionErrorRaised).toBe(false);
    expect(digestSpy).toHaveBeenCalledTimes(1);

    const digestCall = digestSpy.mock.calls[0]?.[0];
    const selectionCount = workspaceManager.getSelection().length;
    expect(Array.isArray(digestCall?.selectedFiles) ? digestCall.selectedFiles.length : 0).toBe(selectionCount);

    const snapshotCalls = (webviewPanelManager.setStateSnapshot as unknown as jest.Mock).mock.calls;
    const finalSnapshot = snapshotCalls[snapshotCalls.length - 1]?.[0] as { preview?: { metadata?: { totalFiles?: number } }; lastDigest?: { totalFiles?: number } } | undefined;
    expect(finalSnapshot?.lastDigest?.totalFiles).toBe(selectionCount);
    if (typeof finalSnapshot?.preview?.metadata?.totalFiles === "number") {
      expect(finalSnapshot.preview.metadata.totalFiles).toBe(selectionCount);
    }
  });

  it("waits for in-flight select-all before generating a digest", async () => {
    markSelectionHandlersReady();

    const originalSelectAll = workspaceManager.selectAll.bind(workspaceManager);
    let releaseSelectAll: (() => void) | undefined;
    selectAllSpy.mockImplementationOnce(async (onProgress) => {
      await new Promise<void>((resolve) => {
        releaseSelectAll = resolve;
      });
      return originalSelectAll(onProgress);
    });

    const selectAllPromise = vscode.commands.executeCommand(COMMAND_MAP.WEBVIEW_TO_HOST.SELECT_ALL);
    await new Promise((resolve) => setImmediate(resolve));

    const digestPromise = vscode.commands.executeCommand(COMMAND_MAP.WEBVIEW_TO_HOST.GENERATE_DIGEST, {});
    await new Promise((resolve) => setImmediate(resolve));

    expect(typeof releaseSelectAll).toBe("function");
    releaseSelectAll?.();

    await expect(selectAllPromise).resolves.toBeDefined();
    await expect(digestPromise).resolves.toBeUndefined();

    const selectionCount = workspaceManager.getSelection().length;
    expect(selectionCount).toBeGreaterThan(0);

    const showErrorCalls = (webviewPanelManager.sendCommand as unknown as jest.Mock).mock.calls.filter((call) => call[0] === COMMAND_MAP.HOST_TO_WEBVIEW.SHOW_ERROR);
    const emptySelectionErrorRaised = showErrorCalls.some(([, payload]) => {
      const candidate = payload as { message?: string } | undefined;
      return typeof candidate?.message === "string" && candidate.message.includes("No files selected");
    });

    expect(emptySelectionErrorRaised).toBe(false);
    expect(digestSpy).toHaveBeenCalledTimes(1);

    const digestCall = digestSpy.mock.calls[0]?.[0];
    expect(Array.isArray(digestCall?.selectedFiles) ? digestCall.selectedFiles.length : 0).toBe(selectionCount);

    const snapshotCalls = (webviewPanelManager.setStateSnapshot as unknown as jest.Mock).mock.calls;
    const finalSnapshot = snapshotCalls[snapshotCalls.length - 1]?.[0] as { preview?: { metadata?: { totalFiles?: number } }; lastDigest?: { totalFiles?: number } } | undefined;
    expect(finalSnapshot?.lastDigest?.totalFiles).toBe(selectionCount);
    if (typeof finalSnapshot?.preview?.metadata?.totalFiles === "number") {
      expect(finalSnapshot.preview.metadata.totalFiles).toBe(selectionCount);
    }
  });

  it("captures the empty preview emitted for editor targets", async () => {
    markSelectionHandlersReady();

    outputWriterResolveConfiguredTarget.mockReturnValue({
      type: "editor",
      title: "Digest Preview"
    } satisfies OutputTarget);

    outputWriterWriteOutput.mockImplementation(async (options) => {
      const opts = options as WriteOptions | undefined;
      opts?.progressCallback?.({
        phase: "preparing",
        bytesWritten: 0,
        totalBytes: 128,
        currentOperation: "Preparing editor buffer"
      });
      opts?.progressCallback?.({
        phase: "writing",
        bytesWritten: 64,
        totalBytes: 128,
        currentOperation: "Populating editor"
      });
      opts?.progressCallback?.({
        phase: "complete",
        bytesWritten: 128,
        totalBytes: 128,
        currentOperation: "Editor ready"
      });
      return {
        success: true,
        bytesWritten: 128,
        writeTime: 4,
        target: { type: "editor", title: "Digest Preview" },
        uri: undefined
      } satisfies WriteResult;
    });

    await expect(vscode.commands.executeCommand(COMMAND_MAP.WEBVIEW_TO_HOST.SELECT_ALL)).resolves.toBeDefined();
    (webviewPanelManager.setStateSnapshot as jest.Mock).mockClear();

    await expect(vscode.commands.executeCommand(COMMAND_MAP.WEBVIEW_TO_HOST.GENERATE_DIGEST, {})).resolves.toBeUndefined();

    const snapshotCalls = (webviewPanelManager.setStateSnapshot as jest.Mock).mock.calls as Array<[Record<string, unknown>]>;
    const previewSnapshot = [...snapshotCalls]
      .map(([state]) => state as { preview?: { content?: unknown } })
      .reverse()
      .find((state) => state.preview !== undefined);

    const previewContent = typeof previewSnapshot?.preview?.content === "string" ? previewSnapshot.preview.content : "";
    expect(previewContent).toBe("");

    const diagnosticMessages = diagnostics.getAll();
    const previewDiagnostics = diagnosticMessages.filter((message) => message.includes("Digest preview prepared"));
    expect(previewDiagnostics.length).toBeGreaterThan(0);
    expect(previewDiagnostics[previewDiagnostics.length - 1]).toContain("length=0");
  });

  it("warns when filters exclude every requested file and succeeds after broadening includes", async () => {
    markSelectionHandlersReady();

    const baseSnapshot = configurationService.getConfig();
    configurationService["config"] = {
      ...baseSnapshot,
      include: ["docs/**"],
      exclude: []
    } as typeof baseSnapshot;
    configurationService.loadConfig();

    await expect(
      vscode.commands.executeCommand(COMMAND_MAP.WEBVIEW_TO_HOST.GENERATE_DIGEST, {
        selectedFiles: ["src/index.ts"]
      })
    ).rejects.toMatchObject({
      message: "All selected files are excluded by the current include/exclude or gitignore settings.",
      handledByHost: true
    });

    expect(digestSpy).not.toHaveBeenCalled();
    const diagnosticMessages = diagnostics.getAll();
    expect(diagnosticMessages.some((message) => message.includes("Selection filtering: skipped 1 selected file"))).toBe(true);
    expect(diagnosticMessages.some((message) => message.includes("Digest request rejected: All selected files are excluded"))).toBe(true);

    const errorCalls = (webviewPanelManager.sendCommand as jest.Mock).mock.calls.filter((call) => call[0] === COMMAND_MAP.HOST_TO_WEBVIEW.SHOW_ERROR);
    expect(errorCalls.length).toBeGreaterThan(0);
    expect(errorCalls[errorCalls.length - 1]?.[1]).toMatchObject({
      message: "All selected files are excluded by the current include/exclude or gitignore settings."
    });

    (webviewPanelManager.sendCommand as jest.Mock).mockClear();
    diagnostics.clear();
    digestSpy.mockClear();

    configurationService["config"] = {
      ...baseSnapshot,
      include: ["**/*"],
      exclude: []
    } as typeof baseSnapshot;
    configurationService.loadConfig();

    await expect(
      vscode.commands.executeCommand(COMMAND_MAP.WEBVIEW_TO_HOST.GENERATE_DIGEST, {
        selectedFiles: ["src/index.ts"]
      })
    ).resolves.toBeUndefined();

    expect(digestSpy).toHaveBeenCalledTimes(1);
    const recoveredDiagnostics = diagnostics.getAll();
    expect(recoveredDiagnostics.some((message) => message.includes("Digest preview prepared"))).toBe(true);
  });
});
