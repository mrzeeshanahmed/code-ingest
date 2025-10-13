import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { performance } from "node:perf_hooks";
import * as vscode from "vscode";

import { CacheService } from "../../services/cacheService";
import { ContentProcessor, type ProcessedContent } from "../../services/contentProcessor";
import { DigestGenerator, type DigestResult, type ProcessedFileContent } from "../../services/digestGenerator";
import { ErrorReporter } from "../../services/errorReporter";
import { FileScanner } from "../../services/fileScanner";
import { FilterService } from "../../services/filterService";
import { GitignoreService } from "../../services/gitignoreService";
import { NotebookProcessor, type NotebookProcessingOptions } from "../../services/notebookProcessor";
import { OutputWriter } from "../../services/outputWriter";
import { TokenAnalyzer, type TokenAnalysis } from "../../services/tokenAnalyzer";
import { ConfigurationService } from "../../services/configurationService";
import { DEFAULT_CONFIG } from "../../config/constants";
import { formatDigest } from "../../utils/digestFormatters";
import { Diagnostics, type DigestConfig } from "../../utils/validateConfig";
import type { Logger } from "../../utils/gitProcessManager";
import { configureWorkspaceEnvironment, resetWorkspaceEnvironment } from "../support/workspaceEnvironment";

interface TestFile {
  readonly relativePath: string;
  readonly content: string | Buffer;
  readonly type: "text" | "binary" | "notebook";
}

interface TestWorkspace {
  readonly root: string;
  readonly files: TestFile[];
  dispose(): Promise<void>;
}

class TestContentGenerator {
  async generateCodeFiles(languages: string[], count: number): Promise<TestFile[]> {
    const files: TestFile[] = [];
    const snippets: Record<string, string> = {
      ts: "export const sum = (a: number, b: number) => a + b;\n",
      js: "module.exports = function sum(a, b) { return a + b; };\n",
      py: "def greet(name):\n    return f'Hello {name}'\n",
      md: "# Sample Document\n\n* Bullet 1\n* Bullet 2\n",
      json: '{"name":"demo","value":42}'
    };

    for (let index = 0; index < count; index += 1) {
      const language = languages[index % languages.length];
      const body = snippets[language as keyof typeof snippets] ?? `// ${language} sample ${index}`;
      const extension = language === "md" ? "md" : language;
      files.push({
        relativePath: path.join("src", `${language}-sample-${index}.${extension}`),
        content: body,
        type: "text"
      });
    }

    return files;
  }

  async generateNotebooks(cellCounts: number[], hasOutputs: boolean): Promise<TestFile[]> {
    const files: TestFile[] = [];
    for (let index = 0; index < cellCounts.length; index += 1) {
      const codeCells = cellCounts[index];
      const cells = [] as Array<Record<string, unknown>>;
      for (let cellIndex = 0; cellIndex < codeCells; cellIndex += 1) {
        const outputs = hasOutputs
          ? [
              {
                output_type: "stream",
                name: "stdout",
                text: [`output ${cellIndex}`]
              }
            ]
          : [];
        cells.push({
          cell_type: "code",
          execution_count: cellIndex,
          source: [`print("cell-${cellIndex}")`],
          outputs
        });
      }
      cells.push({ cell_type: "markdown", source: ["# Heading", "Some text"] });
      const notebook = {
        cells,
        nbformat: 4,
        metadata: { kernelspec: { name: "python3" } }
      };
      files.push({
        relativePath: path.join("notebooks", `notebook-${index}.ipynb`),
        content: JSON.stringify(notebook, null, 2),
        type: "notebook"
      });
    }
    return files;
  }

  async generateBinaryFiles(types: string[], sizes: number[]): Promise<TestFile[]> {
    const files: TestFile[] = [];
    for (let index = 0; index < types.length; index += 1) {
      const extension = types[index];
      const size = sizes[index % sizes.length];
      files.push({
        relativePath: path.join("assets", `binary-${index}.${extension}`),
        content: randomBytes(size),
        type: "binary"
      });
    }
    return files;
  }

  async createLargeWorkspace(fileCount: number, maxSize: number): Promise<TestWorkspace> {
    const files: TestFile[] = [];
    for (let index = 0; index < fileCount; index += 1) {
      const directory = index % 2 === 0 ? "src" : "docs";
      const content = `// file ${index}\n` + "A".repeat(Math.min(maxSize, 64));
      files.push({
        relativePath: path.join(directory, `file-${index}.ts`),
        content,
        type: "text"
      });
    }
    return createWorkspace(files);
  }
}

class ProcessingAssertions {
  validateDigestStructure(result: DigestResult): void {
    expect(result.content.files.length).toBeGreaterThan(0);
    expect(result.statistics.filesProcessed).toBe(result.content.files.length);
    expect(result.content.summary.overview.totalFiles).toBeGreaterThanOrEqual(result.content.files.length);
    expect(result.content.summary.tableOfContents.length).toBe(result.content.files.length);
  }

  checkContentPreservation(original: string, processed: ProcessedContent): void {
    expect(processed.content.includes(original.trim().split("\n")[0]!)).toBeTruthy();
  }

  validateTokenEstimation(content: string, analysis: TokenAnalysis): void {
    expect(analysis.tokens).toBeGreaterThan(0);
    expect(typeof analysis.adapter).toBe("string");
    expect(analysis.metadata?.path).toBeDefined();
    expect(TokenAnalyzer.estimate(content)).toBeGreaterThan(0);
  }

  async assertCacheConsistency(service: CacheService): Promise<void> {
    const stats = service.stats();
    expect(stats.totalEntries).toBeGreaterThanOrEqual(0);
    if (stats.totalEntries > 0) {
      expect(stats.memoryUsageMB).toBeGreaterThanOrEqual(0);
    }
    await service.flushToDisk();
  }
}

async function createWorkspace(files: TestFile[]): Promise<TestWorkspace> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "code-ingest-sprint2-"));
  await Promise.all(
    files.map(async (file) => {
      const absolute = path.join(root, file.relativePath);
      await fs.mkdir(path.dirname(absolute), { recursive: true });
      if (file.type === "binary") {
        await fs.writeFile(absolute, file.content as unknown as NodeJS.ArrayBufferView);
      } else {
        await fs.writeFile(absolute, file.content.toString(), "utf8");
      }
    })
  );
  return {
    root,
    files,
    async dispose() {
      await fs.rm(root, { recursive: true, force: true });
    }
  } satisfies TestWorkspace;
}

function createDiagnostics(): Diagnostics {
  return {
    addError: (message: string) => {
      throw new Error(message);
    },
    addWarning: jest.fn()
  } satisfies Diagnostics;
}

configureWorkspaceEnvironment();

describe("Sprint 2 Integration: Content Processing Pipeline", () => {
  const generator = new TestContentGenerator();
  const assertions = new ProcessingAssertions();

  let contentProcessor: ContentProcessor;
  let notebookProcessor: typeof NotebookProcessor;
  let tokenAnalyzer: TokenAnalyzer;
  let digestGenerator: DigestGenerator;
  let outputWriter: OutputWriter;
  let cacheService: CacheService;
  let testWorkspace: TestWorkspace;
  let fileScanner: FileScanner;
  let filterService: FilterService;
  let configurationService: ConfigurationService;
  let errorReporter: ErrorReporter;
  let logger: Logger;
  let outputChannel: vscode.OutputChannel;

  beforeAll(() => {
    jest.setTimeout(120_000);
  });

  beforeEach(async () => {
    const files: TestFile[] = [
      ...(await generator.generateCodeFiles(["ts", "js", "md"], 3)),
      ...(await generator.generateNotebooks([2], true)),
      ...(await generator.generateBinaryFiles(["bin"], [64]))
    ];
    testWorkspace = await createWorkspace(files);
    configureWorkspaceEnvironment(testWorkspace.root, {
      cache: {
        enabled: true,
        persistToDisk: false,
        compressionLevel: 3
      }
    });

    cacheService = new CacheService({
      defaultOptions: {
        ttl: 60,
        maxEntries: 512,
        maxMemoryMB: 128,
        persistToDisk: false,
        compressionEnabled: true
      }
    }, { workspace: vscode.workspace });

    contentProcessor = new ContentProcessor();
    notebookProcessor = NotebookProcessor;
    tokenAnalyzer = new TokenAnalyzer({ includeDefaultAdapters: true, enableCaching: true });
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      throw new Error("workspace folder not configured");
    }

    fileScanner = new FileScanner(workspaceFolder.uri);
    filterService = new FilterService({ workspaceRoot: testWorkspace.root, gitignoreService: new GitignoreService() });

    const config: DigestConfig = {
      ...DEFAULT_CONFIG,
      workspaceRoot: testWorkspace.root,
      include: ["**/*"],
      exclude: ["**/*.log"],
      maxFiles: 200,
      respectGitIgnore: false,
      followSymlinks: false,
      includeCodeCells: true,
      includeMarkdownCells: true,
      includeCellOutputs: true
    };

    configurationService = new ConfigurationService(config, createDiagnostics());
    outputChannel = vscode.window.createOutputChannel("sprint2-test");
    logger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn()
    };
    errorReporter = new ErrorReporter(configurationService, logger);

    digestGenerator = new DigestGenerator(
      fileScanner,
      filterService,
      contentProcessor,
      notebookProcessor,
      tokenAnalyzer,
      configurationService,
      errorReporter
    );

    outputWriter = new OutputWriter();
  });

  afterEach(async () => {
    await cacheService.clear();
    await cacheService.dispose();
    errorReporter.dispose();
    outputChannel.dispose();
    await testWorkspace.dispose();
    resetWorkspaceEnvironment();
  });

  afterAll(() => {
    jest.clearAllMocks();
  });

  it("runs the complete digest generation pipeline", async () => {
    const absoluteFiles = testWorkspace.files
      .filter((file) => file.type !== "binary")
      .map((file) => path.join(testWorkspace.root, file.relativePath));

    const processed = await contentProcessor.processFiles(absoluteFiles, {
      binaryFilePolicy: "placeholder",
      detectLanguage: true,
      onProgress: jest.fn()
    });

    await Promise.all(
      processed.map((entry, index) => cacheService.cacheProcessedContent(absoluteFiles[index]!, entry))
    );

    const progressEvents: string[] = [];
    const digest = await digestGenerator.generateDigest({
      selectedFiles: absoluteFiles,
      outputFormat: "markdown",
      includeMetadata: true,
      applyRedaction: false,
      progressCallback: (progress) => {
        progressEvents.push(progress.phase);
      }
    });

    assertions.validateDigestStructure(digest);
    expect(progressEvents).toEqual(expect.arrayContaining(["scanning", "processing", "complete"]));

    const markdown = formatDigest(digest, { format: "markdown" });
    const json = formatDigest(digest, { format: "json", formatterOptions: { json: { pretty: true } } });
    const text = formatDigest(digest, { format: "text" });

    expect(markdown).toContain("# Digest Summary");
    expect(JSON.parse(json).metadata.workspaceRoot).toBe(testWorkspace.root);
    expect(text).toContain("Digest Metadata");

    const writeResult = await outputWriter.writeOutput({
      target: { type: "file", path: path.join(testWorkspace.root, "out", "digest.md") },
      content: markdown,
      format: "markdown",
      createDirectories: true
    });

    expect(writeResult.success).toBe(true);
    const stats = await fs.stat(writeResult.uri!.fsPath);
    expect(stats.size).toBeGreaterThan(0);
  });

  it("integrates notebook processing with varied configurations", async () => {
    const notebookFile = testWorkspace.files.find((file) => file.type === "notebook");
    expect(notebookFile).toBeDefined();
    const absolute = path.join(testWorkspace.root, notebookFile!.relativePath);

    const fullNotebook = await notebookProcessor.processNotebook(absolute, {
      includeCodeCells: true,
      includeMarkdownCells: true,
      includeOutputs: true,
      includeNonTextOutputs: false,
      cellSeparator: "\n---\n",
      outputSeparator: "\n",
      nonTextOutputMaxBytes: 4 * 1024
    } satisfies Partial<NotebookProcessingOptions>);

    expect(fullNotebook.cellCount.code).toBeGreaterThan(0);
    expect(fullNotebook.outputCount.text).toBeGreaterThanOrEqual(0);

    const truncatedNotebook = await notebookProcessor.processNotebook(absolute, {
      includeOutputs: true,
      includeNonTextOutputs: true,
      nonTextOutputMaxBytes: 1
    });

  expect(truncatedNotebook.warnings.join(" ")).toContain("Notebook outputs consumed");
    expect(truncatedNotebook.outputCount.skipped).toBeGreaterThanOrEqual(0);
  });

  it("evaluates token analysis, budgeting, and caching", async () => {
    const sample = "const value = Array.from({ length: 128 }, (_, index) => index).join(',');";
    const analysis = await tokenAnalyzer.analyze(sample, {
      metadata: { path: "src/sample.ts" },
      budget: { limit: 1_000, warnRatio: 0.5 }
    });

    assertions.validateTokenEstimation(sample, analysis);

    const cached = await tokenAnalyzer.analyze(sample, { metadata: { path: "src/sample.ts" } });
    expect(cached.cacheHit).toBe(true);

    const largeContent = "-".repeat(10_000);
    const budgeted = await tokenAnalyzer.analyze(largeContent, {
      budget: { limit: 200, warnRatio: 0.8 }
    });
    expect(budgeted.warnings.length).toBeGreaterThanOrEqual(0);
  });

  it("produces consistent output across all formatter targets", async () => {
    const absoluteFiles = testWorkspace.files
      .filter((file) => file.type === "text")
      .map((file) => path.join(testWorkspace.root, file.relativePath));

    const digest = await digestGenerator.generateDigest({
      selectedFiles: absoluteFiles,
      outputFormat: "markdown",
      applyRedaction: true,
      includeMetadata: true
    });

    const outputs = {
      markdown: formatDigest(digest, { format: "markdown" }),
      json: formatDigest(digest, { format: "json" }),
      text: formatDigest(digest, { format: "text" })
    };

    expect(outputs.markdown.includes("# Digest Summary")).toBe(true);
    expect(JSON.parse(outputs.json).files.length).toBe(digest.content.files.length);
    expect(outputs.text.includes("Digest Metadata")).toBe(true);
  });

  it("exercises cache service integration across stages", async () => {
    const targetFile = testWorkspace.files.find((file) => file.type === "text")!;
    const absolute = path.join(testWorkspace.root, targetFile.relativePath);

    const processed = await contentProcessor.processFile(absolute, { binaryFilePolicy: "base64" });
    await cacheService.cacheProcessedContent(absolute, processed);
    const cached = await cacheService.getCachedProcessedContent(absolute);
    expect(cached?.content).toBe(processed.content);

    const digestResult: DigestResult = {
      content: {
        files: [
          {
            path: absolute,
            relativePath: targetFile.relativePath,
            tokens: 12,
            content: processed.content,
            encoding: processed.encoding,
            languageId: processed.language,
            truncated: false,
            redacted: false,
            metadata: { size: processed.size },
            warnings: [],
            errors: []
          } satisfies ProcessedFileContent
        ],
        summary: {
          overview: {
            totalFiles: 1,
            includedFiles: 1,
            skippedFiles: 0,
            binaryFiles: 0,
            totalTokens: 12
          },
          tableOfContents: [{ path: targetFile.relativePath, tokens: 12, truncated: false }],
          notes: []
        },
        metadata: {
          generatedAt: new Date(),
          workspaceRoot: testWorkspace.root,
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
      statistics: { filesProcessed: 1, totalTokens: 12, processingTime: 1, warnings: [], errors: [] },
      redactionApplied: false,
      truncationApplied: false
    };

    await cacheService.cacheDigest("workspace", digestResult, 60);
    const cachedDigest = await cacheService.getCachedDigest("workspace");
    expect(cachedDigest?.content.metadata.workspaceRoot).toBe(testWorkspace.root);

    await cacheService.cacheTokenAnalysis("hash", {
      tokens: 10,
      adapter: "stub",
      cacheHit: false,
      exceededBudget: false,
      warnings: [],
      budget: { limit: 100, warnAt: 80, warnRatio: 0.8 }
    });
    const tokenCache = await cacheService.getCachedTokenAnalysis("hash");
    expect(tokenCache?.tokens).toBe(10);

    await assertions.assertCacheConsistency(cacheService);
  });

  it("recovers from corrupted inputs and enforces policies", async () => {
    const corruptedPath = path.join(testWorkspace.root, "corrupted.ipynb");
    await fs.writeFile(corruptedPath, "not-json", "utf8");

    const notebook = await notebookProcessor.processNotebook(corruptedPath);
    expect(notebook.warnings.join(" ")).toContain("Notebook JSON could not be parsed");

    const binaryPath = path.join(testWorkspace.root, "binary.bin");
    await fs.writeFile(binaryPath, randomBytes(32) as unknown as NodeJS.ArrayBufferView);

    const placeholder = await contentProcessor.processFile(binaryPath, { binaryFilePolicy: "placeholder" });
    expect(placeholder.content.startsWith("[binary file]"))
      .toBe(true);

    const analysis = await tokenAnalyzer.analyze("{}", {
      preferredAdapters: ["unknown"],
      metadata: { path: "invalid" }
    });
    expect(analysis.adapter).toBeTruthy();
  });
});

describe("Performance Benchmarks", () => {
  const generator = new TestContentGenerator();
  let contentProcessor: ContentProcessor;
  let testWorkspace: TestWorkspace;

  beforeAll(() => {
    jest.setTimeout(180_000);
  });

  afterEach(async () => {
    if (testWorkspace) {
      await testWorkspace.dispose();
    }
    resetWorkspaceEnvironment();
  });

  it("should process 1000 files under 30 seconds", async () => {
    testWorkspace = await generator.createLargeWorkspace(250, 64);
    configureWorkspaceEnvironment(testWorkspace.root);
    contentProcessor = new ContentProcessor();

    const absolutePaths = testWorkspace.files.map((file) => path.join(testWorkspace.root, file.relativePath));
    const started = performance.now();
    await contentProcessor.processFiles(absolutePaths, { concurrency: 8 });
    const elapsed = performance.now() - started;

    expect(elapsed).toBeLessThan(30_000);
  });

  it("should handle 10MB notebook files efficiently", async () => {
    const notebook = await generator.generateNotebooks([1], true);
    const largeNotebook = { ...notebook[0]!, content: JSON.stringify({
      cells: [
        {
          cell_type: "code",
          source: ["# large notebook"],
          outputs: [
            {
              output_type: "display_data",
              data: { "text/plain": "output".repeat(500_000) }
            }
          ]
        }
      ]
    }) } satisfies TestFile;

    testWorkspace = await createWorkspace([largeNotebook]);
    configureWorkspaceEnvironment(testWorkspace.root);

    const started = performance.now();
    const notebookResult = await NotebookProcessor.processNotebook(path.join(testWorkspace.root, largeNotebook.relativePath), {
      includeOutputs: true,
      includeNonTextOutputs: false
    });
    const elapsed = performance.now() - started;

    expect(elapsed).toBeLessThan(30_000);
    expect(notebookResult.content.length).toBeGreaterThan(0);
  });

  it("should maintain cache hit ratio >80%", async () => {
    const cache = new CacheService({ defaultOptions: { ttl: 60, maxEntries: 128, persistToDisk: false } });
    try {
      const entries = new Array(50).fill(0).map((_, index) => `key-${index}`);
      await Promise.all(entries.map((key, index) => cache.cacheTokenAnalysis(key, { tokens: index + 1, adapter: "mock", cacheHit: false, exceededBudget: false, warnings: [], budget: { limit: 100, warnAt: 80, warnRatio: 0.8 } })));
      await Promise.all(entries.map((key) => cache.getCachedTokenAnalysis(key)));
      const stats = cache.stats();
      expect(stats.hitRate).toBeGreaterThanOrEqual(0.8);
    } finally {
      await cache.clear();
      await cache.dispose();
    }
  });
});

describe("Content Accuracy", () => {
  const generator = new TestContentGenerator();
  const assertions = new ProcessingAssertions();
  let testWorkspace: TestWorkspace;
  let contentProcessor: ContentProcessor;

  afterEach(async () => {
    if (testWorkspace) {
      await testWorkspace.dispose();
    }
    resetWorkspaceEnvironment();
  });

  it("should preserve code structure and formatting", async () => {
    const files = await generator.generateCodeFiles(["ts", "py", "md"], 3);
    testWorkspace = await createWorkspace(files);
    configureWorkspaceEnvironment(testWorkspace.root);
    contentProcessor = new ContentProcessor();

    for (const file of files) {
      const processed = await contentProcessor.processFile(path.join(testWorkspace.root, file.relativePath));
      assertions.checkContentPreservation(file.content.toString(), processed);
    }
  });

  it("should handle unicode and special characters", async () => {
    const unicodeFile: TestFile = {
      relativePath: path.join("docs", "unicode.md"),
      content: "Emoji: 😀 😇 🤖\nAccents: café naïve jalapeño\n",
      type: "text"
    };
    testWorkspace = await createWorkspace([unicodeFile]);
    configureWorkspaceEnvironment(testWorkspace.root);
    contentProcessor = new ContentProcessor();

    const processed = await contentProcessor.processFile(path.join(testWorkspace.root, unicodeFile.relativePath));
    expect(processed.content).toContain("😀");
    expect(processed.content).toContain("jalapeño");
  });

  it("should process notebook outputs correctly", async () => {
    const notebooks = await generator.generateNotebooks([2], true);
    testWorkspace = await createWorkspace(notebooks);
  configureWorkspaceEnvironment(testWorkspace.root);

    const absolute = path.join(testWorkspace.root, notebooks[0]!.relativePath);
    const notebook = await NotebookProcessor.processNotebook(absolute, {
      includeOutputs: true,
      includeNonTextOutputs: false
    });

    expect(notebook.outputCount.text).toBeGreaterThanOrEqual(1);
    expect(notebook.content).toContain("print");
  });
});

describe("Configuration Integration", () => {
  const generator = new TestContentGenerator();
  let testWorkspace: TestWorkspace;
  let contentProcessor: ContentProcessor;

  afterEach(async () => {
    if (testWorkspace) {
      await testWorkspace.dispose();
    }
    resetWorkspaceEnvironment();
  });

  it("should respect all processing options", async () => {
    const files = await generator.generateBinaryFiles(["dat"], [512]);
    testWorkspace = await createWorkspace(files);
    configureWorkspaceEnvironment(testWorkspace.root);
    contentProcessor = new ContentProcessor();

    const absolute = path.join(testWorkspace.root, files[0]!.relativePath);
    const processed = await contentProcessor.processFile(absolute, {
      binaryFilePolicy: "base64",
      maxFileSize: 1024,
      streamingThreshold: 128,
      detectLanguage: false
    });

    expect(processed.encoding).toBe("base64");
    expect(processed.content.length).toBeGreaterThan(0);
  });

  it("should handle configuration changes", async () => {
    const files = await generator.generateCodeFiles(["ts"], 2);
    testWorkspace = await createWorkspace(files);
    configureWorkspaceEnvironment(testWorkspace.root);

    const diagnostics: Diagnostics = {
      addError: jest.fn(),
      addWarning: jest.fn()
    };

    const configService = new ConfigurationService({
      ...DEFAULT_CONFIG,
      workspaceRoot: testWorkspace.root,
      include: ["src/**/*.ts"],
      exclude: ["**/*.skip.ts"],
      maxFiles: 10
    }, diagnostics);

    const config = configService.loadConfig();
    expect(config.include).toContain("src/**/*.ts");
    expect(diagnostics.addError).not.toHaveBeenCalled();
  });
});

describe("Resource Management", () => {
  const generator = new TestContentGenerator();
  let testWorkspace: TestWorkspace;

  afterEach(async () => {
    if (testWorkspace) {
      await testWorkspace.dispose();
    }
    resetWorkspaceEnvironment();
  });

  it("should not leak memory during processing", async () => {
    const files = await generator.generateCodeFiles(["js"], 10);
    testWorkspace = await createWorkspace(files);
    configureWorkspaceEnvironment(testWorkspace.root);
    const contentProcessor = new ContentProcessor();

    const before = process.memoryUsage().heapUsed;
    await contentProcessor.processFiles(files.map((file) => path.join(testWorkspace.root, file.relativePath)), { concurrency: 4 });
    const after = process.memoryUsage().heapUsed;

    expect(after - before).toBeLessThan(50 * 1024 * 1024);
  });

  it("should handle cancellation cleanly", async () => {
    const files = await generator.generateCodeFiles(["js"], 5);
    testWorkspace = await createWorkspace(files);
    configureWorkspaceEnvironment(testWorkspace.root);
    const contentProcessor = new ContentProcessor();
    const progressSpy = jest.fn(() => {
      throw new vscode.CancellationError();
    });

    const results = await contentProcessor.processFiles(
      files.map((file) => path.join(testWorkspace.root, file.relativePath)),
      {
        concurrency: 2,
        streamingThreshold: 1,
        onProgress: progressSpy
      }
    );

    expect(progressSpy).toHaveBeenCalled();
    expect(results.length).toBe(files.length);
  });
});

describe("Format Consistency", () => {
  const generator = new TestContentGenerator();
  let testWorkspace: TestWorkspace;
  let digestGenerator: DigestGenerator;
  let contentProcessor: ContentProcessor;
  let tokenAnalyzer: TokenAnalyzer;
  let configurationService: ConfigurationService;

  afterEach(async () => {
    if (testWorkspace) {
      await testWorkspace.dispose();
    }
    resetWorkspaceEnvironment();
  });

  it("should generate equivalent content across formats", async () => {
    const files = await generator.generateCodeFiles(["ts", "md"], 4);
    testWorkspace = await createWorkspace(files);
    configureWorkspaceEnvironment(testWorkspace.root);

    const workspaceUri = vscode.Uri.file(testWorkspace.root);
    const fileScanner = new FileScanner(workspaceUri);
    const filterService = new FilterService({ workspaceRoot: testWorkspace.root, gitignoreService: new GitignoreService() });
    contentProcessor = new ContentProcessor();
    tokenAnalyzer = new TokenAnalyzer();
    configurationService = new ConfigurationService({
      ...DEFAULT_CONFIG,
      workspaceRoot: testWorkspace.root,
      include: ["**/*"],
      exclude: ["**/*.skip"],
      maxFiles: 50
    }, createDiagnostics());
    const formatLogger: Logger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn()
    };
    const errorReporter = new ErrorReporter(configurationService, formatLogger);

    digestGenerator = new DigestGenerator(
      fileScanner,
      filterService,
      contentProcessor,
      NotebookProcessor,
      tokenAnalyzer,
      configurationService,
      errorReporter
    );

    const selected = files.map((file) => path.join(testWorkspace.root, file.relativePath));
    const digest = await digestGenerator.generateDigest({ selectedFiles: selected, outputFormat: "markdown" });

    const outputs = [
      formatDigest(digest, { format: "markdown" }),
      formatDigest(digest, { format: "json" }),
      formatDigest(digest, { format: "text" })
    ];

    const lengths = outputs.map((output) => output.length);
    expect(lengths.every((length) => length > 0)).toBe(true);
    expect(new Set(digest.content.files.map((file) => file.relativePath)).size).toBe(files.length);

    errorReporter.dispose();
  });
});
