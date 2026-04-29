import { BaseFormatter } from "./base/formatter.interface";
import type { FormatterOptions, FormatterTemplateSet } from "./types";
import type { DigestMetadata, DigestResult, DigestSummary, ProcessedFileContent } from "../services/digestGenerator";

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
    const metadataView = this.renderMetadata(metadata);
    const rendered = this.renderSection(
      "Digest Metadata",
      metadataView.keyValues.flatMap((entry) => this.formatKeyValue(entry.label, entry.value).split("\n"))
    );

    return this.applyTemplate("header", rendered, {
      metadata,
      metadataView
    });
  }

  public buildSummary(summary: DigestSummary): string {
    const summaryView = this.renderSummary(summary);
    const lines: string[] = summaryView.overview.map((entry) => this.formatKeyValue(entry.label, entry.value));

    if (summaryView.tableOfContents.length > 0) {
      lines.push("", this.applyLabelStyle("Table of Contents"));
      summaryView.tableOfContents.forEach((entry) => {
        const suffix = entry.truncated ? " (truncated)" : "";
        lines.push(`  • ${entry.path} — ${entry.tokens} tokens${suffix}`);
      });
    }

    if (summaryView.notes.length > 0) {
      lines.push("", this.applyLabelStyle("Notes"));
      summaryView.notes.forEach((note) => lines.push(`  • ${note}`));
    }

    const rendered = this.renderSection("Summary", lines);
    return this.applyTemplate("summary", rendered, {
      summary,
      summaryView
    });
  }

  public buildFileTree(files: ProcessedFileContent[]): string {
    const treeView = this.getFileTreeView(files, this.getCurrentContext());
    const rendered = this.renderSection("File Tree", treeView.ascii);
    return this.applyTemplate("fileTree", rendered, {
      files,
      fileTreeView: treeView
    });
  }

  public buildFileContent(file: ProcessedFileContent): string {
    const header = `${file.relativePath} (${file.tokens} tokens${file.truncated ? ", truncated" : ""})`;
    const contentLines = this.truncateContent(file.content).split(/\r?\n/);
    const rendered = this.renderSection(header, contentLines, { preserveSpacing: true });
    return this.applyTemplate("fileContent", rendered, { file });
  }

  public buildFooter(statistics: DigestResult["statistics"]): string {
    const statisticsView = this.renderStatistics(statistics);
    const lines: string[] = statisticsView.keyValues.map((entry) => this.formatKeyValue(entry.label, entry.value));

    if (statisticsView.warnings.length > 0) {
      lines.push("", this.applyLabelStyle("Warnings"));
      statisticsView.warnings.forEach((warning) => lines.push(`  • ${warning}`));
    }

    if (statisticsView.errors.length > 0) {
      lines.push("", this.applyLabelStyle("Errors"));
      statisticsView.errors.forEach((error) => lines.push(`  • ${error}`));
    }

    const rendered = this.renderSection("Statistics", lines);
    return this.applyTemplate("footer", rendered, {
      statistics,
      statisticsView
    });
  }

  public override finalize(digestResult: DigestResult): string {
    const output = super.finalize(digestResult);
    return this.applyTemplate("finalize", output, {
      digest: digestResult,
      metadata: digestResult.content.metadata,
      metadataView: this.renderMetadata(digestResult.content.metadata),
      summary: digestResult.content.summary,
      summaryView: this.renderSummary(digestResult.content.summary),
      statistics: digestResult.statistics,
      statisticsView: this.renderStatistics(digestResult.statistics)
    });
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