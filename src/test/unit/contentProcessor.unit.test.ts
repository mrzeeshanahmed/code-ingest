import { Buffer } from "node:buffer";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, beforeAll, beforeEach, describe, expect, it, jest } from "@jest/globals";
import * as vscode from "vscode";

import { ContentProcessor } from "../../services/contentProcessor";
import { NotebookProcessor } from "../../services/notebookProcessor";
import { TestDataGenerator } from "./utils/mocks";
import { setWorkspaceFolder, withTempWorkspace } from "./testUtils";

type VSCodeTestDouble = typeof vscode & {
  __reset(): void;
  workspace: typeof vscode.workspace & {
    getConfiguration: jest.Mock;
  };
};

describe("ContentProcessor", () => {
  const vsMock = vscode as unknown as VSCodeTestDouble;

  beforeAll(() => {
    jest.spyOn(NotebookProcessor, "buildNotebookContent").mockImplementation((raw: string) => raw);
  });

  beforeEach(() => {
    vsMock.__reset();
    vsMock.workspace.getConfiguration.mockReturnValue({
      get: jest.fn((key: string, defaultValue?: unknown) => {
        switch (key) {
          case "binaryFilePolicy":
            return "placeholder";
          case "maxFileSize":
            return 1024 * 1024;
          case "streamingThreshold":
            return 128 * 1024;
          case "detectLanguage":
            return true;
          case "encoding":
            return "utf8";
          case "processingTimeout":
            return 5000;
          case "processingConcurrency":
            return 4;
          case "binaryWhitelist":
          case "binaryBlacklist":
            return [];
          default:
            return defaultValue;
        }
      })
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("detects binary files using signature heuristics", async () => {
    await withTempWorkspace({
      "image.png": TestDataGenerator.generateBinaryContent("png"),
      "script.ts": "export const value = 1;\n"
    }, async (root) => {
      setWorkspaceFolder(root);
      const processor = new ContentProcessor();

      const imagePath = path.join(root, "image.png");
      const isBinary = await processor.detectBinaryFile(imagePath);
      expect(isBinary).toBe(true);

      const textPath = path.join(root, "script.ts");
      const isTextBinary = await processor.detectBinaryFile(textPath);
      expect(isTextBinary).toBe(false);
    });
  });

  it("switches to streaming mode for large files", async () => {
    await withTempWorkspace({}, async (root) => {
      setWorkspaceFolder(root);
      const largeFile = path.join(root, "large.js");
      const payload = TestDataGenerator.generateCodeFile("javascript", 256 * 1024);
      await fs.writeFile(largeFile, payload, "utf8");

      const processor = new ContentProcessor();
      const streamSpy = jest.spyOn(processor, "processFileStream");

      const result = await processor.processFile(largeFile, {
        streamingThreshold: 64 * 1024,
        maxFileSize: 512 * 1024,
        onProgress: jest.fn()
      });

      expect(streamSpy).toHaveBeenCalled();
      expect(result.isTruncated).toBe(false);
      expect(result.metadata?.lines).toBeGreaterThan(0);
      expect(result.content.startsWith("// language")).toBe(true);
    });
  });

  it("detects language using extension, content, and overrides", async () => {
    await withTempWorkspace({}, async (root) => {
      setWorkspaceFolder(root);
      const scriptPath = path.join(root, "script.py");
      await fs.writeFile(scriptPath, "def main():\n    return 42\n", "utf8");

      const processor = new ContentProcessor();
      const detected = await processor.detectLanguage(scriptPath, "def foo():\n    pass\n");
      expect(detected).toBe("python");

      const htmlPath = path.join(root, "page.txt");
      await fs.writeFile(htmlPath, "<html><body>Hello</body></html>", "utf8");
      const htmlLanguage = await processor.detectLanguage(htmlPath, "<html><body></body></html>");
      expect(htmlLanguage).toBe("html");

      const overridden = await processor.processFile(htmlPath, { detectLanguage: false, maxFileSize: 1024 });
      expect(overridden.language).toBe("plaintext");
    });
  });

  it("enforces binary processing policies and whitelists", async () => {
    await withTempWorkspace({}, async (root) => {
      setWorkspaceFolder(root);
      const binaryPath = path.join(root, "archive.zip");
      await fs.writeFile(binaryPath, TestDataGenerator.generateBinaryContent("zip"));

      const processor = new ContentProcessor();
      const placeholder = await processor.processFile(binaryPath, {
        binaryFilePolicy: "placeholder"
      });
      expect(placeholder.encoding).toBe("binary-placeholder");
      expect(placeholder.content).toContain("[binary file]");

      const base64 = await processor.processFile(binaryPath, {
        binaryFilePolicy: "base64"
      });
      expect(base64.encoding).toBe("base64");
      expect(Buffer.from(base64.content, "base64").length).toBeGreaterThan(0);

      const whitelistResult = await processor.processFile(binaryPath, {
        binaryFilePolicy: "skip",
        whitelistExtensions: [".zip"]
      });
      expect(whitelistResult.encoding).toBe("utf8");
      expect(whitelistResult.isTruncated).toBe(false);
    });
  });

  it("handles filesystem errors gracefully", async () => {
    const processor = new ContentProcessor();
    await expect(processor.processFile(os.tmpdir())).rejects.toThrow(/Target is not a file/i);
  });

  it("processes notebooks by delegating to the notebook processor", async () => {
    const notebook = TestDataGenerator.generateNotebook(["code"], true);
    const tempFile = await fs.mkdtemp(path.join(os.tmpdir(), "notebook-"));
    const notebookPath = path.join(tempFile, "example.ipynb");
    await fs.writeFile(notebookPath, JSON.stringify(notebook), "utf8");

    setWorkspaceFolder(tempFile);
    const processor = new ContentProcessor();
    const result = await processor.processFile(notebookPath, { binaryFilePolicy: "placeholder" });
    expect(result.language).toBe("json");
    expect(result.content).toContain("### Cell 1");

    await fs.rm(tempFile, { recursive: true, force: true });
  });

  it("processes a large file within acceptable performance bounds", async () => {
    await withTempWorkspace({}, async (root) => {
      setWorkspaceFolder(root);
      const filePath = path.join(root, "large.ts");
      const content = TestDataGenerator.generateCodeFile("typescript", 512 * 1024);
      await fs.writeFile(filePath, content, "utf8");

      const processor = new ContentProcessor({ now: () => performance.now() });
      const startTime = Date.now();
      const startMemory = process.memoryUsage().heapUsed;

      const result = await processor.processFile(filePath, {
        maxFileSize: 1024 * 1024,
        streamingThreshold: 32 * 1024
      });

      const endTime = Date.now();
      const endMemory = process.memoryUsage().heapUsed;

      expect(result.content.length).toBeGreaterThan(0);
      expect(endTime - startTime).toBeLessThan(5000);
      expect(endMemory - startMemory).toBeLessThan(50 * 1024 * 1024);
    });
  });
});