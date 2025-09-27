import { describe, expect, it } from "@jest/globals";
import { NotebookProcessor } from "./notebookProcessor";
import type { DigestConfig } from "../utils/validateConfig";

const defaultConfig: DigestConfig = {
  includeCodeCells: true,
  includeMarkdownCells: true,
  includeCellOutputs: false
};

describe("NotebookProcessor.buildNotebookContent", () => {
  it("returns a placeholder when the notebook cannot be parsed", () => {
    const result = NotebookProcessor.buildNotebookContent("not-json", defaultConfig);
    expect(result).toBe("[unable to parse notebook]");
  });

  it("emits markdown and code cells respecting configuration", () => {
    const notebook = {
      cells: [
        { cell_type: "markdown", source: ["# Title\n", "Some text"] },
        {
          cell_type: "code",
          source: "print('hi')\n",
          outputs: [
            {
              output_type: "stream",
              text: ["line1", "line2"]
            }
          ]
        }
      ]
    };

    const config = { ...defaultConfig, includeCellOutputs: true } as DigestConfig;
    const content = NotebookProcessor.buildNotebookContent(JSON.stringify(notebook), config);

    expect(content).toContain("## Cell 1 (markdown)");
    expect(content).toContain("# Title\nSome text");
    expect(content).toContain("## Cell 2 (code)");
    expect(content).toContain("```python\nprint('hi')");
    expect(content).toContain("```output\nline1\nline2");
  });

  it("skips markdown cells when disabled", () => {
    const notebook = {
      cells: [
        { cell_type: "markdown", source: "ignored" },
        { cell_type: "code", source: "print(1)" }
      ]
    };

    const config = { ...defaultConfig, includeMarkdownCells: false } as DigestConfig;
    const content = NotebookProcessor.buildNotebookContent(JSON.stringify(notebook), config);

    expect(content).not.toContain("markdown");
    expect(content).toContain("## Cell 2 (code)");
  });

  it("returns an empty string when there are no cells", () => {
    const notebook = { cells: [] };
    const content = NotebookProcessor.buildNotebookContent(JSON.stringify(notebook), defaultConfig);
    expect(content).toBe("");
  });
});