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
import type { OutputWriter, OutputTarget, WriteResult } from "../../services/outputWriter";
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

    const outputWriter: OutputWriter = {
      resolveConfiguredTarget: jest.fn(() => ({
        type: "file",
        path: path.join(workspaceRoot, "code-ingest.md")
      }) satisfies OutputTarget),
      writeOutput: jest.fn(async () => ({
        success: true,
        bytesWritten: 256,
        writeTime: 5,
        target: { type: "file", path: path.join(workspaceRoot, "code-ingest.md") },
        uri: vscode.Uri.file(path.join(workspaceRoot, "code-ingest.md"))
      }) satisfies WriteResult)
    } as unknown as OutputWriter;

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
  });
});
