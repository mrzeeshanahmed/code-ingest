import { Buffer } from "node:buffer";
import * as fs from "node:fs";
import { promises as fsp } from "node:fs";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import * as os from "node:os";
import * as vscode from "vscode";

import { asyncPool } from "../utils/asyncPool";
import { wrapError } from "../utils/errorHandling";
import { NotebookProcessor } from "./notebookProcessor";

export type BinaryFilePolicy = "skip" | "base64" | "placeholder";

export interface ProcessedContentMetadata {
  readonly lines: number;
  readonly checksum?: string;
  readonly truncatedBytes?: number;
  readonly [key: string]: unknown;
}

export interface ProcessedContent {
  readonly content: string;
  readonly language: string;
  readonly encoding: "utf8" | "base64" | "binary-placeholder";
  readonly size: number;
  readonly isTruncated: boolean;
  readonly processingTime: number;
  readonly metadata?: ProcessedContentMetadata;
}

export interface ProcessingOptions {
  readonly binaryFilePolicy?: BinaryFilePolicy;
  readonly maxFileSize?: number;
  readonly streamingThreshold?: number;
  readonly encoding?: BufferEncoding;
  readonly detectLanguage?: boolean;
  readonly whitelistExtensions?: string[];
  readonly blacklistExtensions?: string[];
  readonly languageOverride?: string;
  readonly onProgress?: (progress: { bytesRead: number; totalBytes?: number; done?: boolean }) => void;
  readonly timeoutMs?: number;
  readonly concurrency?: number;
}

interface ResolvedProcessingOptions {
  readonly binaryFilePolicy: BinaryFilePolicy;
  readonly maxFileSize: number;
  readonly streamingThreshold: number;
  readonly encoding: BufferEncoding;
  readonly detectLanguage: boolean;
  readonly whitelistExtensions: Set<string>;
  readonly blacklistExtensions: Set<string>;
  readonly languageOverride: string | undefined;
  readonly onProgress: ((progress: { bytesRead: number; totalBytes?: number; done?: boolean }) => void) | undefined;
  readonly timeoutMs: number;
  readonly concurrency: number;
}

interface BinaryDetectionResult {
  readonly isBinary: boolean;
  readonly reason?: string;
  readonly sample: Buffer;
}

interface ContentProcessorDependencies {
  readonly logger?: (message: string, metadata?: Record<string, unknown>) => void;
  readonly now?: () => number;
  readonly languageDetector?: (filePath: string, content: string) => Promise<string | undefined>;
}

const DEFAULT_MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
const DEFAULT_STREAMING_THRESHOLD = 1 * 1024 * 1024; // 1MB
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_ENCODING: BufferEncoding = "utf8";
const DEFAULT_BINARY_POLICY: BinaryFilePolicy = "skip";
const DEFAULT_CONCURRENCY = 4;
const SAMPLE_BYTES = 8192;
const CHECKSUM_SAMPLE_BYTES = 2048;
const BINARY_SIGNATURES: Array<{ signature: Buffer; offset: number }> = [
  { signature: Buffer.from("%PDF-", "ascii"), offset: 0 },
  { signature: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), offset: 0 },
  { signature: Buffer.from([0xff, 0xd8, 0xff]), offset: 0 },
  { signature: Buffer.from("PK\u0003\u0004", "binary"), offset: 0 },
  { signature: Buffer.from("GIF87a", "ascii"), offset: 0 },
  { signature: Buffer.from("GIF89a", "ascii"), offset: 0 },
  { signature: Buffer.from([0x4d, 0x5a]), offset: 0 }
];

const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".bmp",
  ".ico",
  ".zip",
  ".gz",
  ".tar",
  ".7z",
  ".rar",
  ".pdf",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".bin",
  ".dat",
  ".class",
  ".jar",
  ".wasm",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf"
]);

const LANGUAGE_BY_EXTENSION = new Map<string, string>([
  [".ts", "typescript"],
  [".tsx", "typescriptreact"],
  [".js", "javascript"],
  [".jsx", "javascriptreact"],
  [".json", "json"],
  [".css", "css"],
  [".scss", "scss"],
  [".sass", "scss"],
  [".html", "html"],
  [".md", "markdown"],
  [".py", "python"],
  [".rb", "ruby"],
  [".java", "java"],
  [".go", "go"],
  [".rs", "rust"],
  [".c", "c"],
  [".h", "c"],
  [".cpp", "cpp"],
  [".hpp", "cpp"],
  [".cs", "csharp"],
  [".swift", "swift"],
  [".kt", "kotlin"],
  [".m", "objective-c"],
  [".mm", "objective-cpp"],
  [".sh", "shellscript"],
  [".yml", "yaml"],
  [".yaml", "yaml"],
  [".toml", "toml"],
  [".ini", "ini"],
  [".sql", "sql"],
  [".ipynb", "json"],
  [".svg", "xml"],
  [".xml", "xml"]
]);

function normalizeLineEndings(input: string): string {
  return input.replace(/\r\n/g, "\n");
}

function concatChunks(chunks: Buffer[], totalLength?: number): Buffer {
  const targetLength = totalLength ?? chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  if (targetLength <= 0) {
    return Buffer.alloc(0);
  }
  const result = new Uint8Array(targetLength);
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= targetLength) {
      break;
    }
    const remaining = targetLength - offset;
    const writable = Math.min(chunk.length, remaining);
    if (writable > 0) {
      result.set(chunk.subarray(0, writable), offset);
      offset += writable;
    }
  }
  const finalLength = Math.min(offset, targetLength);
  return Buffer.from(result.buffer, result.byteOffset, finalLength);
}

function bufferMatchesSignature(sample: Buffer, signature: Buffer, offset: number): boolean {
  if (offset < 0 || offset + signature.length > sample.length) {
    return false;
  }
  for (let index = 0; index < signature.length; index += 1) {
    if (sample[offset + index] !== signature[index]) {
      return false;
    }
  }
  return true;
}

export class ContentProcessor {
  private readonly logger: ContentProcessorDependencies["logger"];
  private readonly now: () => number;
  private readonly externalLanguageDetector: ((filePath: string, content: string) => Promise<string | undefined>) | undefined;

  constructor(dependencies: ContentProcessorDependencies = {}) {
    this.logger = dependencies.logger;
    this.now = dependencies.now ?? (() => performance.now());
    this.externalLanguageDetector = dependencies.languageDetector ?? undefined;
  }

  public async processFile(filePath: string, options: ProcessingOptions = {}): Promise<ProcessedContent> {
    const resolvedPath = path.resolve(filePath);
    const resolvedOptions = this.resolveOptions(options);
    const startedAt = this.now();

    let stats: fs.Stats;
    try {
      stats = await fsp.stat(resolvedPath);
    } catch (error) {
      throw wrapError(error, { filePath: resolvedPath, stage: "stat" });
    }

    if (!stats.isFile()) {
      throw wrapError(new Error("Target is not a file"), { filePath: resolvedPath });
    }

    if (resolvedPath.toLowerCase().endsWith(".ipynb")) {
      return this.processNotebook(resolvedPath, stats, resolvedOptions, startedAt);
    }

    if (stats.size === 0) {
      return this.buildResult({
        encoding: "utf8",
        content: "",
        size: 0,
        isTruncated: false,
        startedAt,
        options: resolvedOptions,
        language: resolvedOptions.languageOverride ?? "plaintext"
      });
    }

    if (stats.size > resolvedOptions.streamingThreshold) {
      return this.processFileStream(resolvedPath, options, stats, startedAt);
    }

    try {
      const buffer = await fsp.readFile(resolvedPath);
      const detection = await this.analyseBinary(resolvedPath, buffer, stats, resolvedOptions);
      if (detection.isBinary) {
        return this.handleBinary(resolvedPath, stats.size, detection, startedAt, resolvedOptions);
      }

      const content = normalizeLineEndings(buffer.toString(resolvedOptions.encoding));
      const language = await this.resolveLanguage(resolvedPath, content, resolvedOptions);
      return this.buildResult({
        encoding: "utf8",
        content,
        size: stats.size,
        isTruncated: stats.size > resolvedOptions.maxFileSize,
        startedAt,
        options: resolvedOptions,
        language,
        truncatedBytes: Math.max(0, stats.size - resolvedOptions.maxFileSize)
      });
    } catch (error) {
      throw wrapError(error, { filePath: resolvedPath, stage: "read" });
    }
  }

  public async processFileStream(
    filePath: string,
    options: ProcessingOptions = {},
    stats?: fs.Stats,
    startedAt: number = this.now()
  ): Promise<ProcessedContent> {
    const resolvedPath = path.resolve(filePath);
    const resolvedOptions = this.resolveOptions(options);
    const fileStats = stats ?? (await fsp.stat(resolvedPath));

    if (resolvedPath.toLowerCase().endsWith(".ipynb")) {
      return this.processNotebook(resolvedPath, fileStats, resolvedOptions, startedAt);
    }

    const sample = await this.readSampleBuffer(resolvedPath, resolvedOptions);
    const detection = await this.analyseBinary(resolvedPath, sample, fileStats, resolvedOptions);
    if (detection.isBinary) {
      return this.handleBinary(resolvedPath, fileStats.size, detection, startedAt, resolvedOptions);
    }

  const streamResult = await this.consumeStream(resolvedPath, fileStats, resolvedOptions);
    const language = await this.resolveLanguage(resolvedPath, streamResult.content, resolvedOptions);
    return this.buildResult({
      encoding: "utf8",
      content: streamResult.content,
      size: fileStats.size,
      isTruncated: streamResult.truncated,
      startedAt,
      options: resolvedOptions,
      language,
      truncatedBytes: streamResult.truncatedBytes
    });
  }

  public async detectBinaryFile(filePath: string): Promise<boolean> {
    const resolvedPath = path.resolve(filePath);
    const defaults = this.resolveOptions({});
    const sample = await this.readSampleBuffer(resolvedPath, defaults);
    const stats = await fsp.stat(resolvedPath);
    const detection = await this.analyseBinary(resolvedPath, sample, stats, defaults);
    return detection.isBinary;
  }

  public async detectLanguage(filePath: string, content?: string): Promise<string> {
    return this.resolveLanguage(filePath, content ?? "", this.resolveOptions({ detectLanguage: true }));
  }

  public estimateLines(content: string): number {
    if (!content) {
      return 0;
    }
    const normalized = content.endsWith("\n") ? content.slice(0, -1) : content;
    if (!normalized) {
      return content.endsWith("\n") ? 1 : 0;
    }
    return normalized.split(/\n/).length + (content.endsWith("\n") ? 1 : 0);
  }

  public async processFiles(filePaths: string[], options: ProcessingOptions = {}): Promise<ProcessedContent[]> {
    const resolvedOptions = this.resolveOptions(options);
    const factories = filePaths.map((filePath) => () => this.processFile(filePath, options));
    return asyncPool(factories, resolvedOptions.concurrency);
  }

  private resolveOptions(options: ProcessingOptions): ResolvedProcessingOptions {
    const configuration = vscode.workspace.getConfiguration("codeIngest");
    const binaryPolicy = (options.binaryFilePolicy ?? configuration.get<BinaryFilePolicy>("binaryFilePolicy") ?? DEFAULT_BINARY_POLICY) as BinaryFilePolicy;
    let maxFileSize = options.maxFileSize ?? configuration.get<number>("maxFileSize") ?? DEFAULT_MAX_FILE_SIZE;
    if (maxFileSize <= 0) {
      this.logger?.("contentProcessor.options.adjusted", { reason: "maxFileSize", provided: maxFileSize });
      maxFileSize = DEFAULT_MAX_FILE_SIZE;
    }

    let streamingThreshold = options.streamingThreshold ?? configuration.get<number>("streamingThreshold") ?? DEFAULT_STREAMING_THRESHOLD;
    if (streamingThreshold <= 0) {
      streamingThreshold = Math.min(DEFAULT_STREAMING_THRESHOLD, maxFileSize);
    }
    if (streamingThreshold > maxFileSize) {
      this.logger?.("contentProcessor.options.adjusted", {
        reason: "streamingThreshold",
        streamingThreshold,
        maxFileSize
      });
      streamingThreshold = maxFileSize;
    }

    const detectLanguage = options.detectLanguage ?? configuration.get<boolean>("detectLanguage") ?? true;
    const encoding = options.encoding ?? (configuration.get<BufferEncoding>("encoding") ?? DEFAULT_ENCODING);
    const timeoutMs = options.timeoutMs ?? configuration.get<number>("processingTimeout") ?? DEFAULT_TIMEOUT_MS;

    const requestedConcurrency = Math.max(1, options.concurrency ?? configuration.get<number>("processingConcurrency") ?? DEFAULT_CONCURRENCY);
    const concurrency = this.computeAdaptiveConcurrency(requestedConcurrency);
    if (concurrency !== requestedConcurrency) {
      this.logger?.("contentProcessor.options.concurrency", {
        requested: requestedConcurrency,
        effective: concurrency
      });
    }

    const whitelist = new Set((options.whitelistExtensions ?? configuration.get<string[]>("binaryWhitelist") ?? []).map((ext) => ext.toLowerCase()));
    const blacklist = new Set((options.blacklistExtensions ?? configuration.get<string[]>("binaryBlacklist") ?? []).map((ext) => ext.toLowerCase()));
    for (const extension of whitelist) {
      if (blacklist.has(extension)) {
        blacklist.delete(extension);
      }
    }

    return {
      binaryFilePolicy: binaryPolicy,
      maxFileSize,
      streamingThreshold,
      detectLanguage,
      encoding,
      timeoutMs,
      concurrency,
      whitelistExtensions: whitelist,
      blacklistExtensions: blacklist,
      languageOverride: options.languageOverride ?? undefined,
      onProgress: options.onProgress
    };
  }

  private async processNotebook(
    filePath: string,
    stats: fs.Stats,
    options: ResolvedProcessingOptions,
    startedAt: number
  ): Promise<ProcessedContent> {
    let raw: string;
    try {
      raw = await fsp.readFile(filePath, "utf8");
    } catch (error) {
      throw wrapError(error, { filePath, stage: "read-notebook" });
    }

    const converted = NotebookProcessor.buildNotebookContent(raw, {
      binaryFilePolicy: options.binaryFilePolicy
    } as never);

    const normalized = normalizeLineEndings(converted ?? "");
    const language = options.languageOverride ?? "json";
    return this.buildResult({
      encoding: "utf8",
      content: normalized,
      size: stats.size,
      isTruncated: stats.size > options.maxFileSize,
      startedAt,
      options,
      language,
      truncatedBytes: Math.max(0, stats.size - options.maxFileSize)
    });
  }

  private async readSampleBuffer(filePath: string, options: ResolvedProcessingOptions): Promise<Buffer> {
    const sampleSize = Math.max(1, Math.min(SAMPLE_BYTES, options.streamingThreshold));
    const highWaterMark = Math.min(sampleSize, 64 * 1024);

    return new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let collected = 0;
      const stream = fs.createReadStream(filePath, { start: 0, highWaterMark });

      stream.on("data", (chunk: Buffer) => {
        if (collected >= sampleSize) {
          return;
        }
        const remaining = sampleSize - collected;
        if (chunk.length >= remaining) {
          chunks.push(chunk.slice(0, remaining));
          collected += remaining;
          stream.destroy();
        } else {
          chunks.push(chunk);
          collected += chunk.length;
          if (collected >= sampleSize) {
            stream.destroy();
          }
        }
      });

      stream.once("error", (error) => {
        reject(error);
      });

      stream.once("close", () => {
        resolve(concatChunks(chunks, Math.min(collected, sampleSize)));
      });
    });
  }

  private async analyseBinary(
    filePath: string,
    sample: Buffer,
    stats: fs.Stats,
    options: ResolvedProcessingOptions
  ): Promise<BinaryDetectionResult> {
    const ext = path.extname(filePath).toLowerCase();
    if (options.whitelistExtensions.has(ext)) {
      return { isBinary: false, sample };
    }
    if (options.blacklistExtensions.has(ext)) {
      return { isBinary: true, reason: "blacklist", sample };
    }

    if (this.matchesBinarySignature(sample)) {
      return { isBinary: true, reason: "signature", sample };
    }

    if (BINARY_EXTENSIONS.has(ext)) {
      return { isBinary: true, reason: "extension", sample };
    }

    if (this.containsNullBytes(sample)) {
      return { isBinary: true, reason: "null-bytes", sample };
    }

    const entropy = this.calculateEntropy(sample);
    const density = this.nonPrintableRatio(sample);
    if (entropy > 4.5 && density > 0.3) {
      return { isBinary: true, reason: "entropy", sample };
    }

    if (stats.size > options.maxFileSize && !options.detectLanguage) {
      return { isBinary: true, reason: "oversize", sample };
    }

    return { isBinary: false, sample };
  }

  private matchesBinarySignature(sample: Buffer): boolean {
    return BINARY_SIGNATURES.some(({ signature, offset }) => bufferMatchesSignature(sample, signature, offset));
  }

  private containsNullBytes(sample: Buffer): boolean {
    for (let index = 0; index < sample.length; index += 1) {
      if (sample[index] === 0) {
        return true;
      }
    }
    return false;
  }

  private calculateEntropy(sample: Buffer): number {
    if (sample.length === 0) {
      return 0;
    }
    const counts = new Array<number>(256).fill(0);
    for (let index = 0; index < sample.length; index += 1) {
      counts[sample[index]] += 1;
    }
    let entropy = 0;
    for (const count of counts) {
      if (count === 0) {
        continue;
      }
      const probability = count / sample.length;
      entropy -= probability * Math.log2(probability);
    }
    return entropy;
  }

  private nonPrintableRatio(sample: Buffer): number {
    if (sample.length === 0) {
      return 0;
    }
    let nonPrintable = 0;
    for (let index = 0; index < sample.length; index += 1) {
      const byte = sample[index];
      if (byte < 9 || (byte > 13 && byte < 32) || byte === 127) {
        nonPrintable += 1;
      }
    }
    return nonPrintable / sample.length;
  }

  private handleBinary(
    filePath: string,
    size: number,
    detection: BinaryDetectionResult,
    startedAt: number,
    options: ResolvedProcessingOptions
  ): ProcessedContent {
    const policy = options.binaryFilePolicy;
    const language = options.languageOverride ?? "binary";
    switch (policy) {
      case "skip":
        return this.buildResult({
          encoding: "binary-placeholder",
          content: "",
          size,
          isTruncated: false,
          startedAt,
          options,
          language,
          metadata: { lines: 0, reason: detection.reason ?? "skip" }
        });
      case "placeholder":
        return this.buildResult({
          encoding: "binary-placeholder",
          content: `[binary file] ${path.basename(filePath)}`,
          size,
          isTruncated: false,
          startedAt,
          options,
          language,
          metadata: { lines: 1, reason: detection.reason ?? "placeholder" }
        });
      case "base64":
      default: {
        const buffer = fs.readFileSync(filePath);
        return this.buildResult({
          encoding: "base64",
          content: buffer.toString("base64"),
          size,
          isTruncated: false,
          startedAt,
          options,
          language,
          metadata: { lines: this.estimateLines(buffer.toString(options.encoding)), reason: detection.reason ?? "base64" }
        });
      }
    }
  }

  private async consumeStream(
    filePath: string,
    stats: fs.Stats,
    options: ResolvedProcessingOptions
  ): Promise<{ content: string; truncated: boolean; truncatedBytes: number }> {
  const stream = fs.createReadStream(filePath, { highWaterMark: 64 * 1024 });
    const targetSize = Math.max(0, Math.min(stats.size, options.maxFileSize));
    const bufferStore = Buffer.alloc(targetSize);
    let offset = 0;
    let bytesRead = 0;
    let truncated = false;
    let truncatedBytes = 0;

    const onProgress = options.onProgress;
    const handleProgress = (done: boolean) => {
      if (onProgress) {
        try {
          onProgress({ bytesRead, totalBytes: stats.size, done });
        } catch (error) {
          this.logger?.("contentProcessor.progress.error", { filePath, error: (error as Error).message });
        }
      }
    };

    const dataPromise = new Promise<void>((resolve, reject) => {
      const timeout = options.timeoutMs > 0 ? setTimeout(() => {
        stream.destroy(new Error("Processing timed out"));
      }, options.timeoutMs) : undefined;

      stream.on("data", (chunk: Buffer) => {
        bytesRead += chunk.length;

        if (targetSize > 0 && offset < targetSize) {
          const writable = Math.min(chunk.length, targetSize - offset);
          if (writable > 0) {
            chunk.copy(bufferStore, offset, 0, writable);
            offset += writable;
          }
        }

        if (bytesRead > options.maxFileSize) {
          truncated = true;
          truncatedBytes = Math.max(0, stats.size - options.maxFileSize);
          handleProgress(false);
          stream.destroy();
          return;
        }

        handleProgress(false);
      });

      stream.once("error", (error) => {
        if (timeout) {
          clearTimeout(timeout);
        }
        reject(error);
      });

      stream.once("close", () => {
        if (timeout) {
          clearTimeout(timeout);
        }
        resolve();
      });
    });

    try {
      await dataPromise;
      handleProgress(true);
      const buffer = targetSize > 0 ? bufferStore.subarray(0, offset) : Buffer.alloc(0);
      const content = normalizeLineEndings(buffer.toString(options.encoding));
      return {
        content,
        truncated,
        truncatedBytes
      };
    } catch (error) {
      throw wrapError(error, { filePath, stage: "stream" });
    }
  }

  private async resolveLanguage(filePath: string, content: string, options: ResolvedProcessingOptions): Promise<string> {
    if (!options.detectLanguage) {
      return options.languageOverride ?? "plaintext";
    }
    if (options.languageOverride) {
      return options.languageOverride;
    }

    const heuristic = this.heuristicLanguage(filePath, content);
    if (heuristic && heuristic !== "plaintext") {
      return heuristic;
    }

    if (this.externalLanguageDetector) {
      try {
        const detected = await this.externalLanguageDetector(filePath, content);
        if (detected) {
          return detected;
        }
      } catch (error) {
        this.logger?.("contentProcessor.languageDetection.external.error", {
          filePath,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }

    const apiLanguage = this.detectWithVSCodeAPI(filePath);
    if (apiLanguage) {
      return apiLanguage;
    }

    return heuristic || "plaintext";
  }

  private heuristicLanguage(filePath: string, content: string): string {
    const ext = path.extname(filePath).toLowerCase();
    const mapped = LANGUAGE_BY_EXTENSION.get(ext);
    if (mapped) {
      return mapped;
    }

    const trimmed = content.trim();
    if (!trimmed) {
      return "plaintext";
    }

    if (/^\s*</.test(trimmed) && /<html[\s>]/i.test(trimmed)) {
      return "html";
    }
    if (/^\s*</.test(trimmed) && /<svg[\s>]/i.test(trimmed)) {
      return "xml";
    }
    if (/import\s+\w+\s+from\s+['"].+['"];?/.test(trimmed) || /module\.exports\s*=/.test(trimmed)) {
      return "javascript";
    }
    if (/^\s*#include\s+[<"].+[>"]/.test(trimmed) || /int\s+main\s*\(/.test(trimmed)) {
      return "c";
    }
    if (/^\s*def\s+\w+\(/m.test(trimmed) || /^\s*class\s+\w+\(/m.test(trimmed)) {
      return "python";
    }
    if (/^\s*SELECT\s+/i.test(trimmed)) {
      return "sql";
    }

    return "plaintext";
  }

  private detectWithVSCodeAPI(filePath: string): string | undefined {
    try {
      const ext = path.extname(filePath).toLowerCase();
      const basename = path.basename(filePath).toLowerCase();
      for (const extension of vscode.extensions?.all ?? []) {
        const languages = extension.packageJSON?.contributes?.languages as
          | Array<{ id: string; extensions?: string[]; filenames?: string[] }>
          | undefined;
        if (!Array.isArray(languages)) {
          continue;
        }
        for (const language of languages) {
          const extensions = language.extensions ?? [];
          const filenames = language.filenames ?? [];
          if (extensions.some((candidate) => candidate.toLowerCase() === ext)) {
            return language.id;
          }
          if (filenames.some((candidate) => candidate.toLowerCase() === basename)) {
            return language.id;
          }
        }
      }
    } catch (error) {
      this.logger?.("contentProcessor.languageDetection.error", {
        filePath,
        error: error instanceof Error ? error.message : String(error)
      });
    }
    return undefined;
  }

  private buildResult(input: {
    encoding: ProcessedContent["encoding"];
    content: string;
    size: number;
    isTruncated: boolean;
    startedAt: number;
    options: ResolvedProcessingOptions;
    language: string;
    truncatedBytes?: number;
    metadata?: Record<string, unknown>;
  }): ProcessedContent {
    const processingTime = Math.max(0, this.now() - input.startedAt);
    const lines = this.estimateLines(input.content);
  const checksum = this.calculateChecksum(input.content);
    const baseMetadata: ProcessedContentMetadata = {
      lines,
      truncatedBytes: input.truncatedBytes ?? 0,
      ...(input.metadata ?? {})
    };
    if (checksum !== undefined) {
      (baseMetadata as Record<string, unknown>).checksum = checksum;
    }

    return {
      content: input.content,
      language: input.language,
      encoding: input.encoding,
      size: input.size,
      isTruncated: input.isTruncated,
      processingTime,
      metadata: baseMetadata
    };
  }

  private calculateChecksum(content: string): string | undefined {
    if (!content) {
      return undefined;
    }
    const slice = content.slice(0, CHECKSUM_SAMPLE_BYTES);
    let hash = 0;
    for (let index = 0; index < slice.length; index += 1) {
      hash = (hash << 5) - hash + slice.charCodeAt(index);
      hash |= 0;
    }
    return Math.abs(hash).toString(16);
  }

  private computeAdaptiveConcurrency(requested: number): number {
    let cpuCount = DEFAULT_CONCURRENCY;
    try {
      if (typeof (os as unknown as { availableParallelism?: () => number }).availableParallelism === "function") {
        cpuCount = Math.max(1, (os as unknown as { availableParallelism?: () => number }).availableParallelism!());
      } else if (os.cpus) {
        cpuCount = Math.max(1, os.cpus().length);
      }
    } catch (error) {
      this.logger?.("contentProcessor.options.concurrencyDetect.error", {
        message: error instanceof Error ? error.message : String(error)
      });
    }

    const upperBound = Math.max(1, Math.floor(cpuCount * 0.75));
    return Math.max(1, Math.min(requested, upperBound));
  }
}
