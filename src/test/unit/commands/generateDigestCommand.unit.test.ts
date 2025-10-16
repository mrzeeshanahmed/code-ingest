import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import * as vscode from "vscode";

import { registerGenerateDigestCommand } from "../../../commands/generateDigest";
import { COMMAND_MAP } from "../../../commands/commandMap";
import type { CommandRegistrar, CommandServices } from "../../../commands/types";
import type { DigestResult } from "../../../services/digestGenerator";
import type { WriteProgress } from "../../../services/outputWriter";

type GenerateDigestFn = (options: unknown) => Promise<DigestResult>;
const generateDigestMock: jest.MockedFunction<GenerateDigestFn> = jest.fn();

jest.mock("../../../services/digestGenerator", () => ({
  DigestGenerator: jest.fn().mockImplementation(() => ({
    generateDigest: generateDigestMock
  }))
}));

jest.mock("../../../services/filterService", () => ({
  FilterService: jest.fn().mockImplementation(() => ({}))
}));

jest.mock("../../../services/contentProcessor", () => ({
  ContentProcessor: jest.fn().mockImplementation(() => ({}))
}));

jest.mock("../../../services/tokenAnalyzer", () => ({
  TokenAnalyzer: jest.fn().mockImplementation(() => ({}))
}));

jest.mock("../../../services/fileScanner", () => ({
  FileScanner: jest.fn().mockImplementation(() => ({}))
}));

jest.mock("../../../services/notebookProcessor", () => ({
  NotebookProcessor: {}
}));

jest.mock("../../../formatters/factory", () => ({
  createFormatter: jest.fn(() => ({ finalize: jest.fn(() => "formatted") }))
}));

const { createFormatter: createFormatterMock } = jest.requireMock("../../../formatters/factory") as {
  createFormatter: jest.Mock;
};

describe("registerGenerateDigestCommand", () => {
  const context = { subscriptions: [] as vscode.Disposable[] } as unknown as vscode.ExtensionContext;
  let workspaceSelection: string[];
  type SetSelectionFn = (paths: Iterable<string>) => string[];
  let setSelectionMock: jest.MockedFunction<SetSelectionFn>;
  let createPanelMock: jest.Mock;
  let setStateSnapshotMock: jest.Mock;
  let showWarningMessageMock: jest.Mock;
  let showInformationMessageMock: jest.Mock;
  let sendCommandMock: jest.Mock;
  type FsStatFn = (uri: vscode.Uri) => Promise<unknown>;
  let fsStatMock: jest.MockedFunction<FsStatFn>;

  beforeEach(() => {
    workspaceSelection = [];
    generateDigestMock.mockReset();
    createFormatterMock.mockClear();

    const setSelectionImpl: SetSelectionFn = (paths: Iterable<string>) => {
      const next = Array.from(paths);
      workspaceSelection = next;
      return next;
    };
    setSelectionMock = jest.fn(setSelectionImpl);

    createPanelMock = jest.fn(async () => {});
    setStateSnapshotMock = jest.fn();
  sendCommandMock = jest.fn();

    fsStatMock = jest.fn(async (uri: vscode.Uri) => {
      void uri;
      return {};
    });
    Object.assign(vscode.workspace.fs, { stat: fsStatMock });

    showWarningMessageMock = vscode.window.showWarningMessage as unknown as jest.Mock;
    showInformationMessageMock = vscode.window.showInformationMessage as unknown as jest.Mock;
    showWarningMessageMock.mockClear();
    showInformationMessageMock.mockClear();
  });

  afterEach(() => {
    context.subscriptions.splice(0, context.subscriptions.length);
    generateDigestMock.mockReset();
  });

  const buildServices = () => {
    return {
      diagnostics: { add: jest.fn() },
      gitignoreService: {},
      workspaceManager: {
        getWorkspaceRoot: jest.fn(() => vscode.Uri.file("/workspace")),
        getSelection: jest.fn(() => workspaceSelection),
        setSelection: setSelectionMock,
        getRedactionOverride: jest.fn(() => false),
        setRedactionOverride: jest.fn()
      },
      webviewPanelManager: {
        createAndShowPanel: createPanelMock,
        setStateSnapshot: setStateSnapshotMock,
        sendCommand: sendCommandMock,
        getStateSnapshot: jest.fn(() => ({})),
        tryRestoreState: jest.fn(() => false)
      },
      performanceMonitor: {
        measureOperation: jest.fn(async (_name: string, fn: () => unknown | Promise<unknown>) => {
          await Promise.resolve(fn());
        })
      },
      diagnosticService: {},
      configurationService: {
        getConfig: jest.fn(() => ({
          outputFormat: "markdown",
          include: [],
          exclude: [],
          followSymlinks: false,
          respectGitIgnore: true,
          maxDepth: undefined,
          binaryFilePolicy: "skip"
        }))
      },
      errorReporter: { report: jest.fn() },
      extensionUri: vscode.Uri.file("/extension"),
      outputWriter: {
        resolveConfiguredTarget: jest.fn(() => ({ type: "file", path: "/workspace/digest.md" })),
        writeOutput: jest.fn(async (options?: {
          progressCallback?: (progress: WriteProgress) => void;
        }) => {
          options?.progressCallback?.({
            phase: "preparing",
            bytesWritten: 0,
            totalBytes: 100,
            currentOperation: "Preparing digest output"
          });
          options?.progressCallback?.({
            phase: "writing",
            bytesWritten: 50,
            totalBytes: 100,
            currentOperation: "Writing digest file…"
          });
          options?.progressCallback?.({
            phase: "complete",
            bytesWritten: 100,
            totalBytes: 100,
            currentOperation: "Digest file opened"
          });
          return {
            success: true,
            uri: vscode.Uri.file("/workspace/digest.md"),
            bytesWritten: 10,
            writeTime: 5,
            target: { type: "file", path: "/workspace/digest.md" }
          };
        })
      }
    };
  };

  const registerAndGetHandler = (services: ReturnType<typeof buildServices>) => {
    const registrar: CommandRegistrar = (commandId, handler) =>
      vscode.commands.registerCommand(commandId, handler);

    registerGenerateDigestCommand(
      context,
      services as unknown as CommandServices,
      registrar
    );
    const commandApi = vscode.commands as unknown as {
      __getRegisteredCommands(): Map<string, (...args: unknown[]) => unknown>;
    };
    const commands = commandApi.__getRegisteredCommands();
    const handler = commands.get(COMMAND_MAP.WEBVIEW_TO_HOST.GENERATE_DIGEST);
    if (!handler) {
      throw new Error("Generate digest command was not registered");
    }
    return handler;
  };

  it("normalizes payload selections before generating", async () => {
    const services = buildServices();
    const handler = registerAndGetHandler(services);

    const digestResult: DigestResult = {
      content: {
        files: [],
        summary: {
          overview: {
            totalFiles: 1,
            includedFiles: 1,
            skippedFiles: 0,
            binaryFiles: 0,
            totalTokens: 150
          },
          tableOfContents: [],
          notes: []
        },
        metadata: {
          generatedAt: new Date(),
          workspaceRoot: "/workspace",
          totalFiles: 1,
          includedFiles: 1,
          skippedFiles: 0,
          binaryFiles: 0,
          tokenEstimate: 150,
          processingTime: 0,
          redactionApplied: false,
          generatorVersion: "test"
        }
      },
      statistics: {
        filesProcessed: 1,
        totalTokens: 150,
        processingTime: 0,
        warnings: [],
        errors: []
      },
      redactionApplied: false,
      truncationApplied: false
    };

    generateDigestMock.mockResolvedValueOnce(digestResult);

    await handler({ selectedFiles: ["/workspace/src/index.ts", "src/index.ts"] });

    expect(setSelectionMock).toHaveBeenCalledWith(["src/index.ts"]);
    expect(fsStatMock).toHaveBeenCalledTimes(1);
    const statUri = fsStatMock.mock.calls[0][0] as vscode.Uri;
    expect(statUri.fsPath).toBe(
      vscode.Uri.joinPath(vscode.Uri.file("/workspace"), "src", "index.ts").fsPath
    );
    expect(createPanelMock).toHaveBeenCalledTimes(1);
    expect(generateDigestMock).toHaveBeenCalledTimes(1);
    const options = generateDigestMock.mock.calls[0][0] as { selectedFiles: string[] };
    const expectedAbsolute = vscode.Uri.joinPath(vscode.Uri.file("/workspace"), "src", "index.ts").fsPath;
    expect(options.selectedFiles).toEqual([expectedAbsolute]);
    expect(services.workspaceManager.getRedactionOverride).toHaveBeenCalled();
    expect(services.outputWriter.writeOutput).toHaveBeenCalled();
    const hasWritingStatus = setStateSnapshotMock.mock.calls.some(([payload]) => {
      const state = payload as Record<string, unknown> | undefined;
      return state?.status === "digest-writing";
    });
    expect(hasWritingStatus).toBe(true);
  });

  it("drops missing files and aborts when none remain", async () => {
    const services = buildServices();
    const handler = registerAndGetHandler(services);

    fsStatMock.mockRejectedValueOnce(new Error("missing"));

    const expectedMessage = 'The requested file "src/missing.ts" is not available in this workspace.';
    await expect(handler({ selectedFiles: ["/workspace/src/missing.ts"] })).rejects.toMatchObject({
      message: expectedMessage,
      code: "DIGEST_SELECTION_REJECTED",
      handledByHost: true
    });

    expect(showWarningMessageMock).toHaveBeenCalledWith(
      "Code Ingest: Skipped 1 missing file before generating the digest."
    );
    expect(showInformationMessageMock).not.toHaveBeenCalled();
    expect(createPanelMock).not.toHaveBeenCalled();
    expect(generateDigestMock).not.toHaveBeenCalled();
    expect(sendCommandMock).toHaveBeenCalledWith(
      COMMAND_MAP.HOST_TO_WEBVIEW.SHOW_ERROR,
      {
        title: "No files available",
        message: expectedMessage
      }
    );
    expect(workspaceSelection).toEqual([]);
  });
});
