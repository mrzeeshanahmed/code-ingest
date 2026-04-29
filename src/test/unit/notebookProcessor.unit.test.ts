import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import * as vscode from "vscode";

import { NotebookProcessor } from "../../services/notebookProcessor";
import { TestDataGenerator } from "./utils/mocks";
import { setWorkspaceFolder, withTempWorkspace } from "./testUtils";

type VSCodeMock = typeof vscode & {
  __reset(): void;
  workspace: typeof vscode.workspace & {
    getConfiguration: jest.Mock;
  };
};

describe("NotebookProcessor", () => {
  const vsMock = vscode as unknown as VSCodeMock;

  beforeEach(() => {
    vsMock.__reset();
    vsMock.workspace.getConfiguration.mockReturnValue({
      get: jest.fn((key: string, fallback?: unknown) => {
        switch (key) {
          case "notebookIncludeCodeCells":
          case "notebookIncludeMarkdownCells":
            return true;
          case "notebookIncludeOutputs":
            return true;
          case "notebookIncludeNonTextOutputs":
            return true;
          case "notebookNonTextOutputMaxBytes":
            return 256 * 1024;
          default:
            return fallback;
        }
      })
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  async function writeNotebook(structure: Record<string, unknown>): Promise<string> {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "nb-test-"));
    const filePath = path.join(tmp, "sample.ipynb");
    await fs.writeFile(filePath, JSON.stringify(structure), "utf8");
    setWorkspaceFolder(tmp);
    return filePath;
  }

  it("extracts all cell types and preserves counts", async () => {
    const notebook = TestDataGenerator.generateNotebook(["code", "markdown", "raw"], true);
    const filePath = await writeNotebook(notebook);

    const result = await NotebookProcessor.processNotebook(filePath, {
      includeCodeCells: true,
      includeMarkdownCells: true,
      includeOutputs: true,
      includeNonTextOutputs: true
    });

    expect(result.cellCount).toEqual({ code: 1, markdown: 1, raw: 1 });
    expect(result.outputCount.nonText).toBeGreaterThanOrEqual(1);
    expect(result.content).toContain("### Cell 1 [code]");
    expect(result.content).toContain("### Cell 2 [markdown]");
  });

  it("truncates non-text outputs when exceeding configured limit", async () => {
    const notebook = TestDataGenerator.generateNotebook(["code"], true);
    const filePath = await writeNotebook(notebook);

    const result = await NotebookProcessor.processNotebook(filePath, {
      includeCodeCells: true,
      includeOutputs: true,
      includeNonTextOutputs: true,
      nonTextOutputMaxBytes: 4
    });

    expect(result.outputCount.skipped).toBeGreaterThanOrEqual(1);
    expect(result.warnings.some((warning) => warning.includes("size limit"))).toBe(true);
  });

  it("honours configuration toggles for cell types", async () => {
    const notebook = TestDataGenerator.generateNotebook(["code", "markdown"], false);
    const filePath = await writeNotebook(notebook);

    const result = await NotebookProcessor.processNotebook(filePath, {
      includeCodeCells: false,
      includeMarkdownCells: true,
      includeOutputs: false
    });

    expect(result.cellCount.code).toBe(1);
    expect(result.content).toContain("[cell source omitted by configuration]");
    expect(result.content).toContain("### Cell 2 [markdown]");
  });

  it("renders base64 data URI for image outputs", async () => {
    const notebook = TestDataGenerator.generateNotebook(["code"], true);
    const filePath = await writeNotebook(notebook);

    const result = await NotebookProcessor.processNotebook(filePath, {
      includeCodeCells: true,
      includeOutputs: true,
      includeNonTextOutputs: true,
      nonTextOutputMaxBytes: 1024 * 1024
    });

    expect(result.content).toContain("data:image/png;base64");
  });

  it("handles malformed notebook JSON gracefully", async () => {
    await withTempWorkspace({}, async (root) => {
      setWorkspaceFolder(root);
      const filePath = path.join(root, "broken.ipynb");
      await fs.writeFile(filePath, "{invalid", "utf8");

      const result = await NotebookProcessor.processNotebook(filePath, {
        includeOutputs: false
      });

      expect(result.content).toContain("[unable to parse notebook]");
      expect(result.warnings.length).toBeGreaterThan(0);
    });
  });

  it("limits notebook size and reports warnings for large files", async () => {
    const largeOutput = new Array(1500).fill("line\n").join("");
    const notebook = {
      cells: [
        {
          cell_type: "code",
          source: ["print('big')\n"],
          outputs: [
            {
              output_type: "stream",
              name: "stdout",
              text: [largeOutput]
            }
          ]
        }
      ],
      metadata: {},
      nbformat: 4
    };
    const filePath = await writeNotebook(notebook);

    const result = await NotebookProcessor.processNotebook(filePath, {
      includeCodeCells: true,
      includeOutputs: true
    });

    expect(result.content.length).toBeGreaterThan(0);
    expect(result.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/Notebook outputs consumed/i)]));
  });
});