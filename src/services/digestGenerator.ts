import * as path from "node:path";
import * as fs from "node:fs";
import { performance } from "node:perf_hooks";
import * as vscode from "vscode";

import { asyncPool } from "../utils/asyncPool";
import { redactSecrets } from "../utils/redactSecrets";
import type { DigestConfig } from "../utils/validateConfig";

// Load package version at runtime to avoid TypeScript including package.json
// in the compilation root (which causes TS6059 when rootDir is 'src').
const PACKAGE_VERSION = (() => {
  try {
    const pkgPath = path.resolve(__dirname, '..', '..', 'package.json');
    const raw = fs.readFileSync(pkgPath, 'utf8');
    return JSON.parse(raw).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();
import type { BinaryFilePolicy, ProcessedContent } from "./contentProcessor";
import type { FileNode as ScannerFileNode } from "./fileScanner";
import type { TokenBudgetOptions, CancelToken, AnalyzeOptions } from "./tokenAnalyzer";
import type { NotebookProcessingOptions, ProcessedNotebook } from "./notebookProcessor";
import type { FilterResult } from "./filterService";
import { createSkipStatsMap, recordFilterOutcome as recordFilterDiagnostic, buildSkipMessages } from "./filterDiagnostics";
import { FileScanner } from "./fileScanner";
import { FilterService } from "./filterService";
import { ContentProcessor } from "./contentProcessor";
import { NotebookProcessor } from "./notebookProcessor";
import { TokenAnalyzer } from "./tokenAnalyzer";
import { ConfigurationService } from "./configurationService";
import { ErrorReporter } from "./errorReporter";
import { TelemetryService } from "./telemetryService";
import { ErrorClassifier, type ErrorContext } from "../utils/errorHandler";

const DEFAULT_TOTAL_TOKEN_BUDGET = 16_000;
const DEFAULT_PROGRESS_SAMPLE_INTERVAL = 250;
const MIN_TRUNCATED_CONTENT_LENGTH = 128;
const MAX_TRUNCATION_ITERATIONS = 6;

export interface DigestOptions {
  selectedFiles: string[];
  outputFormat: "markdown" | "json" | "text";
  maxFiles?: number;
  maxTokens?: number;
  includeMetadata?: boolean;
  applyRedaction?: boolean;
  redactionOverride?: boolean;
  binaryFilePolicy?: BinaryFilePolicy;
  progressCallback?: (progress: GenerationProgress) => void;
  cancellationToken?: vscode.CancellationToken;
}

export interface GenerationProgress {
  phase: "scanning" | "processing" | "analyzing" | "generating" | "formatting" | "complete";
  filesProcessed: number;
  totalFiles: number;
  tokensProcessed: number;
  currentFile?: string;
  timeElapsed: number;
  estimatedTimeRemaining?: number;
  memoryUsage?: number;
}

export interface ProcessedFileContent {
  path: string;
  relativePath: string;
  tokens: number;
  content: string;
  languageId?: string;
  encoding: ProcessedContent["encoding"];
  truncated: boolean;
  redacted: boolean;
  metadata: {
    size?: number;
    lines?: number;
    checksum?: string;
    processingTime?: number;
    notebook?: {
      codeCells: number;
      markdownCells: number;
      rawCells: number;
      outputs: {
        text: number;
        nonText: number;
        skipped: number;
      };
      warnings: string[];
    };
  };
  warnings: string[];
  errors: string[];
}

export interface DigestSummary {
  overview: {
    totalFiles: number;
    includedFiles: number;
    skippedFiles: number;
    binaryFiles: number;
    totalTokens: number;
  };
  tableOfContents: Array<{ path: string; tokens: number; truncated: boolean }>;
  notes: string[];
}

export interface DigestMetadata {
  generatedAt: Date;
  workspaceRoot: string;
  totalFiles: number;
  includedFiles: number;
  skippedFiles: number;
  binaryFiles: number;
  tokenEstimate: number;
  processingTime: number;
  redactionApplied: boolean;
  generatorVersion: string;
}

export interface DigestResult {
  content: {
    files: ProcessedFileContent[];
    summary: DigestSummary;
    metadata: DigestMetadata;
  };
  statistics: {
    filesProcessed: number;
    totalTokens: number;
    processingTime: number;
    warnings: string[];
    errors: string[];
  };
  redactionApplied: boolean;
  truncationApplied: boolean;
}

interface FileCandidate {
  absolutePath: string;
  relativePath: string;
  scannerNode: ScannerFileNode;
}

interface FileProcessingOutcome {
  file?: ProcessedFileContent;
  warnings: string[];
  errors: string[];
  tokens: number;
  binary: boolean;
  truncated: boolean;
}

interface PipelineContext {
  config: DigestConfig;
  workspaceRoot: string;
  maxFiles: number;
  maxTokens: number;
  binaryPolicy: BinaryFilePolicy;
  includeMetadata: boolean;
  shouldRedact: boolean;
  cancellationToken?: vscode.CancellationToken;
}

interface ScannerResult {
  totalFiles: number;
  nodes: ScannerFileNode[];
}

export class DigestGenerator {
  private readonly errorClassifier = new ErrorClassifier();

  public constructor(
    private readonly fileScanner: FileScanner,
    private readonly filterService: FilterService,
    private readonly contentProcessor: ContentProcessor,
    private readonly notebookProcessor: typeof NotebookProcessor,
    private readonly tokenAnalyzer: TokenAnalyzer,
    private readonly configService: ConfigurationService,
    private readonly errorReporter: ErrorReporter,
    private readonly telemetry?: TelemetryService
  ) {}

  public async generateDigest(options: DigestOptions): Promise<DigestResult> {
    const startedAt = performance.now();
    const cpuStart = process.cpuUsage();
    this.telemetry?.trackFeatureUsage("digest.pipeline", { format: options.outputFormat });
    const emitProgress = this.createProgressEmitter(options.progressCallback, startedAt);

    this.ensureNotCancelled(options.cancellationToken);

    try {
      const config = this.configService.loadConfig();
      const context = this.resolvePipelineContext(options, config);
      this.ensureNotCancelled(context.cancellationToken);

      emitProgress("scanning", {
        filesProcessed: 0,
        totalFiles: 0,
        tokensProcessed: 0
      });

      const scannerResult = await this.scanWorkspace(emitProgress, context);
      this.ensureNotCancelled(context.cancellationToken);

      const { candidates, warnings: filterWarnings } = await this.filterCandidates(
        scannerResult.nodes,
        context,
        options,
        emitProgress
      );
      this.ensureNotCancelled(context.cancellationToken);
      const sortedCandidates = this.sortCandidatesByPriority(candidates);

      const limitedCandidates = sortedCandidates.slice(0, context.maxFiles);
      const truncationByCount = sortedCandidates.length > context.maxFiles;

      const processedFiles: ProcessedFileContent[] = [];
  const warnings: string[] = [];
  warnings.push(...filterWarnings);
      const errors: string[] = [];

      let tokensProcessed = 0;
      let filesProcessed = 0;
      let binaryFiles = 0;
      let truncationApplied = truncationByCount;

      const tasks = limitedCandidates.map((candidate) => async () => {
        this.ensureNotCancelled(context.cancellationToken);
        const outcome = await this.processFileCandidate(
          candidate,
          context,
          tokensProcessed,
          emitProgress,
          context.cancellationToken
        );
        this.ensureNotCancelled(context.cancellationToken);
        if (outcome.file) {
          processedFiles.push(outcome.file);
          filesProcessed += 1;
          tokensProcessed += outcome.tokens;
          if (outcome.binary) {
            binaryFiles += 1;
          }
          if (outcome.truncated) {
            truncationApplied = true;
          }
        }
        warnings.push(...outcome.warnings);
        errors.push(...outcome.errors);
      });

      await asyncPool(
        tasks,
        1,
        context.cancellationToken ? { cancellationToken: context.cancellationToken } : {}
      );
  this.ensureNotCancelled(context.cancellationToken);

      emitProgress("generating", {
        filesProcessed,
        totalFiles: limitedCandidates.length,
        tokensProcessed
      });

      const summary: DigestSummary = {
        overview: {
          totalFiles: scannerResult.totalFiles,
          includedFiles: processedFiles.length,
          skippedFiles: scannerResult.totalFiles - processedFiles.length,
          binaryFiles,
          totalTokens: tokensProcessed
        },
        tableOfContents: processedFiles
          .map((file) => ({ path: file.relativePath, tokens: file.tokens, truncated: file.truncated }))
          .sort((a, b) => a.path.localeCompare(b.path)),
        notes: [...warnings]
      } satisfies DigestSummary;

      emitProgress("formatting", {
        filesProcessed,
        totalFiles: limitedCandidates.length,
        tokensProcessed
      });
      this.ensureNotCancelled(context.cancellationToken);

      const metadata: DigestMetadata = {
        generatedAt: new Date(),
        workspaceRoot: context.workspaceRoot,
        totalFiles: scannerResult.totalFiles,
        includedFiles: processedFiles.length,
        skippedFiles: Math.max(scannerResult.totalFiles - processedFiles.length, 0),
        binaryFiles,
        tokenEstimate: tokensProcessed,
        processingTime: Math.round(performance.now() - startedAt),
        redactionApplied: context.shouldRedact,
        generatorVersion: PACKAGE_VERSION
      } satisfies DigestMetadata;

      emitProgress("complete", {
        filesProcessed,
        totalFiles: limitedCandidates.length,
        tokensProcessed
      });

      const result: DigestResult = {
        content: {
          files: processedFiles.sort((a, b) => a.relativePath.localeCompare(b.relativePath)),
          summary,
          metadata
        },
        statistics: {
          filesProcessed: processedFiles.length,
          totalTokens: tokensProcessed,
          processingTime: metadata.processingTime,
          warnings: [...new Set(warnings)],
          errors
        },
        redactionApplied: context.shouldRedact,
        truncationApplied
      } satisfies DigestResult;

      const durationMs = Math.round(performance.now() - startedAt);
      const cpuUsage = process.cpuUsage(cpuStart);
      const cpuMs = (cpuUsage.user + cpuUsage.system) / 1000;
      const memoryUsageMb =
        typeof process.memoryUsage === "function" ? process.memoryUsage().heapUsed / (1024 * 1024) : undefined;

      this.telemetry?.trackOperationDuration("digest.generate", durationMs, true);

      const performanceMeasurements: Record<string, number> = {
        cpuTimeMs: cpuMs,
        filesProcessed: processedFiles.length,
        tokensProcessed
      };
      if (memoryUsageMb !== undefined && Number.isFinite(memoryUsageMb)) {
        performanceMeasurements.memoryUsageMb = memoryUsageMb;
      }

      this.telemetry?.trackEvent(
        "performance.digest",
        {
          stage: "completed",
          format: options.outputFormat,
          redacted: context.shouldRedact,
          truncated: truncationApplied
        },
        performanceMeasurements
      );

      this.telemetry?.trackEvent(
        "digest.summary",
        {
          truncated: truncationApplied,
          binaryFiles,
          format: options.outputFormat
        },
        {
          filesProcessed: processedFiles.length,
          totalTokens: tokensProcessed,
          durationMs,
          warnings: warnings.length
        }
      );

      return result;
    } catch (error) {
      const durationMs = Math.round(performance.now() - startedAt);
      this.telemetry?.trackOperationDuration("digest.generate", durationMs, false);

      const cpuUsage = process.cpuUsage(cpuStart);
      const cpuMs = (cpuUsage.user + cpuUsage.system) / 1000;

      this.telemetry?.trackEvent(
        "performance.digest",
        {
          stage: "failed",
          format: options.outputFormat
        },
        {
          cpuTimeMs: cpuMs,
          durationMs
        }
      );

      if (error instanceof Error) {
        this.telemetry?.trackError(error, { component: "digestGenerator", operation: "generateDigest" });
      }

      throw error;
    }
  }

  private resolvePipelineContext(options: DigestOptions, config: DigestConfig): PipelineContext {
    const workspaceRoot = this.resolveWorkspaceRoot(config, options.selectedFiles);
    const maxFiles = Math.max(1, options.maxFiles ?? config.maxFiles ?? 5_000);
    const maxTokens = Math.max(1, options.maxTokens ?? DEFAULT_TOTAL_TOKEN_BUDGET);
    const binaryPolicy = (options.binaryFilePolicy ?? config.binaryFilePolicy ?? "skip") as BinaryFilePolicy;
    const includeMetadata = options.includeMetadata ?? true;
    const shouldRedact = options.redactionOverride ? false : options.applyRedaction ?? true;

    const context: PipelineContext = {
      config,
      workspaceRoot,
      maxFiles,
      maxTokens,
      binaryPolicy,
      includeMetadata,
      shouldRedact
    } satisfies PipelineContext;

    if (options.cancellationToken) {
      context.cancellationToken = options.cancellationToken;
    }

    return context;
  }

  private resolveWorkspaceRoot(config: DigestConfig, selectedFiles: string[]): string {
    if (typeof config.workspaceRoot === "string" && config.workspaceRoot.trim().length > 0) {
      return path.resolve(config.workspaceRoot);
    }

    for (const file of selectedFiles) {
      if (path.isAbsolute(file)) {
        return path.dirname(file);
      }
    }

    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  }

  private async scanWorkspace(
    emitProgress: ReturnType<typeof DigestGenerator.prototype.createProgressEmitter>,
    context: PipelineContext
  ): Promise<ScannerResult> {
    this.ensureNotCancelled(context.cancellationToken);
    const collected: ScannerFileNode[] = [];
    let total = 0;
    let lastEmit = 0;

    const nodes = await this.fileScanner.scan({
      maxEntries: context.maxFiles * 10,
      token: context.cancellationToken,
      onProgress: (processed, totalCount, currentPath) => {
        this.ensureNotCancelled(context.cancellationToken);
        total = totalCount ?? total;
        const now = performance.now();
        if (now - lastEmit >= DEFAULT_PROGRESS_SAMPLE_INTERVAL) {
          const state = {
            filesProcessed: processed,
            totalFiles: totalCount ?? total,
            tokensProcessed: 0,
            ...(currentPath ? { currentFile: currentPath } : {})
          };
          emitProgress("scanning", state);
          lastEmit = now;
        }
      }
    });

    collected.push(...nodes);

    const totalFiles = collected.filter((node) => node.type === "file").length;

    emitProgress("scanning", {
      filesProcessed: totalFiles,
      totalFiles,
      tokensProcessed: 0
    });

    this.ensureNotCancelled(context.cancellationToken);
    return { totalFiles, nodes: collected } satisfies ScannerResult;
  }

  private async filterCandidates(
    nodes: ScannerFileNode[],
    context: PipelineContext,
    options: DigestOptions,
    emitProgress: ReturnType<typeof DigestGenerator.prototype.createProgressEmitter>
  ): Promise<{ candidates: FileCandidate[]; warnings: string[] }> {
    this.ensureNotCancelled(context.cancellationToken);
    const files = nodes.filter((node) => node.type === "file");
    const absolutePaths = files.map((node) => vscode.Uri.parse(node.uri).fsPath);

    const filterResults = await this.filterService.batchFilter(absolutePaths, {
      includePatterns: context.config.include ?? [],
      excludePatterns: context.config.exclude ?? [],
      useGitignore: context.config.respectGitIgnore ?? true,
      followSymlinks: context.config.followSymlinks ?? false,
      ...(typeof context.config.maxDepth === "number" ? { maxDepth: context.config.maxDepth } : {})
    });

    const selectedAbsolute = new Set(
      options.selectedFiles.map((file) => (path.isAbsolute(file) ? path.normalize(file) : path.resolve(context.workspaceRoot, file)))
    );

    const candidates: FileCandidate[] = [];
    const skipStats = createSkipStatsMap();

    files.forEach((node, index) => {
      this.ensureNotCancelled(context.cancellationToken);
      const absolutePath = absolutePaths[index];
      const filterResult = filterResults.get(absolutePath);
      const relativePathRaw = path.relative(context.workspaceRoot, absolutePath) || path.basename(absolutePath);
      const normalizedRelativePath = relativePathRaw.split(path.sep).join("/");

      if (!this.shouldIncludeFile(filterResult)) {
        recordFilterDiagnostic(skipStats, normalizedRelativePath, filterResult);
        return;
      }

      if (selectedAbsolute.size > 0 && !selectedAbsolute.has(path.normalize(absolutePath))) {
        return;
      }

      candidates.push({
        absolutePath,
        relativePath: normalizedRelativePath,
        scannerNode: node
      });
    });

    emitProgress("processing", {
      filesProcessed: 0,
      totalFiles: candidates.length,
      tokensProcessed: 0
    });

    const warnings = buildSkipMessages(skipStats, {
      followSymlinks: context.config.followSymlinks ?? false,
      ...(typeof context.config.maxDepth === "number" ? { maxDepth: context.config.maxDepth } : {})
    });

    return { candidates, warnings };
  }

  private shouldIncludeFile(result: FilterResult | undefined): boolean {
    if (!result) {
      return true;
    }
    return result.included;
  }

  private sortCandidatesByPriority(candidates: FileCandidate[]): FileCandidate[] {
    const priorityMap = new Map<string, number>();

    candidates.forEach((candidate) => {
      priorityMap.set(candidate.absolutePath, this.computePriority(candidate.absolutePath));
    });

    return [...candidates].sort((a, b) => {
      const priorityDiff = (priorityMap.get(b.absolutePath) ?? 0) - (priorityMap.get(a.absolutePath) ?? 0);
      if (priorityDiff !== 0) {
        return priorityDiff;
      }
      return a.relativePath.localeCompare(b.relativePath);
    });
  }

  private computePriority(absolutePath: string): number {
    const lower = absolutePath.toLowerCase();
    if (/(package|yarn|pnpm)\.json$/.test(lower)) {
      return 100;
    }
    if (/\b(tsconfig|webpack|rollup|babel|vite)\.\w+$/.test(lower)) {
      return 80;
    }
    if (/\breadme|\.md$/.test(lower)) {
      return 60;
    }
    if (/\bconfig/.test(lower) || /\.env/.test(lower)) {
      return 40;
    }
    if (/\.test\./.test(lower) || /\.spec\./.test(lower)) {
      return 10;
    }
    return 20;
  }

  private async processFileCandidate(
    candidate: FileCandidate,
    context: PipelineContext,
    tokensProcessedSoFar: number,
    emitProgress: ReturnType<typeof DigestGenerator.prototype.createProgressEmitter>,
    cancellationToken?: vscode.CancellationToken
  ): Promise<FileProcessingOutcome> {
    const warnings: string[] = [];
    const errors: string[] = [];

    this.ensureNotCancelled(cancellationToken);
    emitProgress("processing", {
      filesProcessed: 0,
      totalFiles: 0,
      tokensProcessed: tokensProcessedSoFar,
      currentFile: candidate.relativePath
    });

    let processedContent: ProcessedContent;
    let notebookDetails: ProcessedNotebook | undefined;

    try {
      processedContent = await this.contentProcessor.processFile(candidate.absolutePath, {
        binaryFilePolicy: context.binaryPolicy,
        detectLanguage: true
      });
      this.ensureNotCancelled(cancellationToken);

      if (candidate.absolutePath.toLowerCase().endsWith(".ipynb")) {
        notebookDetails = await this.notebookProcessor.processNotebook(candidate.absolutePath, this.resolveNotebookOptions(context.config));
        warnings.push(...notebookDetails.warnings.map((message) => `${candidate.relativePath}: ${message}`));
      }
      this.ensureNotCancelled(cancellationToken);
    } catch (error) {
      const normalizedError = error instanceof Error ? error : new Error(this.stringifyError(error));
      const message = normalizedError.message;
      errors.push(`${candidate.relativePath}: failed to process content (${message}).`);
      this.reportError(normalizedError, {
        operation: "processFile",
        component: "digestGenerator",
        metadata: { file: candidate.absolutePath, stage: "process" },
        userFacing: false
      });
      return {
        warnings,
        errors,
        tokens: 0,
        binary: false,
        truncated: false
      } satisfies FileProcessingOutcome;
    }

    this.ensureNotCancelled(cancellationToken);
    const analysis = await this.analyzeContent(
      candidate,
      processedContent.content,
      context,
      tokensProcessedSoFar,
      warnings,
      errors,
      emitProgress,
      cancellationToken
    );
    const finalContent = context.shouldRedact ? redactSecrets(analysis.content) : analysis.content;

    const metadata: ProcessedFileContent["metadata"] = {};
    if (context.includeMetadata) {
      if (typeof processedContent.size === "number") {
        metadata.size = processedContent.size;
      }
      const lineCount = processedContent.metadata?.lines;
      if (typeof lineCount === "number") {
        metadata.lines = lineCount;
      }
      const checksum = processedContent.metadata?.checksum;
      if (typeof checksum === "string") {
        metadata.checksum = checksum;
      }
      if (typeof processedContent.processingTime === "number") {
        metadata.processingTime = processedContent.processingTime;
      }
      if (notebookDetails) {
        metadata.notebook = {
          codeCells: notebookDetails.cellCount.code,
          markdownCells: notebookDetails.cellCount.markdown,
          rawCells: notebookDetails.cellCount.raw,
          outputs: notebookDetails.outputCount,
          warnings: notebookDetails.warnings
        };
      }
    } else if (notebookDetails) {
      metadata.notebook = {
        codeCells: notebookDetails.cellCount.code,
        markdownCells: notebookDetails.cellCount.markdown,
        rawCells: notebookDetails.cellCount.raw,
        outputs: notebookDetails.outputCount,
        warnings: notebookDetails.warnings
      };
    }

    const file: ProcessedFileContent = {
      path: candidate.absolutePath,
      relativePath: candidate.relativePath,
      tokens: analysis.tokens,
      content: finalContent,
      languageId: processedContent.language,
      encoding: processedContent.encoding,
      truncated: processedContent.isTruncated || analysis.truncated,
      redacted: context.shouldRedact,
      metadata,
      warnings: [...warnings],
      errors: [...errors]
    } satisfies ProcessedFileContent;

    return {
      file,
      warnings,
      errors,
      tokens: analysis.tokens,
      binary: processedContent.encoding !== "utf8",
      truncated: file.truncated
    } satisfies FileProcessingOutcome;
  }

  private resolveNotebookOptions(config: DigestConfig): NotebookProcessingOptions {
    return {
      includeCodeCells: config.includeCodeCells ?? true,
      includeMarkdownCells: config.includeMarkdownCells ?? true,
      includeOutputs: config.includeCellOutputs ?? false,
      includeNonTextOutputs: false,
      nonTextOutputMaxBytes: 256 * 1024,
      cellSeparator: "\n\n",
      outputSeparator: "\n",
      preserveMarkdownFormatting: true
    } satisfies NotebookProcessingOptions;
  }

  private async analyzeContent(
    candidate: FileCandidate,
    content: string,
    context: PipelineContext,
    tokensProcessedSoFar: number,
    warnings: string[],
    errors: string[],
    emitProgress: ReturnType<typeof DigestGenerator.prototype.createProgressEmitter>,
    cancellationToken?: vscode.CancellationToken
  ): Promise<{ content: string; tokens: number; truncated: boolean }> {
    this.ensureNotCancelled(cancellationToken);
    emitProgress("analyzing", {
      filesProcessed: 0,
      totalFiles: 0,
      tokensProcessed: tokensProcessedSoFar,
      currentFile: candidate.relativePath
    });

    const remainingBudget = Math.max(context.maxTokens - tokensProcessedSoFar, 0);

    try {
      const analyzerOptions: AnalyzeOptions = {
        metadata: { path: candidate.relativePath },
        budget: this.buildBudgetOptions(context.maxTokens)
      };
      const analyzerCancelToken = this.toAnalyzerCancelToken(cancellationToken);
      if (analyzerCancelToken) {
        analyzerOptions.cancelToken = analyzerCancelToken;
      }

      const analysis = await this.tokenAnalyzer.analyze(content, analyzerOptions);

      warnings.push(...analysis.warnings.map((warning) => `${candidate.relativePath}: ${warning}`));

      this.ensureNotCancelled(cancellationToken);
      if (remainingBudget <= 0) {
        warnings.push(`${candidate.relativePath}: token budget exhausted before processing.`);
        return {
          content: this.buildTruncationNotice(content, candidate.relativePath, 0),
          tokens: 0,
          truncated: true
        };
      }

      if (tokensProcessedSoFar + analysis.tokens <= context.maxTokens) {
        this.ensureNotCancelled(cancellationToken);
        return {
          content,
          tokens: analysis.tokens,
          truncated: analysis.exceededBudget
        };
      }

  return this.truncateToBudget(content, candidate, context, remainingBudget, warnings, cancellationToken);
    } catch (error) {
      const normalizedError = error instanceof Error ? error : new Error(this.stringifyError(error));
      const message = normalizedError.message;
      errors.push(`${candidate.relativePath}: token analysis failed (${message}).`);
      this.reportError(normalizedError, {
        operation: "tokenAnalyze",
        component: "digestGenerator",
        metadata: { file: candidate.absolutePath, stage: "analyze" },
        userFacing: false
      });
      return {
        content: this.buildTruncationNotice(content, candidate.relativePath, 0),
        tokens: 0,
        truncated: true
      };
    }
  }

  private buildBudgetOptions(limit: number): TokenBudgetOptions {
    const warnRatio = 0.85;
    return {
      limit,
      warnRatio,
      warnAt: Math.floor(limit * warnRatio),
      failOnExceed: false
    } satisfies TokenBudgetOptions;
  }

  private async truncateToBudget(
    content: string,
    candidate: FileCandidate,
    context: PipelineContext,
    remainingTokens: number,
    warnings: string[],
    cancellationToken?: vscode.CancellationToken
  ): Promise<{ content: string; tokens: number; truncated: boolean }> {
    this.ensureNotCancelled(cancellationToken);
    if (remainingTokens <= 0) {
      warnings.push(`${candidate.relativePath}: excluded due to token budget.`);
      return {
        content: this.buildTruncationNotice(content, candidate.relativePath, 0),
        tokens: 0,
        truncated: true
      };
    }

    let truncatedContent = content;
    let estimatedTokens = Math.max(1, TokenAnalyzer.estimate(truncatedContent));
    let iterations = 0;

    while (iterations < MAX_TRUNCATION_ITERATIONS && estimatedTokens > remainingTokens && truncatedContent.length > MIN_TRUNCATED_CONTENT_LENGTH) {
      this.ensureNotCancelled(cancellationToken);
      const ratio = Math.max(0.1, remainingTokens / estimatedTokens);
      const nextLength = Math.max(MIN_TRUNCATED_CONTENT_LENGTH, Math.floor(truncatedContent.length * ratio));
      truncatedContent = truncatedContent.slice(0, nextLength);

      const analysisOptions: AnalyzeOptions = {
        metadata: { path: candidate.relativePath, truncated: true },
        budget: this.buildBudgetOptions(remainingTokens),
        skipCache: true
      };
      const analyzerCancelToken = this.toAnalyzerCancelToken(cancellationToken);
      if (analyzerCancelToken) {
        analysisOptions.cancelToken = analyzerCancelToken;
      }

      const analysis = await this.tokenAnalyzer.analyze(truncatedContent, analysisOptions);
      this.ensureNotCancelled(cancellationToken);
      estimatedTokens = analysis.tokens;
      iterations += 1;
    }

    this.ensureNotCancelled(cancellationToken);
    const tokens = Math.min(estimatedTokens, remainingTokens);
    warnings.push(`${candidate.relativePath}: truncated to fit token budget.`);

    return {
      content: this.buildTruncationNotice(truncatedContent, candidate.relativePath, remainingTokens - tokens),
      tokens,
      truncated: true
    };
  }

  private buildTruncationNotice(content: string, relativePath: string, remainingTokens: number): string {
    const head = content.split(/\r?\n/).slice(0, 50).join("\n");
    return [
      head,
      "",
      `[[TRUNCATED]] ${relativePath}: token budget limit reached. Remaining allowance: ${remainingTokens} tokens.`
    ].join("\n");
  }

  private ensureNotCancelled(token?: vscode.CancellationToken): void {
    if (token?.isCancellationRequested) {
      throw new vscode.CancellationError();
    }
  }

  private toAnalyzerCancelToken(token?: vscode.CancellationToken): CancelToken | undefined {
    if (!token) {
      return undefined;
    }
    return {
      isCancelled: () => token.isCancellationRequested,
      onCancel: (callback: () => void) => {
        token.onCancellationRequested(callback);
      }
    };
  }

  private stringifyError(error: unknown): string {
    if (error instanceof Error && typeof error.message === "string") {
      return error.message;
    }
    return typeof error === "string" ? error : JSON.stringify(error);
  }

  private reportError(error: Error, context: ErrorContext): void {
    try {
      const classification = this.errorClassifier.classifyError(error, context);
      const errorId = `DIGEST-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
      void this.errorReporter
        .reportError(error, {
          ...context,
          errorId,
          classification
        })
        .catch(() => undefined);
    } catch {
      // Swallow reporter errors to keep pipeline resilient.
    }
  }

  private createProgressEmitter(
    callback: DigestOptions["progressCallback"],
    startedAt: number
  ): (
    phase: GenerationProgress["phase"],
    state: { filesProcessed: number; totalFiles: number; tokensProcessed: number; currentFile?: string }
  ) => void {
    return (phase, state) => {
      if (!callback) {
        return;
      }

      const elapsed = performance.now() - startedAt;
      const estimatedRemaining = this.estimateTimeRemaining(state.filesProcessed, state.totalFiles, elapsed);
      const memoryUsage = typeof process.memoryUsage === "function" ? process.memoryUsage().rss / (1024 * 1024) : undefined;

      const progress: GenerationProgress = {
        phase,
        filesProcessed: state.filesProcessed,
        totalFiles: state.totalFiles,
        tokensProcessed: state.tokensProcessed,
        timeElapsed: elapsed,
        ...(state.currentFile ? { currentFile: state.currentFile } : {}),
        ...(estimatedRemaining !== undefined ? { estimatedTimeRemaining: estimatedRemaining } : {}),
        ...(memoryUsage !== undefined ? { memoryUsage } : {})
      } satisfies GenerationProgress;

      try {
        callback(progress);
      } catch {
        // Ignore listener failures.
      }
    };
  }

  private estimateTimeRemaining(processed: number, total: number, elapsedMs: number): number | undefined {
    if (processed <= 0 || processed > total) {
      return undefined;
    }
    const avg = elapsedMs / processed;
    const remaining = total - processed;
    return Math.max(remaining, 0) * avg;
  }
}