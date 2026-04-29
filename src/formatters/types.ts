import type { DigestMetadata, DigestResult, DigestSummary, ProcessedFileContent } from "../services/digestGenerator";
import type { FormatterMetadataView, FormatterStatisticsView, FormatterSummaryView } from "./base/sectionModels";
import type { FileTreeView } from "./base/fileTreeBuilder";

export type DigestStatistics = DigestResult["statistics"];

export interface FormatterOptions {
  includeMetadata: boolean;
  includeSummary: boolean;
  includeFileTree: boolean;
  includeFiles: boolean;
  maxFileContentLength?: number;
  sectionSeparator: string;
  outputPresetCompatible?: boolean;
  templates?: FormatterTemplateSet;
  markdown?: {
    headerLevel?: number;
    collapsibleThresholdLines?: number;
    includeMermaidDiagram?: boolean;
    tableOfContentsDepth?: number;
    codeFenceLanguageFallback?: string;
  };
  json?: {
    schemaVersion?: string;
    pretty?: boolean;
    stream?: boolean;
  };
  text?: {
    lineWidth?: number;
    useAsciiBoxes?: boolean;
    showColorCodes?: boolean;
    columnWidths?: {
      label?: number;
      value?: number;
    };
  };
}

export interface FormatterTemplateSet {
  header?: string;
  summary?: string;
  fileTree?: string;
  fileContent?: string;
  footer?: string;
  finalize?: string;
}

export interface TemplateVariables {
  metadata?: DigestMetadata;
  metadataView?: FormatterMetadataView;
  summary?: DigestSummary;
  summaryView?: FormatterSummaryView;
  file?: ProcessedFileContent;
  statistics?: DigestStatistics;
  statisticsView?: FormatterStatisticsView;
  digest?: DigestResult;
  fileTreeView?: FileTreeView;
  [key: string]: unknown;
}

export interface TemplateValidationError {
  templateName: string;
  reason: string;
}

export interface TemplateValidationResult {
  valid: boolean;
  errors: TemplateValidationError[];
}

export interface JsonDigestMetadata extends Omit<DigestMetadata, "generatedAt"> {
  generatedAt: string;
}

export type JsonDigestFile = Omit<ProcessedFileContent, "content"> & { content: string };

export interface JsonDigestSchema {
  metadata: JsonDigestMetadata;
  summary: DigestSummary;
  files: JsonDigestFile[];
  statistics: DigestStatistics;
  schema_version: string;
}

export const DEFAULT_FORMATTER_OPTIONS: FormatterOptions = {
  includeMetadata: true,
  includeSummary: true,
  includeFileTree: true,
  includeFiles: true,
  sectionSeparator: "\n\n",
  markdown: {
    headerLevel: 2,
    collapsibleThresholdLines: 40,
    includeMermaidDiagram: true,
    tableOfContentsDepth: 3,
    codeFenceLanguageFallback: "plaintext"
  },
  json: {
    schemaVersion: "1.0.0",
    pretty: true,
    stream: false
  },
  text: {
    lineWidth: 80,
    useAsciiBoxes: true,
    showColorCodes: false,
    columnWidths: {
      label: 18,
      value: 52
    }
  }
};