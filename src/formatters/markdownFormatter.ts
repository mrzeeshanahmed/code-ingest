import * as path from "node:path";

import { BaseFormatter } from "./base/formatter.interface";
import type { FormatterOptions, FormatterTemplateSet } from "./types";
import type { DigestMetadata, DigestResult, DigestSummary, ProcessedFileContent } from "../services/digestGenerator";

const LANGUAGE_MAPPINGS: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  py: "python",
  rb: "ruby",
  java: "java",
  cs: "csharp",
  go: "go",
  rs: "rust",
  md: "markdown",
  json: "json",
  yml: "yaml",
  yaml: "yaml",
  html: "html",
  css: "css",
  scss: "scss",
  cpp: "cpp",
  c: "c",
  h: "c",
  sh: "bash",
  ps1: "powershell"
};

export class MarkdownFormatter extends BaseFormatter {
  public readonly format = "markdown" as const;
  public readonly mimeType = "text/markdown";
  public readonly fileExtension = "md";

  public constructor(options?: Partial<FormatterOptions>, templates?: FormatterTemplateSet) {
    super(options, templates);
  }

  public buildHeader(metadata: DigestMetadata): string {
    const metadataView = this.renderMetadata(metadata);
    const frontMatterOrder: Array<keyof typeof metadataView.frontMatter> = [
      "generated_at",
      "workspace_root",
      "total_files",
      "included_files",
      "skipped_files",
      "binary_files",
      "token_estimate",
      "processing_time_ms",
      "redaction_applied",
      "generator_version"
    ];

    const frontMatter = [
      "---",
      ...frontMatterOrder.map((key) => `${key}: ${metadataView.frontMatter[key]}`),
      "---"
    ];

    return this.applyTemplate("header", frontMatter.join("\n"), {
      metadata,
      metadataView
    });
  }

  public buildSummary(summary: DigestSummary): string {
    const summaryView = this.renderSummary(summary);
    const headerLevel = Math.max(1, this.options.markdown?.headerLevel ?? 2);
    const headerMarker = "#".repeat(headerLevel);

    const lines: string[] = [];
    lines.push(`${headerMarker} Digest Summary`);
    lines.push("\n");
    summaryView.overview.forEach((entry) => {
      lines.push(`- ${entry.label}: ${entry.value}`);
    });

    if (summaryView.notes.length > 0) {
      lines.push("\n");
      lines.push(`${headerMarker}# Notes`);
      for (const note of summaryView.notes) {
        lines.push(`- ${note}`);
      }
    }

    if (summaryView.tableOfContents.length > 0) {
      lines.push("\n");
      lines.push(`${headerMarker}# Table of Contents`);
      const depth = this.options.markdown?.tableOfContentsDepth ?? summaryView.tableOfContents.length;
      for (const entry of summaryView.tableOfContents.slice(0, depth)) {
        const truncated = entry.truncated ? " _(truncated)_" : "";
        lines.push(`- [${entry.path}](#${this.anchorize(entry.path)}) — ${entry.tokens} tokens${truncated}`);
      }
    }

    return this.applyTemplate("summary", lines.join("\n"), {
      summary,
      summaryView
    });
  }

  public buildFileTree(files: ProcessedFileContent[]): string {
    if (files.length === 0) {
      return "";
    }

    const headerLevel = Math.max(1, (this.options.markdown?.headerLevel ?? 2) + 1);
    const headerMarker = "#".repeat(headerLevel);
    const lines: string[] = [`${headerMarker} File Tree`];
    const treeView = this.getFileTreeView(files, this.getCurrentContext());

    if (this.options.markdown?.includeMermaidDiagram) {
      lines.push("```mermaid");
      lines.push("graph TD");
      lines.push(...treeView.mermaid.map((line) => `  ${line}`));
      lines.push("```");
    }

    lines.push(...treeView.nested);

    return this.applyTemplate("fileTree", lines.join("\n"), {
      files,
      fileTreeView: treeView
    });
  }

  public buildFileContent(file: ProcessedFileContent): string {
    const headerLevel = Math.max(1, (this.options.markdown?.headerLevel ?? 2) + 1);
    const headerMarker = "#".repeat(headerLevel);
    const title = `${headerMarker} ${file.relativePath}`;
    const language = this.detectLanguage(file);
    const content = this.escapeContent(this.truncateContent(file.content));

    const codeBlock = [
      "```" + language,
      content,
      "```"
    ].join("\n");

    if ((this.options.markdown?.collapsibleThresholdLines ?? 40) < content.split(/\r?\n/).length) {
      return this.applyTemplate(
        "fileContent",
        [
          `<details>
  <summary>${file.relativePath} (${file.tokens} tokens${file.truncated ? ", truncated" : ""})</summary>`,
          "",
          codeBlock,
          "</details>"
        ].join("\n"),
        { file }
      );
    }

    return this.applyTemplate(
      "fileContent",
      [
        title,
        "",
        codeBlock
      ].join("\n"),
      { file }
    );
  }

  public buildFooter(statistics: DigestResult["statistics"]): string {
    const statisticsView = this.renderStatistics(statistics);
    const headerLevel = Math.max(1, (this.options.markdown?.headerLevel ?? 2) + 1);
    const headerMarker = "#".repeat(headerLevel);

    const lines: string[] = [`${headerMarker} Statistics`];
    statisticsView.keyValues.forEach((entry) => {
      lines.push(`- ${entry.label}: ${entry.value}`);
    });

    if (statisticsView.warnings.length > 0) {
      lines.push("- Warnings:");
      for (const warning of statisticsView.warnings) {
        lines.push(`  - ${warning}`);
      }
    }

    if (statisticsView.errors.length > 0) {
      lines.push("- Errors:");
      for (const error of statisticsView.errors) {
        lines.push(`  - ${error}`);
      }
    }

    return this.applyTemplate("footer", lines.join("\n"), {
      statistics,
      statisticsView
    });
  }

  public override finalize(digestResult: DigestResult): string {
    const sections = Array.from(this.streamSections(digestResult));
    return this.applyTemplate(
      "finalize",
      sections.filter((section) => section.trim().length > 0).join(this.getSectionSeparator()),
      {
        digest: digestResult,
        metadata: digestResult.content.metadata,
        metadataView: this.renderMetadata(digestResult.content.metadata),
        summary: digestResult.content.summary,
        summaryView: this.renderSummary(digestResult.content.summary),
        statistics: digestResult.statistics,
        statisticsView: this.renderStatistics(digestResult.statistics)
      }
    );
  }

  private anchorize(pathName: string): string {
    return pathName
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-");
  }

  private detectLanguage(file: ProcessedFileContent): string {
    if (file.languageId) {
      return file.languageId;
    }
    const ext = path.extname(file.relativePath).replace(/^\./, "").toLowerCase();
    if (ext && LANGUAGE_MAPPINGS[ext]) {
      return LANGUAGE_MAPPINGS[ext];
    }
    return this.options.markdown?.codeFenceLanguageFallback ?? "";
  }

}