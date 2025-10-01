import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

import { NotebookProcessor, type NotebookProcessingOptions } from "../services/notebookProcessor";

const tempFiles: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempFiles.splice(0).map((filePath) => fs.rm(filePath, { force: true }))
  );
});

beforeEach(() => {
  mockConfiguration();
});

function mockConfiguration(overrides: Record<string, unknown> = {}): void {
  const defaults: Record<string, unknown> = {
    notebookIncludeCodeCells: true,
    notebookIncludeMarkdownCells: true,
    notebookIncludeOutputs: true,
    notebookIncludeNonTextOutputs: false,
    notebookNonTextOutputMaxBytes: 200 * 1024
  };
  const snapshot = { ...defaults, ...overrides };
  (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
    get: (key: string, fallback?: unknown) => (key in snapshot ? snapshot[key] : fallback),
    update: jest.fn()
  });
}

async function createTempNotebookFile(content: string): Promise<string> {
  const filePath = path.join(os.tmpdir(), `nb-${Date.now()}-${Math.random().toString(16).slice(2)}.ipynb`);
  await fs.writeFile(filePath, content, "utf8");
  tempFiles.push(filePath);
  return filePath;
}

async function writeNotebookJson(notebook: unknown): Promise<string> {
  return createTempNotebookFile(JSON.stringify(notebook));
}

describe("NotebookProcessor", () => {
  it("returns structured placeholder data when notebook JSON is invalid", async () => {
    mockConfiguration();
    const filePath = await createTempNotebookFile("not-json");

    const result = await NotebookProcessor.processNotebook(filePath);

    expect(result.content).toBe("[unable to parse notebook]");
    expect(result.cellCount).toEqual({ code: 0, markdown: 0, raw: 0 });
    expect(result.outputCount).toEqual({ text: 0, nonText: 0, skipped: 0 });
    expect(result.warnings.join(" ")).toContain("Notebook JSON could not be parsed");
  });

  it("processes code and markdown cells with sanitized outputs and metadata", async () => {
    mockConfiguration({ notebookIncludeNonTextOutputs: true });
    const notebook = {
      cells: [
        {
          cell_type: "code",
          execution_count: 3,
          metadata: { tags: ["test"] },
          source: ["print('hi')\n"],
          outputs: [
            { output_type: "stream", name: "stdout", text: ["line1", "line2"] },
            {
              output_type: "display_data",
              data: {
                "text/html": "<div onclick=\"alert('x')\">Hi</div>",
                "image/png": Buffer.from("image-bytes").toString("base64")
              }
            }
          ]
        },
        {
          cell_type: "markdown",
          metadata: { foo: "bar" },
          source: ["# Heading\n", "Some **bold** text"]
        }
      ]
    } satisfies Record<string, unknown>;

    const filePath = await writeNotebookJson(notebook);

    const result = await NotebookProcessor.processNotebook(filePath, {
      includeNonTextOutputs: true,
      nonTextOutputMaxBytes: 512
    });

    expect(result.cellCount).toEqual({ code: 1, markdown: 1, raw: 0 });
    expect(result.outputCount.nonText).toBe(1);
    expect(result.content).toContain("Execution Count: 3");
    expect(result.content).toContain("stdout: line1line2");
    expect(result.content).not.toContain("onclick");
    expect(result.content).toContain("<!-- metadata: {\"foo\":\"bar\"} -->");
    expect(result.content).toContain("![image/png](data:image/png;base64,");
    expect(result.warnings.some((warning) => warning.includes("Notebook outputs consumed"))).toBe(true);
  });

  it("emits placeholders and warnings when non-text output exceeds size limits", async () => {
    mockConfiguration({ notebookIncludeNonTextOutputs: true, notebookNonTextOutputMaxBytes: 16 });
    const bigImage = Buffer.alloc(128, 1).toString("base64");
    const notebook = {
      cells: [
        {
          cell_type: "code",
          source: ["pass"],
          outputs: [
            {
              output_type: "display_data",
              data: {
                "image/png": bigImage
              }
            }
          ]
        }
      ]
    } satisfies Record<string, unknown>;

    const filePath = await writeNotebookJson(notebook);

    const result = await NotebookProcessor.processNotebook(filePath, {
      includeNonTextOutputs: true,
      nonTextOutputMaxBytes: 16
    });

    expect(result.outputCount.skipped).toBe(1);
    expect(result.content).toContain("[non-text output image/png truncated");
    expect(result.warnings.join(" ")).toContain("exceeded configured size limit");
  });

  it("converts markdown to plain text when preserveMarkdownFormatting is disabled", () => {
    const notebook: NotebookFile = {
      cells: [
        {
          cell_type: "markdown",
          source: ["# Title\n", "Some **bold** text and [link](https://example.com)"]
        }
      ]
    };

    const options: NotebookProcessingOptions = {
      includeCodeCells: false,
      includeMarkdownCells: true,
      includeOutputs: false,
      includeNonTextOutputs: false,
      nonTextOutputMaxBytes: 1024,
      cellSeparator: "\n",
      outputSeparator: "\n",
      preserveMarkdownFormatting: false
    };

    const sections = NotebookProcessor.extractMarkdownCells(notebook, options);

    expect(sections).toHaveLength(1);
    const rendered = sections[0];
    expect(rendered).toContain("Title");
    expect(rendered).not.toContain("**bold**");
    expect(rendered).toContain("link (https://example.com)");
  });
});

type NotebookFile = {
  cells?: Array<{
    cell_type?: string;
    source?: string | string[];
  }>;
};