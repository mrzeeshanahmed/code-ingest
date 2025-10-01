import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

import { ContentProcessor } from "../services/contentProcessor";
import { NotebookProcessor } from "../services/notebookProcessor";

jest.mock("../services/notebookProcessor", () => ({
  NotebookProcessor: {
    buildNotebookContent: jest.fn()
  }
}));

const tempFiles: string[] = [];

async function createTempFile(content: string | Uint8Array | Buffer, extension = ".txt"): Promise<string> {
  const filePath = path.join(os.tmpdir(), `code-ingest-${Date.now()}-${Math.random().toString(16).slice(2)}${extension}`);
  const payload = typeof content === "string" ? content : Uint8Array.from(content);
  await fs.writeFile(filePath, payload);
  tempFiles.push(filePath);
  return filePath;
}

function mockConfiguration(overrides: Record<string, unknown> = {}): void {
  const defaults: Record<string, unknown> = {
    binaryFilePolicy: "skip",
    maxFileSize: 5 * 1024 * 1024,
    streamingThreshold: 1 * 1024 * 1024,
    detectLanguage: true,
    encoding: "utf8",
    processingTimeout: 30_000,
    processingConcurrency: 4,
    binaryWhitelist: [],
    binaryBlacklist: []
  };
  const snapshot = { ...defaults, ...overrides };
  (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
    get: (key: string, fallback?: unknown) => (key in snapshot ? snapshot[key] : fallback),
    update: jest.fn()
  });
}

afterEach(async () => {
  jest.restoreAllMocks();
  await Promise.all(
    tempFiles.splice(0).map(async (filePath) => {
      await fs.rm(filePath, { force: true });
    })
  );
});

describe("ContentProcessor", () => {
  let processor: ContentProcessor;
  const mockedNotebook = NotebookProcessor as jest.Mocked<typeof NotebookProcessor>;

  beforeEach(() => {
    mockConfiguration();
    processor = new ContentProcessor();
    mockedNotebook.buildNotebookContent.mockReset();
  });

  it("normalizes text content and reports metadata", async () => {
    const filePath = await createTempFile("first\r\nsecond\r\n");

    const result = await processor.processFile(filePath);

    expect(result.content).toBe("first\nsecond\n");
    expect(result.encoding).toBe("utf8");
    expect(result.language).toBe("plaintext");
    expect(result.metadata?.lines).toBeGreaterThanOrEqual(2);
    expect(result.isTruncated).toBe(false);
  });

  it("uses notebook processor for ipynb files", async () => {
    const rawNotebook = JSON.stringify({ cells: [] });
    const filePath = await createTempFile(rawNotebook, ".ipynb");
    mockedNotebook.buildNotebookContent.mockReturnValue("converted");

    const result = await processor.processFile(filePath);

    expect(mockedNotebook.buildNotebookContent).toHaveBeenCalledWith(rawNotebook, expect.objectContaining({ binaryFilePolicy: "skip" }));
    expect(result.content).toBe("converted");
    expect(result.language).toBe("json");
  });

  it("skips binary files by default", async () => {
    const filePath = await createTempFile(Uint8Array.from([0, 1, 2, 0, 3]));

    const result = await processor.processFile(filePath);

    expect(result.content).toBe("");
    expect(result.encoding).toBe("binary-placeholder");
    expect(result.metadata?.reason).toBe("null-bytes");
  });

  it("produces placeholder output for binary files when requested", async () => {
    const filePath = await createTempFile(Uint8Array.from([0, 1, 2, 0, 3]));

    const result = await processor.processFile(filePath, { binaryFilePolicy: "placeholder" });

    expect(result.content).toBe(`[binary file] ${path.basename(filePath)}`);
    expect(result.encoding).toBe("binary-placeholder");
    expect(result.metadata?.reason).toBe("null-bytes");
  });

  it("base64 encodes binary content when configured", async () => {
    const bytes = Uint8Array.from([0, 1, 2, 0, 3]);
    const filePath = await createTempFile(bytes);

    const result = await processor.processFile(filePath, { binaryFilePolicy: "base64" });

    expect(result.encoding).toBe("base64");
    expect(result.content).toBe(Buffer.from(bytes).toString("base64"));
  });

  it("streams large files and respects max size", async () => {
    const largeContent = Buffer.alloc(2 * 1024 * 1024, 1);
    const filePath = await createTempFile(largeContent);

    const progressEvents: Array<{ bytesRead: number; done?: boolean }> = [];
    const result = await processor.processFile(filePath, {
      streamingThreshold: 64 * 1024,
      maxFileSize: 512 * 1024,
      onProgress: (e) => {
        if (typeof e.done === "boolean") {
          progressEvents.push({ bytesRead: e.bytesRead, done: e.done });
        } else {
          progressEvents.push({ bytesRead: e.bytesRead });
        }
      }
    });

    expect(result.isTruncated).toBe(true);
    expect(result.metadata?.truncatedBytes).toBe(largeContent.length - 512 * 1024);
    expect(progressEvents.length).toBeGreaterThan(0);
    expect(progressEvents.at(-1)?.done).toBe(true);
  });

  it("detects language using extension heuristics", async () => {
    const filePath = await createTempFile("const a = 1;\n", ".ts");

    const result = await processor.processFile(filePath, { detectLanguage: true });

    expect(result.language).toBe("typescript");
  });

  it("detects binary files via helper", async () => {
    const filePath = await createTempFile(Uint8Array.from([0, 0, 1, 2, 3]));

    const isBinary = await processor.detectBinaryFile(filePath);

    expect(isBinary).toBe(true);
  });

  it("processes multiple files concurrently", async () => {
    const fileA = await createTempFile("a\n", ".txt");
    const fileB = await createTempFile("console.log('hi');\n", ".js");

    const results = await processor.processFiles([fileA, fileB], { detectLanguage: true });

    expect(results).toHaveLength(2);
    expect(results.map((r) => r.language)).toEqual(expect.arrayContaining(["plaintext", "javascript"]));
  });
});