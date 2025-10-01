import { BaseFormatter } from "./base/formatter.interface";
import {
  DEFAULT_FORMATTER_OPTIONS,
  type FormatterOptions,
  type FormatterTemplateSet,
  type JsonDigestFile,
  type JsonDigestMetadata,
  type JsonDigestSchema
} from "./types";
import type { DigestMetadata, DigestResult, DigestSummary, ProcessedFileContent } from "../services/digestGenerator";

interface StreamRecord<T> {
  type: "metadata" | "summary" | "file" | "statistics";
  schemaVersion: string;
  data: T;
}

export class JsonFormatter extends BaseFormatter {
  public readonly format = "json" as const;
  public readonly mimeType = "application/json";
  public readonly fileExtension = "json";

  public constructor(options?: Partial<FormatterOptions>, templates?: FormatterTemplateSet) {
    super(options, templates);
  }

  public buildHeader(metadata: DigestMetadata): string {
    return this.stringifySection(metadata);
  }

  public buildSummary(summary: DigestSummary): string {
    return this.stringifySection(summary);
  }

  public buildFileTree(files: ProcessedFileContent[]): string {
    void files;
    return "";
  }

  public buildFileContent(file: ProcessedFileContent): string {
    return this.stringifySection(this.serializeFile(file));
  }

  public buildFooter(statistics: DigestResult["statistics"]): string {
    return this.stringifySection(statistics);
  }

  public override finalize(digestResult: DigestResult): string {
    const schemaVersion = this.options.json?.schemaVersion ?? DEFAULT_FORMATTER_OPTIONS.json?.schemaVersion ?? "1.0.0";

    if (this.options.json?.stream) {
      const records: Array<StreamRecord<unknown>> = [];

      if (this.options.includeMetadata) {
        records.push({ type: "metadata", schemaVersion, data: this.serializeMetadata(digestResult.content.metadata) });
      }

      if (this.options.includeSummary) {
        records.push({ type: "summary", schemaVersion, data: digestResult.content.summary });
      }

      if (this.options.includeFiles) {
        for (const file of digestResult.content.files) {
          records.push({ type: "file", schemaVersion, data: this.serializeFile(file) });
        }
      }

      records.push({ type: "statistics", schemaVersion, data: digestResult.statistics });

      const indent = this.options.json?.pretty ? 2 : undefined;
      return records.map((record) => JSON.stringify(record, null, indent)).join("\n");
    }

    const schema = this.buildSchema(digestResult, schemaVersion);
    return this.formatJsonSchema(schema);
  }

  private buildSchema(digestResult: DigestResult, schemaVersion: string): JsonDigestSchema {
    return {
      metadata: this.options.includeMetadata
        ? this.serializeMetadata(digestResult.content.metadata)
        : this.createEmptyMetadata(),
      summary: this.options.includeSummary ? digestResult.content.summary : this.createEmptySummary(),
      files: this.options.includeFiles ? digestResult.content.files.map((file) => this.serializeFile(file)) : [],
      statistics: digestResult.statistics,
      schema_version: schemaVersion
    } satisfies JsonDigestSchema;
  }

  private serializeMetadata(metadata: DigestMetadata): JsonDigestMetadata {
    return {
      ...metadata,
      generatedAt: metadata.generatedAt.toISOString()
    };
  }

  private serializeFile(file: ProcessedFileContent): JsonDigestFile {
    return {
      ...file,
      content: this.truncateContent(file.content)
    };
  }

  private stringifySection(value: unknown): string {
    const indent = this.options.json?.pretty ? 2 : undefined;
    return JSON.stringify(value, null, indent) ?? "";
  }

  private createEmptyMetadata(): JsonDigestMetadata {
    return {
      generatedAt: new Date(0).toISOString(),
      workspaceRoot: "",
      totalFiles: 0,
      includedFiles: 0,
      skippedFiles: 0,
      binaryFiles: 0,
      tokenEstimate: 0,
      processingTime: 0,
      redactionApplied: false,
      generatorVersion: ""
    } satisfies JsonDigestMetadata;
  }

  private createEmptySummary(): DigestSummary {
    return {
      overview: {
        totalFiles: 0,
        includedFiles: 0,
        skippedFiles: 0,
        binaryFiles: 0,
        totalTokens: 0
      },
      tableOfContents: [],
      notes: []
    } satisfies DigestSummary;
  }
}
