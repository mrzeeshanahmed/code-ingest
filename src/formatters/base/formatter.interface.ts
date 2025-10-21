import { DEFAULT_FORMATTER_OPTIONS, type DigestStatistics, type FormatterOptions, type FormatterTemplateSet, type JsonDigestSchema, type TemplateVariables } from "../types";
import type { DigestMetadata, DigestResult, DigestSummary, ProcessedFileContent } from "../../services/digestGenerator";
import { TemplateEngine } from "../templateEngine";
import { mergeFormatterOptions, type FormatterOptionsDiagnostics } from "./options";
import { FileTreeBuilder, type FileTree, type FileTreeView } from "./fileTreeBuilder";
import type { FormatterMetadataView, FormatterStatisticsView, FormatterSummaryView } from "./sectionModels";

const FILE_SIZE_UNITS = ["B", "KB", "MB", "GB", "TB"];

export interface Formatter {
  format: string;
  mimeType: string;
  fileExtension: string;

  buildHeader(metadata: DigestMetadata): string;
  buildSummary(summary: DigestSummary): string;
  buildFileTree(files: ProcessedFileContent[]): string;
  buildFileContent(file: ProcessedFileContent): string;
  buildFooter(statistics: DigestStatistics): string;

  finalize(digestResult: DigestResult): string;
  streamSectionsAsync(digestResult: DigestResult): AsyncIterable<string>;
  supportsStreaming(): boolean;
}

export abstract class BaseFormatter implements Formatter {
  public abstract format: string;
  public abstract mimeType: string;
  public abstract fileExtension: string;

  protected readonly options: FormatterOptions;
  protected readonly templateEngine: TemplateEngine;
  private activeContext: FormatterContext | undefined;

  protected constructor(
    options?: Partial<FormatterOptions>,
    templates?: FormatterTemplateSet,
    diagnostics?: FormatterOptionsDiagnostics
  ) {
    const optionDiagnostics = diagnostics ?? createFormatterOptionsDiagnostics();
    this.options = mergeFormatterOptions(DEFAULT_FORMATTER_OPTIONS, options, optionDiagnostics);
    this.templateEngine = new TemplateEngine(templates ?? this.options.templates);
  }

  public abstract buildHeader(metadata: DigestMetadata): string;

  public abstract buildSummary(summary: DigestSummary): string;

  public abstract buildFileTree(files: ProcessedFileContent[]): string;

  public abstract buildFileContent(file: ProcessedFileContent): string;

  public abstract buildFooter(statistics: DigestStatistics): string;

  public finalize(digestResult: DigestResult): string {
    const segments = Array.from(this.streamSections(digestResult));
    return segments.filter((segment) => segment.trim().length > 0).join(this.getSectionSeparator());
  }

  public streamSectionsAsync(digestResult: DigestResult): AsyncIterable<string> {
    return {
      [Symbol.asyncIterator]: () => {
        const iterator = this.streamSections(digestResult)[Symbol.iterator]();
        return {
          next: () => Promise.resolve(iterator.next()),
          return: (value?: unknown) => {
            if (typeof iterator.return === "function") {
              return Promise.resolve(iterator.return(value as never));
            }
            return Promise.resolve({ value: undefined, done: true } as IteratorResult<string>);
          },
          throw: (error?: unknown) => {
            if (typeof iterator.throw === "function") {
              return Promise.resolve(iterator.throw(error));
            }
            return Promise.reject(error);
          }
        } as AsyncIterator<string>;
      }
    };
  }

  public supportsStreaming(): boolean {
    return false;
  }

  protected *streamSections(digestResult: DigestResult): Iterable<string> {
    yield* this.createSectionIterator(digestResult);
  }

  protected getSectionSeparator(): string {
    return this.options.sectionSeparator ?? DEFAULT_FORMATTER_OPTIONS.sectionSeparator;
  }

  protected createContext(digestResult: DigestResult): FormatterContext {
    return {
      digest: digestResult,
      files: digestResult.content.files
    } satisfies FormatterContext;
  }

  protected getCurrentContext(): FormatterContext | undefined {
    return this.activeContext;
  }

  protected getFileTree(files: ProcessedFileContent[], context: FormatterContext | undefined = this.activeContext): FileTree {
    if (context) {
      if (!context.fileTree) {
        context.fileTree = FileTreeBuilder.fromFiles(files);
      }
      return context.fileTree;
    }

    return FileTreeBuilder.fromFiles(files);
  }

  protected getFileTreeView(
    files: ProcessedFileContent[],
    context: FormatterContext | undefined = this.activeContext,
    rootLabel = "Workspace"
  ): FileTreeView {
    if (context) {
      if (!context.fileTreeView) {
        const tree = this.getFileTree(files, context);
        context.fileTreeView = tree.toView(rootLabel);
      }
      return context.fileTreeView;
    }

    return FileTreeBuilder.fromFiles(files).toView(rootLabel);
  }

  protected formatJsonSchema(schema: JsonDigestSchema): string {
    return JSON.stringify(schema, null, this.options.json?.pretty ? 2 : undefined);
  }

  protected renderMetadata(metadata: DigestMetadata): FormatterMetadataView {
    const frontMatter = {
      generated_at: metadata.generatedAt.toISOString(),
      workspace_root: metadata.workspaceRoot,
      total_files: metadata.totalFiles,
      included_files: metadata.includedFiles,
      skipped_files: metadata.skippedFiles,
      binary_files: metadata.binaryFiles,
      token_estimate: metadata.tokenEstimate,
      processing_time_ms: metadata.processingTime,
      redaction_applied: metadata.redactionApplied,
      generator_version: metadata.generatorVersion
    };

    const keyValues = [
      { label: "Workspace", value: metadata.workspaceRoot },
      { label: "Generated", value: metadata.generatedAt.toISOString() },
      { label: "Total files", value: metadata.totalFiles.toString() },
      { label: "Included", value: metadata.includedFiles.toString() },
      { label: "Skipped", value: metadata.skippedFiles.toString() },
      { label: "Binary", value: metadata.binaryFiles.toString() },
      { label: "Token estimate", value: metadata.tokenEstimate.toString() },
      { label: "Processing time", value: `${metadata.processingTime} ms` },
      { label: "Redaction", value: metadata.redactionApplied ? "yes" : "no" },
      { label: "Generator", value: metadata.generatorVersion }
    ];

    return { metadata, frontMatter, keyValues } satisfies FormatterMetadataView;
  }

  protected renderSummary(summary: DigestSummary): FormatterSummaryView {
    const overview = [
      { label: "Total files", value: summary.overview.totalFiles.toString() },
      { label: "Included", value: summary.overview.includedFiles.toString() },
      { label: "Skipped", value: summary.overview.skippedFiles.toString() },
      { label: "Binary", value: summary.overview.binaryFiles.toString() },
      { label: "Total tokens", value: summary.overview.totalTokens.toString() }
    ];

    const notes = [...summary.notes];
    const tableOfContents = summary.tableOfContents.map((entry) => ({ ...entry }));

    return { summary, overview, tableOfContents, notes } satisfies FormatterSummaryView;
  }

  protected renderStatistics(statistics: DigestStatistics): FormatterStatisticsView {
    const keyValues = [
      { label: "Files processed", value: statistics.filesProcessed.toString() },
      { label: "Total tokens", value: statistics.totalTokens.toString() },
      { label: "Processing time", value: this.formatDuration(statistics.processingTime) },
      { label: "Warnings", value: statistics.warnings.length.toString() },
      { label: "Errors", value: statistics.errors.length.toString() }
    ];

    return {
      statistics,
      keyValues,
      warnings: [...statistics.warnings],
      errors: [...statistics.errors]
    } satisfies FormatterStatisticsView;
  }

  protected escapeContent(content: string): string {
    if (!content) {
      return "";
    }

    return content
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/`/g, "\u0060");
  }

  protected formatFileSize(bytes?: number): string {
    if (bytes === undefined || Number.isNaN(bytes)) {
      return "unknown";
    }

    let size = bytes;
    let unitIndex = 0;
    while (size >= 1024 && unitIndex < FILE_SIZE_UNITS.length - 1) {
      size /= 1024;
      unitIndex += 1;
    }

    const rounded = size >= 10 ? Math.round(size) : Math.round(size * 10) / 10;
    return `${rounded}${FILE_SIZE_UNITS[unitIndex]}`;
  }

  protected formatDuration(ms?: number): string {
    if (ms === undefined || Number.isNaN(ms)) {
      return "unknown";
    }

    const parts: string[] = [];
    const hours = Math.floor(ms / 3_600_000);
    const minutes = Math.floor((ms % 3_600_000) / 60_000);
    const seconds = Math.floor((ms % 60_000) / 1_000);
    const remainingMs = Math.round(ms % 1_000);

    if (hours) parts.push(`${hours}h`);
    if (minutes) parts.push(`${minutes}m`);
    if (seconds) parts.push(`${seconds}s`);
    if (remainingMs && parts.length === 0) parts.push(`${remainingMs}ms`);

    return parts.join(" ") || "0ms";
  }

  protected generateSeparator(length = 80, char = "-"): string {
    return char.repeat(Math.max(1, length));
  }

  protected truncateContent(content: string): string {
    if (!this.options.maxFileContentLength || content.length <= this.options.maxFileContentLength) {
      return content;
    }
    return `${content.slice(0, this.options.maxFileContentLength)}\n... (truncated)`;
  }

  protected applyTemplate(name: keyof FormatterTemplateSet, fallback: string, variables: TemplateVariables): string {
    return this.templateEngine.apply(name, fallback, variables);
  }

  private createSectionIterator(digestResult: DigestResult): IterableIterator<string> {
    const generate = function* (formatter: BaseFormatter): IterableIterator<string> {
      const context = formatter.createContext(digestResult);
      formatter.activeContext = context;

      try {
        if (formatter.options.includeMetadata) {
          yield formatter.buildHeader(digestResult.content.metadata);
        }
        if (formatter.options.includeSummary) {
          yield formatter.buildSummary(digestResult.content.summary);
        }
        if (formatter.options.includeFileTree) {
          yield formatter.buildFileTree(digestResult.content.files);
        }
        if (formatter.options.includeFiles) {
          for (const file of digestResult.content.files) {
            yield formatter.buildFileContent(file);
          }
        }
        yield formatter.buildFooter(digestResult.statistics);
      } finally {
        formatter.activeContext = undefined;
      }
    };

    return generate(this);
  }
}

export interface FormatterContext {
  digest: DigestResult;
  files: ProcessedFileContent[];
  fileTree?: FileTree;
  fileTreeView?: FileTreeView;
}

interface TelemetryEmitter {
  trackEvent(name: string, properties?: Record<string, string | number | boolean>): void;
}

function createFormatterOptionsDiagnostics(): FormatterOptionsDiagnostics {
  const telemetry = resolveTelemetryEmitter();

  const emitTelemetry = (eventName: string, metadata?: Record<string, unknown>): void => {
    if (!telemetry) {
      return;
    }
    const properties = sanitizeTelemetryProperties(metadata);
    telemetry.trackEvent(eventName, properties);
  };

  return {
    addError: (message, metadata) => {
      console.error(`[formatter-options] ${message}`);
      emitTelemetry("formatter.options.error", { message, ...metadata });
    },
    addWarning: (message, metadata) => {
      console.warn(`[formatter-options] ${message}`);
      emitTelemetry("formatter.options.warning", { message, ...metadata });
    },
    trackTelemetry: (eventName, metadata) => {
      emitTelemetry(eventName, metadata);
    }
  };
}

function resolveTelemetryEmitter(): TelemetryEmitter | undefined {
  const candidate = (globalThis as Record<string, unknown>)["__CODE_INGEST_TELEMETRY__"];
  if (!candidate || typeof candidate !== "object") {
    return undefined;
  }

  const emitter = candidate as { trackEvent?: unknown };
  if (typeof emitter.trackEvent === "function") {
    return emitter as TelemetryEmitter;
  }
  return undefined;
}

function sanitizeTelemetryProperties(metadata?: Record<string, unknown>): Record<string, string | number | boolean> | undefined {
  if (!metadata) {
    return undefined;
  }

  const properties: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (value === undefined || value === null) {
      continue;
    }
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      properties[key] = value;
      continue;
    }

    try {
      const serialized = JSON.stringify(value);
      if (serialized) {
        properties[key] = serialized.slice(0, 120);
      }
    } catch {
      properties[key] = String(value).slice(0, 120);
    }
  }

  return Object.keys(properties).length > 0 ? properties : undefined;
}
