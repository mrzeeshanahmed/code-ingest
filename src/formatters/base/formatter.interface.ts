import { DEFAULT_FORMATTER_OPTIONS, type DigestStatistics, type FormatterOptions, type FormatterTemplateSet, type JsonDigestSchema, type TemplateVariables } from "../types";
import type { DigestMetadata, DigestResult, DigestSummary, ProcessedFileContent } from "../../services/digestGenerator";
import { TemplateEngine } from "../templateEngine";

const FILE_SIZE_UNITS = ["B", "KB", "MB", "GB", "TB"];

function deepMergeOptions(base: FormatterOptions, overrides?: Partial<FormatterOptions>): FormatterOptions {
  if (!overrides) {
    return base;
  }

  const result: FormatterOptions = {
    ...base,
    ...overrides,
    markdown: {
      ...base.markdown,
      ...overrides.markdown
    },
    json: {
      ...base.json,
      ...overrides.json
    },
    text: {
      ...base.text,
      ...overrides.text
    }
  };

  if (overrides.templates) {
    result.templates = overrides.templates;
  }

  return result;
}

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
}

export abstract class BaseFormatter implements Formatter {
  public abstract format: string;
  public abstract mimeType: string;
  public abstract fileExtension: string;

  protected readonly options: FormatterOptions;
  protected readonly templateEngine: TemplateEngine;

  protected constructor(options?: Partial<FormatterOptions>, templates?: FormatterTemplateSet) {
    this.options = deepMergeOptions(DEFAULT_FORMATTER_OPTIONS, options);
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

  protected *streamSections(digestResult: DigestResult): Iterable<string> {
    if (this.options.includeMetadata) {
      yield this.buildHeader(digestResult.content.metadata);
    }
    if (this.options.includeSummary) {
      yield this.buildSummary(digestResult.content.summary);
    }
    if (this.options.includeFileTree) {
      yield this.buildFileTree(digestResult.content.files);
    }
    if (this.options.includeFiles) {
      for (const file of digestResult.content.files) {
        yield this.buildFileContent(file);
      }
    }
    yield this.buildFooter(digestResult.statistics);
  }

  protected getSectionSeparator(): string {
    return this.options.sectionSeparator ?? DEFAULT_FORMATTER_OPTIONS.sectionSeparator;
  }

  protected formatJsonSchema(schema: JsonDigestSchema): string {
    return JSON.stringify(schema, null, this.options.json?.pretty ? 2 : undefined);
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
}
