import { BaseFormatter } from "./base/formatter.interface";
import type { FormatterOptions, FormatterTemplateSet } from "./types";
import type { DigestMetadata, DigestResult, DigestSummary, ProcessedFileContent } from "../services/digestGenerator";

interface TreeNode {
  name: string;
  children: Map<string, TreeNode>;
  isFile: boolean;
}

interface RenderSectionOptions {
  readonly preserveSpacing?: boolean;
}

export class TextFormatter extends BaseFormatter {
  public readonly format = "text" as const;
  public readonly mimeType = "text/plain";
  public readonly fileExtension = "txt";

  public constructor(options?: Partial<FormatterOptions>, templates?: FormatterTemplateSet) {
    super(options, templates);
  }

  public buildHeader(metadata: DigestMetadata): string {
    const lines = [
      this.formatKeyValue("Workspace", metadata.workspaceRoot),
      this.formatKeyValue("Generated", metadata.generatedAt.toISOString()),
      this.formatKeyValue("Total files", metadata.totalFiles.toString()),
      this.formatKeyValue("Included", metadata.includedFiles.toString()),
      this.formatKeyValue("Skipped", metadata.skippedFiles.toString()),
      this.formatKeyValue("Binary", metadata.binaryFiles.toString()),
      this.formatKeyValue("Token estimate", metadata.tokenEstimate.toString()),
      this.formatKeyValue("Processing time", `${metadata.processingTime} ms`),
      this.formatKeyValue("Redaction", metadata.redactionApplied ? "yes" : "no"),
      this.formatKeyValue("Generator", metadata.generatorVersion)
    ];

    return this.renderSection("Digest Metadata", lines.flatMap((line) => line.split("\n")));
  }

  public buildSummary(summary: DigestSummary): string {
    const lines = [
      this.formatKeyValue("Total files", summary.overview.totalFiles.toString()),
      this.formatKeyValue("Included", summary.overview.includedFiles.toString()),
      this.formatKeyValue("Skipped", summary.overview.skippedFiles.toString()),
      this.formatKeyValue("Binary", summary.overview.binaryFiles.toString()),
      this.formatKeyValue("Tokens", summary.overview.totalTokens.toString())
    ];

    if (summary.tableOfContents.length > 0) {
      lines.push("", this.applyLabelStyle("Table of Contents"));
      summary.tableOfContents.forEach((entry) => {
        const suffix = entry.truncated ? " (truncated)" : "";
        lines.push(`  • ${entry.path} — ${entry.tokens} tokens${suffix}`);
      });
    }

    if (summary.notes.length > 0) {
      lines.push("", this.applyLabelStyle("Notes"));
      summary.notes.forEach((note) => lines.push(`  • ${note}`));
    }

    return this.renderSection("Summary", lines);
  }

  public buildFileTree(files: ProcessedFileContent[]): string {
    const treeLines = this.buildAsciiTree(files.map((file) => file.relativePath));
    return this.renderSection("File Tree", treeLines);
  }

  public buildFileContent(file: ProcessedFileContent): string {
    const header = `${file.relativePath} (${file.tokens} tokens${file.truncated ? ", truncated" : ""})`;
    const contentLines = this.truncateContent(file.content).split(/\r?\n/);
    return this.renderSection(header, contentLines, { preserveSpacing: true });
  }

  public buildFooter(statistics: DigestResult["statistics"]): string {
    const lines = [
      this.formatKeyValue("Files processed", statistics.filesProcessed.toString()),
      this.formatKeyValue("Tokens", statistics.totalTokens.toString()),
      this.formatKeyValue("Processing time", this.formatDuration(statistics.processingTime)),
      this.formatKeyValue("Warnings", statistics.warnings.length.toString()),
      this.formatKeyValue("Errors", statistics.errors.length.toString())
    ];

    if (statistics.warnings.length > 0) {
      lines.push("", this.applyLabelStyle("Warnings"));
      statistics.warnings.forEach((warning) => lines.push(`  • ${warning}`));
    }

    if (statistics.errors.length > 0) {
      lines.push("", this.applyLabelStyle("Errors"));
      statistics.errors.forEach((error) => lines.push(`  • ${error}`));
    }

    return this.renderSection("Statistics", lines);
  }

  private buildAsciiTree(paths: string[]): string[] {
    if (paths.length === 0) {
      return ["<no files>"];
    }

    const root: TreeNode = { name: "", isFile: false, children: new Map() };

    paths.forEach((relPath) => {
      const segments = relPath.split(/\\|\//);
      let current = root;
      segments.forEach((segment, index) => {
        const isFile = index === segments.length - 1;
        if (!current.children.has(segment)) {
          current.children.set(segment, { name: segment, isFile, children: new Map() });
        }
        const node = current.children.get(segment)!;
        if (isFile) {
          node.isFile = true;
        }
        current = node;
      });
    });

    const lines: string[] = [];

    const traverse = (node: TreeNode, prefix: string) => {
      const sorted = Array.from(node.children.values()).sort((a, b) => a.name.localeCompare(b.name));
      sorted.forEach((child, index) => {
        const isLast = index === sorted.length - 1;
        const connector = isLast ? "└──" : "├──";
        lines.push(`${prefix}${connector} ${child.name}`);
        const nextPrefix = prefix + (isLast ? "    " : "│   ");
        if (child.children.size > 0) {
          traverse(child, nextPrefix);
        }
      });
    };

    traverse(root, "");
    return lines;
  }

  private formatKeyValue(label: string, value: string): string {
    const labelWidth = this.options.text?.columnWidths?.label ?? 18;
    const valueWidth = this.options.text?.columnWidths?.value ?? 52;

    const styledLabel = this.applyLabelStyle(`${label}:`.padEnd(labelWidth, " "));
    const wrappedValue = this.wrapText(value, valueWidth);

    return wrappedValue
      .map((line, index) => (index === 0 ? `${styledLabel} ${line}` : `${" ".repeat(labelWidth)} ${line}`))
      .join("\n");
  }

  private wrapText(value: string, maxWidth: number): string[] {
    if (value.length <= maxWidth) {
      return [value];
    }

    const words = value.split(/\s+/);
    const lines: string[] = [];
    let current = "";

    for (const word of words) {
      if (current.length === 0) {
        current = word;
        continue;
      }

      if ((current + " " + word).length <= maxWidth) {
        current = `${current} ${word}`;
      } else {
        lines.push(current);
        if (word.length > maxWidth) {
          lines.push(...this.chunkLine(word, maxWidth));
          current = "";
        } else {
          current = word;
        }
      }
    }

    if (current.length > 0) {
      lines.push(current);
    }

    return lines;
  }

  private chunkLine(value: string, maxWidth: number): string[] {
    if (value.length === 0) {
      return [""];
    }

    const segments: string[] = [];
    let start = 0;
    while (start < value.length) {
      segments.push(value.slice(start, start + maxWidth));
      start += maxWidth;
    }
    return segments;
  }

  private renderSection(title: string, bodyLines: string[], options: RenderSectionOptions = {}): string {
    const lineWidth = this.options.text?.lineWidth ?? 80;
    const useAsciiBox = this.options.text?.useAsciiBoxes ?? true;

    if (!useAsciiBox) {
      const wrapped = bodyLines.flatMap((line) => this.wrapLine(line, lineWidth, options.preserveSpacing ?? false));
      return [this.applyLabelStyle(title), this.generateSeparator(lineWidth), ...wrapped].join("\n");
    }

    const innerWidth = Math.min(
      lineWidth - 4,
      Math.max(
        title.length,
        ...bodyLines.flatMap((line) => this.wrapLine(line, lineWidth - 4, options.preserveSpacing ?? false)).map((line) => line.length)
      )
    );
    const effectiveInnerWidth = Math.max(10, innerWidth);
    const wrappedBody = bodyLines.flatMap((line) => this.wrapLine(line, effectiveInnerWidth, options.preserveSpacing ?? false));

    const top = `┌${"─".repeat(effectiveInnerWidth + 2)}┐`;
    const header = `│ ${this.padLine(this.applyLabelStyle(title), effectiveInnerWidth)} │`;
    const content = wrappedBody.length > 0
      ? wrappedBody.map((line) => `│ ${this.padLine(line, effectiveInnerWidth)} │`)
      : [`│ ${"".padEnd(effectiveInnerWidth, " ")} │`];
    const bottom = `└${"─".repeat(effectiveInnerWidth + 2)}┘`;

    return [top, header, ...content, bottom].join("\n");
  }

  private wrapLine(line: string, maxWidth: number, preserveSpacing: boolean): string[] {
    if (line.length === 0) {
      return [""];
    }

    if (preserveSpacing) {
      return this.chunkLine(line, Math.max(1, maxWidth));
    }

    return this.wrapText(line, Math.max(1, maxWidth));
  }

  private padLine(line: string, width: number): string {
    if (line.length === width) {
      return line;
    }
    if (line.length < width) {
      return line.padEnd(width, " ");
    }
    return line.slice(0, width);
  }

  private applyLabelStyle(value: string): string {
    if (!this.options.text?.showColorCodes) {
      return value;
    }
    const cyan = "\u001b[36m";
    const reset = "\u001b[0m";
    return `${cyan}${value}${reset}`;
  }
}
