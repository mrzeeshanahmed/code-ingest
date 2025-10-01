import { Buffer } from "node:buffer";
import { createReadStream } from "node:fs";
import { performance } from "node:perf_hooks";
import * as path from "node:path";
import * as vscode from "vscode";

import { wrapError } from "../utils/errorHandling";
import type { DigestConfig } from "../utils/validateConfig";

interface NotebookCell {
  cell_type?: string;
  source?: string | string[];
  outputs?: NotebookOutput[];
  metadata?: Record<string, unknown>;
  execution_count?: number | null;
}

interface NotebookOutput {
  output_type?: string;
  name?: string;
  text?: unknown;
  data?: Record<string, unknown> | undefined;
  ename?: unknown;
  evalue?: unknown;
  traceback?: unknown;
}

interface NotebookFile {
  cells?: NotebookCell[];
  metadata?: Record<string, unknown>;
  nbformat?: number;
}

interface ParseNotebookResult {
  notebook?: NotebookFile;
  warnings: string[];
}

interface ReadNotebookResult {
  raw: string;
  size: number;
  warnings: string[];
}

type NonTextHandler = (output: NonTextOutput, maxBytes: number) => string | null;

export interface NotebookProcessingOptions {
  includeCodeCells: boolean;
  includeMarkdownCells: boolean;
  includeOutputs: boolean;
  includeNonTextOutputs: boolean;
  nonTextOutputMaxBytes: number;
  cellSeparator: string;
  outputSeparator: string;
  preserveMarkdownFormatting: boolean;
  customNonTextHandlers?: Record<string, NonTextHandler>;
}

export interface ProcessedNotebook {
  content: string;
  cellCount: {
    code: number;
    markdown: number;
    raw: number;
  };
  outputCount: {
    text: number;
    nonText: number;
    skipped: number;
  };
  totalSize: number;
  processingTime: number;
  warnings: string[];
}

export interface NonTextOutput {
  mimeType: string;
  data: string;
  size: number;
  filename?: string;
}

interface OutputExtractionResult {
  lines: string[];
  textCount: number;
  nonTextCount: number;
  skippedCount: number;
  byteSize: number;
  warnings: string[];
}

const DEFAULT_NON_TEXT_MAX_BYTES = 200 * 1024;
const LARGE_NOTEBOOK_WARNING_THRESHOLD = 20 * 1024 * 1024;
const CODE_BLOCK_LANGUAGE = "python";
const PARSE_ERROR_PLACEHOLDER = "[unable to parse notebook]";
const SOURCE_OMITTED_PLACEHOLDER = "[cell source omitted by configuration]";
const NON_TEXT_PLACEHOLDER = "[non-text output omitted]";

const DEFAULT_OPTIONS: NotebookProcessingOptions = {
  includeCodeCells: true,
  includeMarkdownCells: true,
  includeOutputs: true,
  includeNonTextOutputs: false,
  nonTextOutputMaxBytes: DEFAULT_NON_TEXT_MAX_BYTES,
  cellSeparator: "\n\n",
  outputSeparator: "\n",
  preserveMarkdownFormatting: true
};

export class NotebookProcessor {
  private static readonly registeredNonTextHandlers = new Map<string, NonTextHandler>();

  public static registerNonTextHandler(mimeType: string, handler: NonTextHandler): void {
    if (typeof mimeType !== "string" || mimeType.trim().length === 0) {
      throw new Error("A MIME type is required to register a non-text handler.");
    }
    if (typeof handler !== "function") {
      throw new Error("Handler must be a function.");
    }
    this.registeredNonTextHandlers.set(mimeType.toLowerCase(), handler);
  }

  public static async processNotebook(
    filePath: string,
    inputOptions: Partial<NotebookProcessingOptions> = {}
  ): Promise<ProcessedNotebook> {
    const startedAt = performance.now();
    const options = this.resolveOptions(inputOptions);

    let readResult: ReadNotebookResult;
    try {
      readResult = await this.readNotebookFile(filePath);
    } catch (error) {
      throw wrapError(error, { filePath, stage: "read-notebook" });
    }

    const parseResult = this.parseNotebook(readResult.raw);
    const warnings = [...readResult.warnings, ...parseResult.warnings];

    if (!parseResult.notebook) {
      return {
        content: PARSE_ERROR_PLACEHOLDER,
        cellCount: { code: 0, markdown: 0, raw: 0 },
        outputCount: { text: 0, nonText: 0, skipped: 0 },
        totalSize: Buffer.byteLength(PARSE_ERROR_PLACEHOLDER, "utf8"),
        processingTime: Math.max(0, performance.now() - startedAt),
        warnings: [
          ...warnings,
          "Notebook JSON could not be parsed. Open the notebook in Jupyter or VS Code to repair formatting before retrying."
        ]
      };
    }

    const processed = this.processParsedNotebook(parseResult.notebook, options, warnings);
    return {
      ...processed,
      totalSize: Buffer.byteLength(processed.content, "utf8"),
      processingTime: Math.max(0, performance.now() - startedAt)
    };
  }

  public static extractCodeCells(notebook: NotebookFile | undefined, options: NotebookProcessingOptions): string[] {
    if (!options.includeCodeCells || !Array.isArray(notebook?.cells)) {
      return [];
    }

    const segments: string[] = [];
    notebook!.cells!.forEach((cell, index) => {
      if ((cell?.cell_type ?? "").toLowerCase() !== "code") {
        return;
      }
      const formatted = this.formatCodeCell(cell, index, options);
      if (formatted.length > 0) {
        segments.push(formatted.join("\n"));
      }
    });
    return segments;
  }

  public static extractMarkdownCells(notebook: NotebookFile | undefined, options: NotebookProcessingOptions): string[] {
    if (!options.includeMarkdownCells || !Array.isArray(notebook?.cells)) {
      return [];
    }

    const segments: string[] = [];
    notebook!.cells!.forEach((cell, index) => {
      if ((cell?.cell_type ?? "").toLowerCase() !== "markdown") {
        return;
      }
      const formatted = this.formatMarkdownCell(cell, index, options);
      if (formatted.length > 0) {
        segments.push(formatted.join("\n"));
      }
    });
    return segments;
  }

  public static extractCellOutputs(cell: NotebookCell, options: NotebookProcessingOptions): string[] {
    return this.extractOutputsDetailed(cell, options).lines;
  }

  public static processNonTextOutput(output: NonTextOutput | null | undefined, maxBytes: number): string | null {
    if (!output || typeof output.mimeType !== "string" || typeof output.data !== "string") {
      return null;
    }

    const sanitized = output.data.replace(/\s+/g, "");
    if (output.size > maxBytes) {
      return `[non-text output ${output.mimeType} truncated (${formatBytes(output.size)} > ${formatBytes(maxBytes)})]`;
    }
    return `![${output.mimeType}](data:${output.mimeType};base64,${sanitized})`;
  }

  public static buildNotebookContent(rawContent: string, config: DigestConfig): string {
    const options = this.resolveOptions({
      includeCodeCells: config.includeCodeCells ?? true,
      includeMarkdownCells: config.includeMarkdownCells ?? true,
      includeOutputs: config.includeCellOutputs ?? false
    });

    const parseResult = this.parseNotebook(rawContent);
    if (!parseResult.notebook) {
      return PARSE_ERROR_PLACEHOLDER;
    }
    const processed = this.processParsedNotebook(parseResult.notebook, options, [...parseResult.warnings]);
    return processed.content;
  }

  private static resolveOptions(input: Partial<NotebookProcessingOptions>): NotebookProcessingOptions {
    const configuration = vscode.workspace.getConfiguration("codeIngest");
    const includeCodeCells = input.includeCodeCells ?? configuration.get<boolean>("notebookIncludeCodeCells") ?? DEFAULT_OPTIONS.includeCodeCells;
    const includeMarkdownCells =
      input.includeMarkdownCells ?? configuration.get<boolean>("notebookIncludeMarkdownCells") ?? DEFAULT_OPTIONS.includeMarkdownCells;
    const includeOutputs = input.includeOutputs ?? configuration.get<boolean>("notebookIncludeOutputs") ?? DEFAULT_OPTIONS.includeOutputs;
    const includeNonTextOutputs =
      input.includeNonTextOutputs ?? configuration.get<boolean>("notebookIncludeNonTextOutputs") ?? DEFAULT_OPTIONS.includeNonTextOutputs;
    const nonTextOutputMaxBytes =
      input.nonTextOutputMaxBytes ?? configuration.get<number>("notebookNonTextOutputMaxBytes") ?? DEFAULT_OPTIONS.nonTextOutputMaxBytes;

    const resolved: NotebookProcessingOptions = {
      includeCodeCells,
      includeMarkdownCells,
      includeOutputs,
      includeNonTextOutputs,
      nonTextOutputMaxBytes: Math.max(0, nonTextOutputMaxBytes),
      cellSeparator: input.cellSeparator ?? DEFAULT_OPTIONS.cellSeparator,
      outputSeparator: input.outputSeparator ?? DEFAULT_OPTIONS.outputSeparator,
      preserveMarkdownFormatting: input.preserveMarkdownFormatting ?? DEFAULT_OPTIONS.preserveMarkdownFormatting
    };

    if (input.customNonTextHandlers) {
      resolved.customNonTextHandlers = input.customNonTextHandlers;
    }

    return resolved;
  }

  private static async readNotebookFile(filePath: string): Promise<ReadNotebookResult> {
    return new Promise((resolve, reject) => {
      const stream = createReadStream(path.resolve(filePath), { encoding: "utf8", highWaterMark: 64 * 1024 });
      let raw = "";
      let size = 0;
      const warnings: string[] = [];

      stream.on("data", (chunk: string) => {
        raw += chunk;
        size += Buffer.byteLength(chunk, "utf8");
        if (size > LARGE_NOTEBOOK_WARNING_THRESHOLD && warnings.length === 0) {
          warnings.push("Notebook size exceeds 20MB. Consider clearing outputs to improve performance.");
        }
      });

      stream.once("error", (error) => {
        reject(error);
      });

      stream.once("close", () => {
        resolve({ raw, size, warnings });
      });
    });
  }

  private static parseNotebook(raw: string): ParseNotebookResult {
    const warnings: string[] = [];
    if (raw.trim().length === 0) {
      return { notebook: { cells: [] }, warnings };
    }

    try {
      const parsed = JSON.parse(raw) as NotebookFile;
      if (!Array.isArray(parsed?.cells)) {
        warnings.push("Notebook is missing a valid 'cells' array. Rendering an empty document.");
        return { notebook: { cells: [] }, warnings };
      }
      return { notebook: parsed, warnings };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`Failed to parse notebook JSON: ${message}. Try re-saving the notebook from Jupyter.`);
      return { warnings };
    }
  }

  private static processParsedNotebook(
    notebook: NotebookFile,
    options: NotebookProcessingOptions,
    warnings: string[]
  ): Omit<ProcessedNotebook, "totalSize" | "processingTime"> {
    const segments: string[] = [];
    const cellCount = { code: 0, markdown: 0, raw: 0 };
    const outputCount = { text: 0, nonText: 0, skipped: 0 };
    let cumulativeOutputBytes = 0;

    const cells = Array.isArray(notebook.cells) ? notebook.cells : [];

    cells.forEach((cell, index) => {
      const type = (cell?.cell_type ?? "raw").toLowerCase();
      if (type === "code") {
        cellCount.code += 1;
      } else if (type === "markdown") {
        cellCount.markdown += 1;
      } else {
        cellCount.raw += 1;
      }

      const sectionLines: string[] = [`### Cell ${index + 1} [${type}]`];
      const metadataLines = this.formatMetadata(cell.metadata, type);
      if (metadataLines.length > 0) {
        sectionLines.push(...metadataLines);
      }

      if (type === "markdown") {
        if (!options.includeMarkdownCells) {
          sectionLines.push(SOURCE_OMITTED_PLACEHOLDER);
        } else {
          const markdown = this.normalizeSource(cell.source);
          if (markdown.trim().length === 0) {
            warnings.push(`Markdown cell ${index + 1} is empty.`);
          } else {
            const rendered = options.preserveMarkdownFormatting ? markdown.trimEnd() : this.stripMarkdown(markdown).trimEnd();
            sectionLines.push(rendered);
          }
        }
      } else if (type === "code") {
        const executionCount = typeof cell.execution_count === "number" ? cell.execution_count : null;
        if (executionCount != null) {
          sectionLines.push(`Execution Count: ${executionCount}`);
        }

        if (!options.includeCodeCells) {
          sectionLines.push(SOURCE_OMITTED_PLACEHOLDER);
        } else {
          const source = this.normalizeSource(cell.source);
          if (source.trim().length === 0) {
            warnings.push(`Code cell ${index + 1} has no source content.`);
          }
          sectionLines.push("```" + CODE_BLOCK_LANGUAGE);
          if (source.length > 0) {
            sectionLines.push(source.trimEnd());
          }
          sectionLines.push("```");
        }

        if (options.includeOutputs && Array.isArray(cell.outputs) && cell.outputs.length > 0) {
          const detailed = this.extractOutputsDetailed(cell, options);
          outputCount.text += detailed.textCount;
          outputCount.nonText += detailed.nonTextCount;
          outputCount.skipped += detailed.skippedCount;
          cumulativeOutputBytes += detailed.byteSize;
          if (detailed.lines.length > 0) {
            sectionLines.push("```output");
            sectionLines.push(detailed.lines.join(options.outputSeparator));
            sectionLines.push("```");
          }
          if (detailed.warnings.length > 0) {
            warnings.push(...detailed.warnings.map((message) => `Cell ${index + 1}: ${message}`));
          }
        }
      } else {
        const rawContent = this.normalizeSource(cell.source);
        if (rawContent.trim().length === 0) {
          warnings.push(`Raw cell ${index + 1} is empty.`);
        } else {
          sectionLines.push(rawContent.trimEnd());
        }
      }

      segments.push(sectionLines.join("\n"));
    });

    if (segments.length === 0) {
      warnings.push("Notebook contained no renderable cells.");
    }

    if (cumulativeOutputBytes > 0) {
      warnings.push(`Notebook outputs consumed approximately ${formatBytes(cumulativeOutputBytes)}.`);
    }

    const content = segments.join(options.cellSeparator).trimEnd();
    return {
      content,
      cellCount,
      outputCount,
      warnings
    };
  }

  private static formatCodeCell(cell: NotebookCell, index: number, options: NotebookProcessingOptions): string[] {
    if (!options.includeCodeCells) {
      return [];
    }

    const lines: string[] = [`### Cell ${index + 1} [code]`];
    const executionCount = typeof cell.execution_count === "number" ? cell.execution_count : null;
    if (executionCount != null) {
      lines.push(`Execution Count: ${executionCount}`);
    }

    const metadata = this.formatMetadata(cell.metadata, "code");
    if (metadata.length > 0) {
      lines.push(...metadata);
    }

    const source = this.normalizeSource(cell.source);
    if (source.trim().length === 0) {
      lines.push(SOURCE_OMITTED_PLACEHOLDER);
      return lines;
    }

    lines.push("```" + CODE_BLOCK_LANGUAGE);
    lines.push(source.trimEnd());
    lines.push("```");
    return lines;
  }

  private static formatMarkdownCell(cell: NotebookCell, index: number, options: NotebookProcessingOptions): string[] {
    if (!options.includeMarkdownCells) {
      return [];
    }

    const lines: string[] = [`### Cell ${index + 1} [markdown]`];
    const metadata = this.formatMetadata(cell.metadata, "markdown");
    if (metadata.length > 0) {
      lines.push(...metadata);
    }

    const source = this.normalizeSource(cell.source);
    if (source.trim().length === 0) {
      return lines;
    }

    const rendered = options.preserveMarkdownFormatting ? source.trimEnd() : this.stripMarkdown(source).trimEnd();
    lines.push(rendered);
    return lines;
  }

  private static formatMetadata(metadata: NotebookCell["metadata"], cellType: string): string[] {
    if (!metadata || typeof metadata !== "object") {
      return [];
    }
    const serialized = safeStringify(metadata);
    if (!serialized) {
      return [];
    }
    return cellType === "markdown" ? [`<!-- metadata: ${serialized} -->`] : [`# metadata: ${serialized}`];
  }

  private static extractOutputsDetailed(cell: NotebookCell, options: NotebookProcessingOptions): OutputExtractionResult {
    const lines: string[] = [];
    const warnings: string[] = [];
    let textCount = 0;
    let nonTextCount = 0;
    let skippedCount = 0;
    let byteSize = 0;

    for (const output of cell.outputs ?? []) {
      if (!output || typeof output !== "object") {
        warnings.push("Encountered output with unsupported structure.");
        continue;
      }

      const outputType = typeof output.output_type === "string" ? output.output_type : "";
      if (outputType === "stream") {
        const name = typeof output.name === "string" ? output.name : "stdout";
        const text = this.normalizeOutputText(output.text).join("");
        if (text.length > 0) {
          const entry = `${name}: ${text}`.trim();
          lines.push(entry);
          textCount += 1;
          byteSize += Buffer.byteLength(entry, "utf8");
        }
        continue;
      }

      if (outputType === "error") {
        const traceback = Array.isArray(output.traceback)
          ? output.traceback.map((frame) => String(frame)).join("\n")
          : undefined;
        if (traceback && traceback.length > 0) {
          lines.push(traceback);
        } else {
          const name = typeof output.ename === "string" ? output.ename : "Error";
          const value = typeof output.evalue === "string" ? output.evalue : "";
          lines.push(`${name}: ${value}`.trim());
        }
        textCount += 1;
        continue;
      }

      const data = output.data && typeof output.data === "object" ? output.data : undefined;
      if (data) {
        const textPlain = this.coerceDataString(data["text/plain"]);
        const htmlData = this.coerceDataString(data["text/html"]);
        const jsonData = data["application/json"];
        const svgData = this.coerceDataString(data["image/svg+xml"]);
        const pngData = this.coerceDataString(data["image/png"]);
        const jpegData = this.coerceDataString(data["image/jpeg"]);

        if (textPlain) {
          lines.push(textPlain);
          textCount += 1;
          byteSize += Buffer.byteLength(textPlain, "utf8");
        }

        if (htmlData) {
          const sanitized = this.sanitizeHtml(htmlData);
          lines.push(sanitized);
          textCount += 1;
          byteSize += Buffer.byteLength(sanitized, "utf8");
        }

        if (jsonData != null) {
          const serialized = this.serializeJsonOutput(jsonData);
          lines.push(serialized);
          textCount += 1;
          byteSize += Buffer.byteLength(serialized, "utf8");
        }

        const nonTextCandidates: Array<{ mimeType: string; payload: string | undefined }> = [
          { mimeType: "image/png", payload: pngData },
          { mimeType: "image/jpeg", payload: jpegData },
          { mimeType: "image/svg+xml", payload: svgData }
        ];

        for (const candidate of nonTextCandidates) {
          if (!candidate.payload) {
            continue;
          }
          if (!options.includeNonTextOutputs) {
            skippedCount += 1;
            warnings.push(`Skipped ${candidate.mimeType} output due to configuration.`);
            continue;
          }

          const normalizedData = candidate.payload.replace(/\s+/g, "");
          const estimatedSize = estimateBase64Size(normalizedData);
          const rendered = this.resolveNonTextOutput(
            { mimeType: candidate.mimeType, data: normalizedData, size: estimatedSize },
            options
          );
          if (!rendered) {
            lines.push(NON_TEXT_PLACEHOLDER);
            skippedCount += 1;
            continue;
          }

          if (rendered.startsWith("[non-text output")) {
            skippedCount += 1;
            lines.push(rendered);
            warnings.push(`Output ${candidate.mimeType} exceeded configured size limit (${formatBytes(estimatedSize)}).`);
          } else {
            nonTextCount += 1;
            lines.push(rendered);
            byteSize += Buffer.byteLength(rendered, "utf8");
          }
        }

        continue;
      }

      const fallback = this.normalizeOutputText(output.text).join("\n");
      if (fallback.length > 0) {
        lines.push(fallback);
        textCount += 1;
        byteSize += Buffer.byteLength(fallback, "utf8");
      } else {
        lines.push(NON_TEXT_PLACEHOLDER);
        skippedCount += 1;
      }
    }

    return { lines, textCount, nonTextCount, skippedCount, byteSize, warnings };
  }

  private static resolveNonTextOutput(output: NonTextOutput, options: NotebookProcessingOptions): string | null {
    const customHandler = options.customNonTextHandlers?.[output.mimeType];
    if (customHandler) {
      const customResult = customHandler(output, options.nonTextOutputMaxBytes);
      if (customResult != null) {
        return customResult;
      }
    }

    const registered = this.registeredNonTextHandlers.get(output.mimeType.toLowerCase());
    if (registered) {
      const handlerResult = registered(output, options.nonTextOutputMaxBytes);
      if (handlerResult != null) {
        return handlerResult;
      }
    }

    return this.processNonTextOutput(output, options.nonTextOutputMaxBytes);
  }

  private static normalizeSource(source: NotebookCell["source"]): string {
    if (Array.isArray(source)) {
      return source.map((entry) => String(entry)).join("");
    }
    if (typeof source === "string") {
      return source;
    }
    return "";
  }

  private static normalizeOutputText(text: unknown): string[] {
    if (Array.isArray(text)) {
      return text.map((entry) => String(entry));
    }
    if (typeof text === "string") {
      return [text];
    }
    return [];
  }

  private static stripMarkdown(markdown: string): string {
    return markdown
      .replace(/```[\s\S]*?```/g, "")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/\*([^*]+)\*/g, "$1")
      .replace(/\[(.*?)\]\((.*?)\)/g, "$1 ($2)")
      .replace(/^#+\s+/gm, "")
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  private static sanitizeHtml(input: string): string {
    return input
      .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, "")
      .replace(/ on[a-z]+="[^"]*"/gi, "")
      .replace(/javascript:/gi, "");
  }

  private static coerceDataString(value: unknown): string | undefined {
    if (typeof value === "string") {
      return value;
    }
    if (Array.isArray(value)) {
      return value.map((entry) => String(entry)).join("");
    }
    return undefined;
  }

  private static serializeJsonOutput(value: unknown): string {
    try {
      return typeof value === "string" ? value : JSON.stringify(value, null, 2);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `{"error": "Unable to serialize JSON output: ${message}"}`;
    }
  }
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB"] as const;
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, exponent);
  return `${value.toFixed(value >= 10 || exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

function estimateBase64Size(data: string): number {
  const sanitized = data.replace(/\s+/g, "");
  if (sanitized.length === 0) {
    return 0;
  }
  const padding = sanitized.endsWith("==") ? 2 : sanitized.endsWith("=") ? 1 : 0;
  return Math.floor((sanitized.length * 3) / 4 - padding);
}

function safeStringify(metadata: Record<string, unknown>): string | undefined {
  try {
    const json = JSON.stringify(metadata);
    if (json && json !== "{}") {
      return json;
    }
    return undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `{"error": "${message}"}`;
  }
}
