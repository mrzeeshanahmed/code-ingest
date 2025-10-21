import { BaseFormatter } from "./base/formatter.interface";
import {
  DEFAULT_FORMATTER_OPTIONS,
  type FormatterOptions,
  type FormatterTemplateSet,
  type JsonDigestFile,
  type JsonDigestMetadata,
  type JsonDigestSchema,
  type TemplateVariables
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
    return this.applyTemplate("header", this.stringifySection(metadata), {
      metadata,
      metadataView: this.renderMetadata(metadata)
    });
  }

  public buildSummary(summary: DigestSummary): string {
    return this.applyTemplate("summary", this.stringifySection(summary), {
      summary,
      summaryView: this.renderSummary(summary)
    });
  }

  public buildFileTree(files: ProcessedFileContent[]): string {
    const treeView = this.getFileTreeView(files, this.getCurrentContext());
    return this.applyTemplate("fileTree", "", {
      files,
      fileTreeView: treeView
    });
  }

  public buildFileContent(file: ProcessedFileContent): string {
    const serialized = this.stringifySection(this.serializeFile(file));
    return this.applyTemplate("fileContent", serialized, { file });
  }

  public buildFooter(statistics: DigestResult["statistics"]): string {
    return this.applyTemplate("footer", this.stringifySection(statistics), {
      statistics,
      statisticsView: this.renderStatistics(statistics)
    });
  }

  public override finalize(digestResult: DigestResult): string {
    const schemaVersion = this.options.json?.schemaVersion ?? DEFAULT_FORMATTER_OPTIONS.json?.schemaVersion ?? "1.0.0";
    const templateVariables = {
      digest: digestResult,
      metadata: digestResult.content.metadata,
      metadataView: this.renderMetadata(digestResult.content.metadata),
      summary: digestResult.content.summary,
      summaryView: this.renderSummary(digestResult.content.summary),
      statistics: digestResult.statistics,
      statisticsView: this.renderStatistics(digestResult.statistics)
    } satisfies TemplateVariables;

    const hasSectionTemplates =
      this.templateEngine.has("header") ||
      this.templateEngine.has("summary") ||
      this.templateEngine.has("fileTree") ||
      this.templateEngine.has("fileContent") ||
      this.templateEngine.has("footer");

    if (hasSectionTemplates) {
      const sectionOutput = super.finalize(digestResult);
      if (this.templateEngine.has("finalize")) {
        return this.applyTemplate("finalize", sectionOutput, templateVariables);
      }
      return sectionOutput;
    }

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
      const output = records.map((record) => JSON.stringify(record, null, indent)).join("\n");
      return this.applyTemplate("finalize", output, templateVariables);
    }

    const schema = this.buildSchema(digestResult, schemaVersion);
    const output = this.formatJsonSchema(schema);
    return this.applyTemplate("finalize", output, templateVariables);
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
