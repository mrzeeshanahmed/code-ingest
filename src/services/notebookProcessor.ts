import type { DigestConfig } from "../utils/validateConfig";

interface NotebookCell {
  cell_type?: string;
  source?: string | string[];
  outputs?: unknown[];
}

interface NotebookFile {
  cells?: NotebookCell[];
  metadata?: Record<string, unknown>;
  nbformat?: number;
}

const NON_TEXT_PLACEHOLDER = "[non-text output omitted]";
const PARSE_ERROR_PLACEHOLDER = "[unable to parse notebook]";

export class NotebookProcessor {
  /**
   * Parses a raw Jupyter notebook JSON string and emits a formatted textual
   * representation according to the supplied configuration.
   */
  public static buildNotebookContent(rawContent: string, config: DigestConfig): string {
    const includeCode = config.includeCodeCells !== false;
    const includeMarkdown = config.includeMarkdownCells !== false;
    const includeOutputs = config.includeCellOutputs === true;

    let notebook: NotebookFile | undefined;
    try {
      notebook = JSON.parse(rawContent) as NotebookFile;
    } catch {
      return PARSE_ERROR_PLACEHOLDER;
    }

    const cells = Array.isArray(notebook?.cells) ? notebook!.cells! : [];
    if (cells.length === 0) {
      return "";
    }

    const lines: string[] = [];

    cells.forEach((cell, index) => {
      const cellType = cell?.cell_type ?? "unknown";
      const header = `## Cell ${index + 1} (${cellType})`;

      if (cellType === "markdown") {
        if (!includeMarkdown) {
          return;
        }
        const body = NotebookProcessor.normalizeSource(cell?.source);
        if (body.trim().length === 0) {
          return;
        }
        lines.push(header);
        lines.push(body.trimEnd());
      } else if (cellType === "code") {
        if (!includeCode) {
          return;
        }
        const body = NotebookProcessor.normalizeSource(cell?.source);
        lines.push(header);
        lines.push("```python");
        if (body.length > 0) {
          lines.push(body.trimEnd());
        }
        lines.push("```");

        if (includeOutputs && Array.isArray(cell?.outputs) && cell.outputs.length > 0) {
          const outputLines = NotebookProcessor.extractOutputs(cell.outputs);
          if (outputLines.length > 0) {
            lines.push("```output");
            lines.push(...outputLines);
            lines.push("```");
          }
        }
      } else {
        // Unknown cell type; include raw source if allowed (default to include).
        if (!includeMarkdown && !includeCode) {
          return;
        }
        const body = NotebookProcessor.normalizeSource(cell?.source);
        if (body.length > 0) {
          lines.push(header);
          lines.push(body.trimEnd());
        }
      }
    });

    return lines.join("\n");
  }

  private static normalizeSource(source: NotebookCell["source"]): string {
    if (Array.isArray(source)) {
      return source.join("");
    }
    if (typeof source === "string") {
      return source;
    }
    return "";
  }

  private static extractOutputs(outputs: unknown[]): string[] {
    const result: string[] = [];

    for (const output of outputs) {
      if (output == null || typeof output !== "object") {
        continue;
      }
      const obj = output as Record<string, unknown>;
      const outputType = typeof obj["output_type"] === "string" ? (obj["output_type"] as string) : "";

      if (outputType === "stream") {
        const text = obj["text"];
        const lines = NotebookProcessor.normalizeOutputText(text);
        if (lines.length > 0) {
          result.push(...lines);
        }
        continue;
      }

      if (outputType === "error") {
        const traceback = Array.isArray(obj["traceback"]) ? (obj["traceback"] as string[]) : [];
        if (traceback.length > 0) {
          result.push(...traceback);
        } else {
          const ename = typeof obj["ename"] === "string" ? obj["ename"] : "Error";
          const evalue = typeof obj["evalue"] === "string" ? obj["evalue"] : "";
          result.push(`${ename}: ${evalue}`.trim());
        }
        continue;
      }

      const data = obj["data"];
      if (data && typeof data === "object") {
        const dataObj = data as Record<string, unknown>;
        const textPlain = dataObj["text/plain"];
        const jsonMime = dataObj["application/json"];

        if (Array.isArray(textPlain)) {
          result.push(...textPlain.map(String));
          continue;
        }
        if (typeof textPlain === "string") {
          result.push(textPlain);
          continue;
        }
        if (typeof jsonMime === "string") {
          result.push(jsonMime);
          continue;
        }
        if (Array.isArray(jsonMime)) {
          result.push(...jsonMime.map((entry) => (typeof entry === "string" ? entry : JSON.stringify(entry))));
          continue;
        }
        result.push(NON_TEXT_PLACEHOLDER);
        continue;
      }

      const textFallback = NotebookProcessor.normalizeOutputText(obj["text"]);
      if (textFallback.length > 0) {
        result.push(...textFallback);
      } else {
        result.push(NON_TEXT_PLACEHOLDER);
      }
    }

    return result;
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
}
