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
    if (!this.options.includeMetadata) {
      return "";
    }

    const frontMatter = [
      "---",
      `generated_at: ${metadata.generatedAt.toISOString()}`,
      `workspace_root: ${metadata.workspaceRoot}`,
      `total_files: ${metadata.totalFiles}`,
      `included_files: ${metadata.includedFiles}`,
      `skipped_files: ${metadata.skippedFiles}`,
      `binary_files: ${metadata.binaryFiles}`,
      `token_estimate: ${metadata.tokenEstimate}`,
      `processing_time_ms: ${metadata.processingTime}`,
      `redaction_applied: ${metadata.redactionApplied}`,
      `generator_version: ${metadata.generatorVersion}`,
      "---"
    ];

    return this.applyTemplate("header", frontMatter.join("\n"), { metadata });
  }

  public buildSummary(summary: DigestSummary): string {
    if (!this.options.includeSummary) {
      return "";
    }

    const headerLevel = Math.max(1, this.options.markdown?.headerLevel ?? 2);
    const headerMarker = "#".repeat(headerLevel);

    const lines: string[] = [];
    lines.push(`${headerMarker} Digest Summary`);
    lines.push("\n");
    lines.push(`- Total files: ${summary.overview.totalFiles}`);
    lines.push(`- Included files: ${summary.overview.includedFiles}`);
    lines.push(`- Skipped files: ${summary.overview.skippedFiles}`);
    lines.push(`- Binary files: ${summary.overview.binaryFiles}`);
    lines.push(`- Total tokens: ${summary.overview.totalTokens}`);

    if (summary.notes.length > 0) {
      lines.push("\n");
      lines.push(`${headerMarker}# Notes`);
      for (const note of summary.notes) {
        lines.push(`- ${note}`);
      }
    }

    if (summary.tableOfContents.length > 0) {
      lines.push("\n");
      lines.push(`${headerMarker}# Table of Contents`);
      for (const entry of summary.tableOfContents.slice(0, this.options.markdown?.tableOfContentsDepth ?? summary.tableOfContents.length)) {
        const truncated = entry.truncated ? " _(truncated)_" : "";
        lines.push(`- [${entry.path}](#${this.anchorize(entry.path)}) — ${entry.tokens} tokens${truncated}`);
      }
    }

    return this.applyTemplate("summary", lines.join("\n"), { summary });
  }

  public buildFileTree(files: ProcessedFileContent[]): string {
    if (!this.options.includeFileTree || files.length === 0) {
      return "";
    }

    const headerLevel = Math.max(1, (this.options.markdown?.headerLevel ?? 2) + 1);
    const headerMarker = "#".repeat(headerLevel);
    const lines: string[] = [`${headerMarker} File Tree`];

    const tree = this.buildMermaidTree(files);
    if (this.options.markdown?.includeMermaidDiagram) {
      lines.push("```mermaid");
      lines.push("graph TD");
      lines.push(...tree.map((line) => `  ${line}`));
      lines.push("```");
    }

    const nestedList = this.buildNestedList(files.map((file) => file.relativePath));
    lines.push(...nestedList);

    return this.applyTemplate("fileTree", lines.join("\n"), { files });
  }

  public buildFileContent(file: ProcessedFileContent): string {
    if (!this.options.includeFiles) {
      return "";
    }

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
    const headerLevel = Math.max(1, (this.options.markdown?.headerLevel ?? 2) + 1);
    const headerMarker = "#".repeat(headerLevel);

    const lines: string[] = [`${headerMarker} Statistics`];
    lines.push(`- Files processed: ${statistics.filesProcessed}`);
    lines.push(`- Total tokens: ${statistics.totalTokens}`);
    lines.push(`- Processing time: ${this.formatDuration(statistics.processingTime)}`);

    if (statistics.warnings.length > 0) {
      lines.push("- Warnings:");
      for (const warning of statistics.warnings) {
        lines.push(`  - ${warning}`);
      }
    }

    if (statistics.errors.length > 0) {
      lines.push("- Errors:");
      for (const error of statistics.errors) {
        lines.push(`  - ${error}`);
      }
    }

    return this.applyTemplate("footer", lines.join("\n"), { statistics });
  }

  public override finalize(digestResult: DigestResult): string {
    const sections = Array.from(this.streamSections(digestResult));
    return this.applyTemplate(
      "finalize",
      sections.filter((section) => section.trim().length > 0).join(this.getSectionSeparator()),
      { digest: digestResult }
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

  private buildNestedList(paths: string[]): string[] {
    interface NestedTreeNode {
      children: Map<string, NestedTreeNode>;
    }

    const root: NestedTreeNode = { children: new Map() };

    for (const relPath of paths) {
      const segments = relPath.split(/\\|\//);
      let current = root;
      for (const segment of segments) {
        if (!current.children.has(segment)) {
          current.children.set(segment, { children: new Map() });
        }
        current = current.children.get(segment)!;
      }
    }

    const lines: string[] = [];

    const traverse = (node: NestedTreeNode, depth: number) => {
      const entries = Array.from(node.children.entries()).sort(([a], [b]) => a.localeCompare(b));
      for (const [name, child] of entries) {
        const indent = "  ".repeat(depth);
        lines.push(`${indent}- ${name}`);
        if (child.children.size > 0) {
          traverse(child, depth + 1);
        }
      }
    };

    traverse(root, 0);
    return lines;
  }

  private buildMermaidTree(files: ProcessedFileContent[]): string[] {
    type TreeNode = { name: string; children: Map<string, TreeNode> };

    const root: TreeNode = { name: "Workspace", children: new Map() };

    for (const file of files) {
      const segments = file.relativePath.split(/\\|\//);
      let current = root;
      for (const segment of segments) {
        if (!current.children.has(segment)) {
          current.children.set(segment, { name: segment, children: new Map() });
        }
        current = current.children.get(segment)!;
      }
    }

    const lines: string[] = ["root[\"Workspace\"]"];

    const slugify = (value: string): string =>
      value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "") || "node";

    const traverse = (node: TreeNode, parentId: string) => {
      const entries = Array.from(node.children.values()).sort((a, b) => a.name.localeCompare(b.name));
      entries.forEach((child, index) => {
        const childId = `${parentId}_${slugify(child.name)}_${index}`;
        const escapedLabel = child.name.replace(/\"/g, '\\"');
        lines.push(`${childId}[\"${escapedLabel}\"]`);
        lines.push(`${parentId} --> ${childId}`);
        traverse(child, childId);
      });
    };

    traverse(root, "root");

    return lines;
  }
}