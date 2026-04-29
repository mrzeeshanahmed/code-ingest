import { minimatch } from "minimatch";
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import * as vscode from "vscode";

import { registerGenerateDigestCommand, __testing as generateDigestTesting } from "../../../commands/generateDigest";
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

const filterServiceInstances: Array<{ batchFilter: jest.Mock; compilePattern: jest.Mock }> = [];

const toRelativePath = (absolutePath: string): string => {
  const normalized = absolutePath.replace(/\\/g, "/");
  const marker = "/workspace/";
  const index = normalized.indexOf(marker);
  if (index >= 0) {
    return normalized.slice(index + marker.length);
  }
  return normalized.startsWith("/") ? normalized.slice(1) : normalized;
};

const normalizePattern = (pattern: string): string | null => {
  if (typeof pattern !== "string") {
    return null;
  }
  const trimmed = pattern.trim();
  if (trimmed.length === 0) {
    return null;
  }
  return trimmed.replace(/\\/g, "/").replace(/^\.\//, "");
};

jest.mock("../../../services/filterService", () => {
  const FilterService = jest.fn().mockImplementation(() => {
    const instance = {
      batchFilter: jest
        .fn(async (paths: string[], options: { includePatterns?: string[]; excludePatterns?: string[] } = {}) => {
          const result = new Map<string, { included: boolean; reason: "included" | "excluded" | "gitignored" | "depth-limit" | "symlink-skipped"; matchedPattern?: string }>();
          const includeMatchers: Array<{ source: string; matcher: (candidate: string) => boolean }> = Array.isArray(options.includePatterns)
            ? options.includePatterns
                .map((pattern) => {
                  const normalized = normalizePattern(pattern);
                  if (!normalized) {
                    return null;
                  }
                  return {
                    source: pattern,
                    matcher: (candidate: string) => minimatch(candidate, normalized, { dot: true })
                  };
                })
                .filter(
                  (entry): entry is { source: string; matcher: (candidate: string) => boolean } =>
                    Boolean(entry)
                )
            : [];
          const excludeMatchers: Array<{ source: string; matcher: (candidate: string) => boolean }> = Array.isArray(options.excludePatterns)
            ? options.excludePatterns
                .map((pattern) => {
                  const normalized = normalizePattern(pattern);
                  if (!normalized) {
                    return null;
                  }
                  return {
                    source: pattern,
                    matcher: (candidate: string) => minimatch(candidate, normalized, { dot: true })
                  };
                })
                .filter(
                  (entry): entry is { source: string; matcher: (candidate: string) => boolean } =>
                    Boolean(entry)
                )
            : [];

          for (const filePath of paths) {
            const relativePath = toRelativePath(filePath);
            if (filePath.includes("__filtered__")) {
              result.set(filePath, { included: false, reason: "excluded", matchedPattern: "filters/__filtered__" });
              continue;
            }

            const matchesInclude = includeMatchers.length === 0 || includeMatchers.some((entry) => entry.matcher(relativePath));
            if (!matchesInclude) {
              const matchedPattern = includeMatchers[0]?.source ?? "include";
              result.set(filePath, { included: false, reason: "excluded", matchedPattern });
              continue;
            }

            const matchesExclude = excludeMatchers.some((entry) => entry.matcher(relativePath));
            if (matchesExclude) {
              const matchedPattern = excludeMatchers.find((entry) => entry.matcher(relativePath))?.source ?? "exclude";
              result.set(filePath, { included: false, reason: "excluded", matchedPattern });
              continue;
            }
            result.set(filePath, { included: true, reason: "included" });
          }
          return result;
        }) as unknown as jest.Mock,
      compilePattern: jest.fn(() => ({ matcher: jest.fn(() => false), source: "" })) as unknown as jest.Mock
    } satisfies { batchFilter: jest.Mock; compilePattern: jest.Mock };
    filterServiceInstances.push(instance);
    return instance;
  });

  return {
    FilterService,
    __getFilterServiceInstances: () => filterServiceInstances
  };
});
const filterServiceModule = jest.requireMock("../../../services/filterService") as {
  FilterService: jest.Mock;
  __getFilterServiceInstances: () => Array<{ batchFilter: jest.Mock; compilePattern: jest.Mock }>;
};

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
  createFormatter: jest.fn(() => ({
    finalize: jest.fn(() => "formatted"),
    supportsStreaming: jest.fn(() => false),
    streamSectionsAsync: jest.fn()
  }))
}));

const { createFormatter: createFormatterMock } = jest.requireMock("../../../formatters/factory") as {
  createFormatter: jest.Mock;
};

const createDigestResult = (): DigestResult => ({
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
});

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
  const withProgressMock = vscode.window.withProgress as unknown as jest.MockedFunction<typeof vscode.window.withProgress>;

  beforeEach(() => {
    filterServiceModule.FilterService.mockClear();
    const recordedInstances = filterServiceModule.__getFilterServiceInstances();
    recordedInstances.splice(0, recordedInstances.length);

    generateDigestTesting.clearInFlightDigests();
    workspaceSelection = [];
    generateDigestMock.mockReset();
    createFormatterMock.mockClear();

    withProgressMock.mockImplementation(async (_options, task) => {
      const source = new vscode.CancellationTokenSource();
      return task({ report: jest.fn() }, source.token);
    });

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
    generateDigestTesting.clearInFlightDigests();
  });

  const buildServices = () => {
    return {
      diagnostics: { add: jest.fn() },
      gitignoreService: {},
      workspaceManager: {
        getWorkspaceRoot: jest.fn(() => vscode.Uri.file("/workspace")),
        getSelection: jest.fn(() => workspaceSelection),
        setSelection: setSelectionMock,
        withSelectionLock: jest.fn(async (operation: () => unknown) => operation()),
        awaitSelectionSnapshot: jest.fn(async () => workspaceSelection),
        waitForSelectionIdle: jest.fn(async () => undefined),
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
        }),
        writeStream: jest.fn()
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

    const digestResult = createDigestResult();

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

    const updatePreviewCall = sendCommandMock.mock.calls.find((call) => call[0] === COMMAND_MAP.HOST_TO_WEBVIEW.UPDATE_PREVIEW);
    expect(updatePreviewCall).toBeDefined();
    const updatePreviewPayload = updatePreviewCall?.[1] as {
      content?: string;
      previewId?: string;
      tokenCount?: { total?: number };
    } | undefined;
    expect(updatePreviewPayload?.content).toBe("formatted");
    expect(updatePreviewPayload?.previewId).toMatch(/^preview-/);
    expect(updatePreviewPayload?.tokenCount?.total).toBe(digestResult.statistics.totalTokens);
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

  it("filters the selection using the FilterService before generating", async () => {
    const services = buildServices();
    const handler = registerAndGetHandler(services);

    const digestResult = createDigestResult();
    generateDigestMock.mockResolvedValueOnce(digestResult);

    await handler({ selectedFiles: ["src/keep.ts", "src/__filtered__/skip.ts"] });

    const warningMessages = showWarningMessageMock.mock.calls.map(([message]) => message);
    expect(warningMessages).toContain("Code Ingest: Skipped 1 selected file due to current filters.");

    // First call sets the initial selection; the latest call should reflect the filtered selection.
    const latestSelection = setSelectionMock.mock.calls[setSelectionMock.mock.calls.length - 1]?.[0] as string[];
    expect(latestSelection).toEqual(["src/keep.ts"]);
    expect(workspaceSelection).toEqual(["src/keep.ts"]);

    expect(generateDigestMock).toHaveBeenCalledTimes(1);
    const options = generateDigestMock.mock.calls[0][0] as { selectedFiles: string[] };
    expect(options.selectedFiles).toHaveLength(1);
    expect(options.selectedFiles[0]).toContain("keep.ts");
  });

  it("rejects runs when filters exclude the entire selection and recovers once include patterns broaden", async () => {
    const services = buildServices();
    const handler = registerAndGetHandler(services);

    const baseConfig = services.configurationService.getConfig();
    const restrictedConfig = {
      ...baseConfig,
      include: ["docs/**"],
      exclude: []
    } as typeof baseConfig;
    services.configurationService.getConfig.mockReset();
    const configSequence: Array<typeof baseConfig> = [restrictedConfig];
    services.configurationService.getConfig.mockImplementation(() => {
      const nextConfig = configSequence.shift();
      return nextConfig ?? { ...baseConfig };
    });

    await expect(handler({ selectedFiles: ["src/index.ts"] })).rejects.toMatchObject({
      message: "All selected files are excluded by the current include/exclude or gitignore settings.",
      handledByHost: true
    });

    const diagnosticMessages = (services.diagnostics.add as jest.Mock).mock.calls.map(([message]) => String(message));
    expect(diagnosticMessages.some((message) => message.includes("Selection filtering: skipped 1 selected file"))).toBe(true);
    expect(diagnosticMessages.some((message) => message.includes("Digest request rejected: All selected files are excluded"))).toBe(true);

    expect(showWarningMessageMock).toHaveBeenCalledWith(
      "Code Ingest: Skipped 1 selected file due to current filters."
    );
    const errorCall = sendCommandMock.mock.calls.find((call) => call[0] === COMMAND_MAP.HOST_TO_WEBVIEW.SHOW_ERROR);
    expect(errorCall?.[1]).toMatchObject({
      title: "No files available",
      message: "All selected files are excluded by the current include/exclude or gitignore settings."
    });
    expect(generateDigestMock).not.toHaveBeenCalled();

    showWarningMessageMock.mockClear();
    sendCommandMock.mockClear();
    (services.diagnostics.add as jest.Mock).mockClear();
    generateDigestMock.mockReset();

    const digestResult = createDigestResult();
    generateDigestMock.mockResolvedValueOnce(digestResult);

    await expect(handler({ selectedFiles: ["src/index.ts"] })).resolves.toBeUndefined();

    expect(generateDigestMock).toHaveBeenCalledTimes(1);
    expect(showWarningMessageMock).not.toHaveBeenCalled();
    const successDiagnostics = (services.diagnostics.add as jest.Mock).mock.calls.map(([message]) => String(message));
    expect(successDiagnostics.some((message) => message.includes("Digest preview prepared"))).toBe(true);
  });

  it("reuses in-flight digest runs for duplicate host invocations", async () => {
    const services = buildServices();
    workspaceSelection = ["src/index.ts"];
    const handler = registerAndGetHandler(services);

    const digestResult = createDigestResult();

    let releaseDigest!: () => void;
    const inFlight = new Promise<DigestResult>((resolve) => {
      releaseDigest = () => resolve(digestResult);
    });

    generateDigestMock.mockImplementation(() => inFlight);

    const firstInvoke = handler();
    const secondInvoke = handler();
    await Promise.resolve();

    releaseDigest();
    await Promise.all([firstInvoke, secondInvoke]);

    expect(generateDigestMock).toHaveBeenCalledTimes(1);
    expect(createPanelMock).toHaveBeenCalledTimes(1);
    expect(generateDigestTesting.getInFlightDigestCount()).toBe(0);

    // Subsequent invocation after completion should trigger a fresh run.
    generateDigestMock.mockResolvedValueOnce(digestResult);
    await handler();
    expect(generateDigestMock).toHaveBeenCalledTimes(2);
  });
});