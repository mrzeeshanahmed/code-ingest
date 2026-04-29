import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import * as vscode from "vscode";

import { DigestGenerator } from "../../services/digestGenerator";
import type { FileNode } from "../../services/fileScanner";
import type { FilterResult } from "../../services/filterService";
import type { ProcessedContent } from "../../services/contentProcessor";
import type { ProcessedNotebook } from "../../services/notebookProcessor";
import type { TokenAnalysis } from "../../services/tokenAnalyzer";
import type { DigestConfig } from "../../utils/validateConfig";
import * as redactionModule from "../../utils/redactSecrets";
import packageJson from "../../../package.json";
import { MockContentProcessor, MockTokenAnalyzer } from "./utils/mocks";
import type { TelemetryService } from "../../services/telemetryService";

const PACKAGE_VERSION = packageJson.version;

describe("DigestGenerator", () => {
  interface FileScannerLike {
    scan(options?: unknown): Promise<FileNode[]>;
  }
  interface FilterServiceLike {
    batchFilter(paths: string[], options: Record<string, unknown>): Promise<Map<string, FilterResult>>;
  }
  interface NotebookProcessorLike {
    processNotebook(filePath: string, options: unknown): Promise<ProcessedNotebook>;
  }
  interface ConfigurationServiceLike {
    loadConfig(): DigestConfig;
  }
  interface ErrorReporterLike {
    report(error: unknown, context?: unknown): void;
    reportError(error: Error, context: unknown): Promise<void>;
  }

  type TelemetryLike = Pick<
    TelemetryService,
    "trackFeatureUsage" | "trackOperationDuration" | "trackEvent" | "trackError"
  >;

  let fileScanner: jest.Mocked<FileScannerLike>;
  let filterService: jest.Mocked<FilterServiceLike>;
  let contentProcessor: MockContentProcessor;
  let notebookProcessor: jest.Mocked<NotebookProcessorLike>;
  let tokenAnalyzer: MockTokenAnalyzer;
  let configurationService: jest.Mocked<ConfigurationServiceLike>;
  let errorReporter: jest.Mocked<ErrorReporterLike>;
  let workspaceRoot: string;
  let absoluteFilePath: string;
  const relativeFilePath = "src/index.ts";

  beforeEach(() => {
    fileScanner = { scan: jest.fn() } as unknown as jest.Mocked<FileScannerLike>;
    filterService = { batchFilter: jest.fn() } as unknown as jest.Mocked<FilterServiceLike>;
    contentProcessor = new MockContentProcessor();
    notebookProcessor = { processNotebook: jest.fn() } as unknown as jest.Mocked<NotebookProcessorLike>;
    tokenAnalyzer = new MockTokenAnalyzer();
    configurationService = { loadConfig: jest.fn() } as unknown as jest.Mocked<ConfigurationServiceLike>;
    errorReporter = {
      report: jest.fn(),
      reportError: jest.fn().mockImplementation(async () => undefined)
    } as unknown as jest.Mocked<ErrorReporterLike>;

    (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({ get: () => undefined });

    workspaceRoot = path.join(process.cwd(), "__digest-tests__");
    absoluteFilePath = path.join(workspaceRoot, "src", "index.ts");

    (vscode.workspace as unknown as { workspaceFolders: vscode.WorkspaceFolder[] }).workspaceFolders = [
      {
        index: 0,
        name: "workspace",
        uri: vscode.Uri.file(workspaceRoot)
      }
    ];

    configurationService.loadConfig.mockReturnValue({
      include: ["src"],
      exclude: [],
      maxFiles: 100,
      binaryFilePolicy: "skip",
      workspaceRoot,
      followSymlinks: false,
      respectGitIgnore: false,
      includeCodeCells: true,
      includeMarkdownCells: true,
      includeCellOutputs: true,
      maxConcurrency: 4,
      outputFormat: "markdown",
      repoName: "workspace"
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function createGenerator(telemetryInstance?: TelemetryLike): DigestGenerator {
    return new DigestGenerator(
      fileScanner as unknown as import("../../services/fileScanner").FileScanner,
      filterService as unknown as import("../../services/filterService").FilterService,
      contentProcessor as unknown as import("../../services/contentProcessor").ContentProcessor,
      notebookProcessor as unknown as typeof import("../../services/notebookProcessor").NotebookProcessor,
      tokenAnalyzer as unknown as import("../../services/tokenAnalyzer").TokenAnalyzer,
      configurationService as unknown as import("../../services/configurationService").ConfigurationService,
      errorReporter as unknown as import("../../services/errorReporter").ErrorReporter,
      telemetryInstance as unknown as TelemetryService
    );
  }

  function setupHappyPath(): void {
    const nodes: FileNode[] = [
      {
        uri: vscode.Uri.file(absoluteFilePath).toString(),
        name: "index.ts",
        type: "file",
        relPath: relativeFilePath
      }
    ];
    fileScanner.scan.mockResolvedValue(nodes);

    const filterMap = new Map<string, FilterResult>();
    filterMap.set(absoluteFilePath, { included: true, reason: "included" });
    filterService.batchFilter.mockResolvedValue(filterMap);

    const processed: ProcessedContent = {
      content: "console.log('hello');",
      encoding: "utf8",
      isTruncated: false,
      language: "typescript",
      metadata: { lines: 1 },
      processingTime: 10,
      size: 30
    };
    contentProcessor.processFile.mockResolvedValue(processed);
    contentProcessor.detectLanguage.mockReturnValue("typescript");
    contentProcessor.estimateLines.mockReturnValue(1);

    const notebookResult: ProcessedNotebook = {
      content: "converted notebook",
      cellCount: { code: 0, markdown: 0, raw: 0 },
      outputCount: { text: 0, nonText: 0, skipped: 0 },
      processingTime: 0,
      totalSize: 0,
      warnings: []
    };
    notebookProcessor.processNotebook.mockResolvedValue(notebookResult);

    const analysis: TokenAnalysis = {
      adapter: "mock",
      cacheHit: false,
      exceededBudget: false,
      tokens: 20,
      warnings: [],
      budget: { limit: 1000, warnAt: 800, warnRatio: 0.8 },
      metadata: {}
    };
    tokenAnalyzer.analyze.mockResolvedValue(analysis);
    tokenAnalyzer.analyzeBatch.mockResolvedValue([analysis]);
  }

  it("orchestrates services and produces aggregate digest", async () => {
    setupHappyPath();
    const generator = createGenerator();

    const result = await generator.generateDigest({
      selectedFiles: [absoluteFilePath],
      outputFormat: "markdown",
      applyRedaction: false
    });

    expect(result.content.files).toHaveLength(1);
    const [file] = result.content.files;
    expect(file.relativePath).toBe(relativeFilePath);
    expect(file.tokens).toBe(20);
    expect(result.statistics.filesProcessed).toBe(1);
    expect(result.content.metadata.generatorVersion).toBe(PACKAGE_VERSION);
  });

  it("invokes progress callback across pipeline phases", async () => {
    setupHappyPath();
    const generator = createGenerator();
    const phases: string[] = [];

    await generator.generateDigest({
      selectedFiles: [absoluteFilePath],
      outputFormat: "markdown",
      progressCallback: (progress) => phases.push(progress.phase)
    });

    expect(phases).toEqual([
      "scanning",
      "scanning",
      "processing",
      "processing",
      "analyzing",
      "generating",
      "formatting",
      "complete"
    ]);
  });

  it("captures errors from processing and continues", async () => {
    setupHappyPath();
    const error = new Error("failed");
    contentProcessor.processFile.mockRejectedValueOnce(error);

    const generator = createGenerator();
    const result = await generator.generateDigest({
      selectedFiles: [absoluteFilePath],
      outputFormat: "markdown"
    });

    expect(result.statistics.errors).toHaveLength(1);
  expect(errorReporter.reportError).toHaveBeenCalled();
  });

  it("honours token budget and truncates when exceeded", async () => {
    setupHappyPath();
    tokenAnalyzer.analyze.mockResolvedValueOnce({
      adapter: "mock",
      cacheHit: false,
      exceededBudget: true,
      tokens: 200,
      warnings: ["too many"],
      budget: { limit: 50, warnAt: 40, warnRatio: 0.8 }
    } as TokenAnalysis);

    const generator = createGenerator();
    const result = await generator.generateDigest({
      selectedFiles: [absoluteFilePath],
      outputFormat: "markdown",
      maxTokens: 50
    });

    expect(result.truncationApplied).toBe(true);
    expect(result.content.files[0].warnings).toEqual(expect.arrayContaining([expect.stringMatching(/token budget/i)]));
  });

  it("applies redaction when enabled", async () => {
    setupHappyPath();
    jest
      .spyOn(redactionModule, "redactSecrets")
      .mockImplementation((input: string) => input.replace("secret", "<REDACTED>"));

    contentProcessor.processFile.mockResolvedValue({
      content: "api-secret-token",
      encoding: "utf8",
      isTruncated: false,
      language: "plaintext",
      metadata: { lines: 1 },
      processingTime: 1,
      size: 10
    });

    const generator = createGenerator();
    const result = await generator.generateDigest({
      selectedFiles: [absoluteFilePath],
      outputFormat: "markdown",
      applyRedaction: true
    });

    expect(result.redactionApplied).toBe(true);
    expect(result.content.files[0].content).toContain("<REDACTED>");
  });

  it("generates metadata snapshot including timing information", async () => {
    setupHappyPath();
    const generator = createGenerator();
    const result = await generator.generateDigest({
      selectedFiles: [absoluteFilePath],
      outputFormat: "markdown"
    });

    expect(result.content.metadata.generatedAt).toBeInstanceOf(Date);
    expect(result.statistics.processingTime).toBeGreaterThanOrEqual(0);
    expect(result.content.metadata.tokenEstimate).toBeGreaterThan(0);
  });

  it("records telemetry metrics on successful completion", async () => {
    setupHappyPath();
    const telemetry: jest.Mocked<TelemetryLike> = {
      trackFeatureUsage: jest.fn(),
      trackOperationDuration: jest.fn(),
      trackEvent: jest.fn(),
      trackError: jest.fn()
    };

    const generator = createGenerator(telemetry);
    await generator.generateDigest({
      selectedFiles: [absoluteFilePath],
      outputFormat: "markdown"
    });

    expect(telemetry.trackFeatureUsage).toHaveBeenCalledWith("digest.pipeline", { format: "markdown" });
    expect(telemetry.trackOperationDuration).toHaveBeenCalledWith("digest.generate", expect.any(Number), true);

    const performanceCall = telemetry.trackEvent.mock.calls.find(([name]) => name === "performance.digest");
    expect(performanceCall?.[1]).toMatchObject({ stage: "completed", format: "markdown", redacted: true });
    expect(performanceCall?.[2]).toEqual(expect.objectContaining({ filesProcessed: 1, tokensProcessed: 20 }));

    const summaryCall = telemetry.trackEvent.mock.calls.find(([name]) => name === "digest.summary");
    expect(summaryCall?.[1]).toMatchObject({ truncated: false, binaryFiles: 0, format: "markdown" });
    expect(summaryCall?.[2]).toEqual(expect.objectContaining({ filesProcessed: 1, totalTokens: 20 }));
    expect(telemetry.trackError).not.toHaveBeenCalled();
  });

  it("records telemetry diagnostics when pipeline fails", async () => {
    const telemetry: jest.Mocked<TelemetryLike> = {
      trackFeatureUsage: jest.fn(),
      trackOperationDuration: jest.fn(),
      trackEvent: jest.fn(),
      trackError: jest.fn()
    };

    fileScanner.scan.mockRejectedValueOnce(new Error("scan failed"));
    const generator = createGenerator(telemetry);

    await expect(
      generator.generateDigest({
        selectedFiles: [absoluteFilePath],
        outputFormat: "markdown"
      })
    ).rejects.toThrow("scan failed");

    expect(telemetry.trackFeatureUsage).toHaveBeenCalledWith("digest.pipeline", { format: "markdown" });
    expect(telemetry.trackOperationDuration).toHaveBeenCalledWith("digest.generate", expect.any(Number), false);

    const failureCall = telemetry.trackEvent.mock.calls.find(([name]) => name === "performance.digest");
    expect(failureCall?.[1]).toMatchObject({ stage: "failed", format: "markdown" });
    expect(failureCall?.[2]).toEqual(expect.objectContaining({ cpuTimeMs: expect.any(Number) }));

    expect(telemetry.trackError).toHaveBeenCalledWith(expect.any(Error), {
      component: "digestGenerator",
      operation: "generateDigest"
    });
  });
});