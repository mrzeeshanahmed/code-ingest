import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import { ContentProcessor } from "./contentProcessor";
import type { DigestConfig } from "../utils/validateConfig";
import { NotebookProcessor } from "./notebookProcessor";

jest.mock("./notebookProcessor", () => ({
  NotebookProcessor: {
    buildNotebookContent: jest.fn()
  }
}));

const tempFiles: string[] = [];

async function createTempFile(content: string | Uint8Array, extension = ".txt"): Promise<string> {
  const filePath = path.join(os.tmpdir(), `code-ingest-${Date.now()}-${Math.random().toString(16).slice(2)}${extension}`);
  await fs.writeFile(filePath, content);
  tempFiles.push(filePath);
  return filePath;
}

afterEach(async () => {
  jest.restoreAllMocks();

  await Promise.all(
    tempFiles.splice(0).map(async (filePath) => {
      await fs.rm(filePath, { force: true });
    })
  );
});

describe("ContentProcessor.getFileContent", () => {
  const baseConfig = {} as DigestConfig;

  it("normalizes line endings for text files", async () => {
    const filePath = await createTempFile("first\r\nsecond\r\n");

    const result = await ContentProcessor.getFileContent(filePath, baseConfig);

    expect(result).toBe("first\nsecond\n");
  });

  it("uses the notebook processor for .ipynb files", async () => {
    const rawNotebook = JSON.stringify({ cells: [] });
    const filePath = await createTempFile(rawNotebook, ".ipynb");
    const mockedNotebook = NotebookProcessor as jest.Mocked<typeof NotebookProcessor>;
    mockedNotebook.buildNotebookContent.mockReturnValue("converted");

    const config = { includeCodeCells: true } as DigestConfig;
    const result = await ContentProcessor.getFileContent(filePath, config);

    expect(mockedNotebook.buildNotebookContent).toHaveBeenCalledWith(rawNotebook, config);
    expect(result).toBe("converted");
  });

  it("returns null when the file cannot be read", async () => {
    const missingPath = path.join(os.tmpdir(), "does-not-exist.txt");
    const result = await ContentProcessor.getFileContent(missingPath, baseConfig);
    expect(result).toBeNull();
  });

  it("returns null for binary files when policy is skip", async () => {
    const filePath = await createTempFile(Uint8Array.from([0, 1, 2, 0, 3]));
    const result = await ContentProcessor.getFileContent(filePath, {
      binaryFilePolicy: "skip"
    } as DigestConfig);

    expect(result).toBeNull();
  });

  it("returns a placeholder for binary files when policy is placeholder", async () => {
    const filePath = await createTempFile(Uint8Array.from([0, 1, 2, 0, 3]));
    const result = await ContentProcessor.getFileContent(filePath, {
      binaryFilePolicy: "placeholder"
    } as DigestConfig);

    expect(result).toBe("[binary file] " + path.basename(filePath));
  });

  it("returns base64 for binary files when policy is base64", async () => {
    const bytes = Uint8Array.from([0, 1, 2, 0, 3]);
    const buffer = Buffer.from(bytes);
    const filePath = await createTempFile(bytes);

    const result = await ContentProcessor.getFileContent(filePath, {
      binaryFilePolicy: "base64"
    } as DigestConfig);

    expect(result).toBe(buffer.toString("base64"));
  });
});