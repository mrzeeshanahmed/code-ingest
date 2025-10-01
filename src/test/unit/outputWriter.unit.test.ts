import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import type * as vscode from "vscode";

import { OutputWriter, type OutputTarget } from "../../services/outputWriter";
import { createCancellationTokenSource, setWorkspaceFolder } from "./testUtils";

type VsModule = typeof import("vscode");
type VsWindow = VsModule["window"];
type VsWorkspace = VsModule["workspace"];

describe("OutputWriter", () => {
  const largeText = "x".repeat(1_500_000); // > 1MB to trigger chunked writes
  const workspaceConfig: Record<string, unknown> = {
    defaultOutputTarget: "file",
    outputDirectory: "out",
    outputFilename: "digest-{timestamp}.{format}",
    createOutputDirectories: true
  };

  let editorInsertions: string[];
  let outputWriter: OutputWriter;
  let tempRoot: string;
  let mockDocument: jest.Mocked<vscode.TextDocument>;
  let mockEditor: jest.Mocked<vscode.TextEditor>;
  let mockWindow: jest.Mocked<VsWindow>;
  let mockWorkspace: jest.Mocked<VsWorkspace>;
  let mockClipboard: jest.Mocked<vscode.Clipboard>;
  let currentDocumentText = "";

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ow-tests-"));
    setWorkspaceFolder(tempRoot);

    currentDocumentText = "";
    editorInsertions = [];
    mockDocument = {
      getText: jest.fn(() => currentDocumentText),
      positionAt: jest.fn((offset: number) => ({ line: 0, character: offset } as vscode.Position)),
      uri: { path: "untitled:test" } as vscode.Uri,
      eol: 1,
      fileName: "untitled",
      isClosed: false,
      isDirty: false,
      isUntitled: true,
      languageId: "plaintext",
      lineAt: jest.fn(),
      lineCount: 0,
      offsetAt: jest.fn(),
      save: jest.fn(),
      validatePosition: jest.fn(),
      validateRange: jest.fn(),
      version: 0
    } as unknown as jest.Mocked<vscode.TextDocument>;

    mockEditor = {
      document: mockDocument,
      edit: jest.fn(async (cb: (editBuilder: vscode.TextEditorEdit) => void) => {
        const editBuilder: vscode.TextEditorEdit = {
          insert: jest.fn((_position: vscode.Position, text: string) => {
            editorInsertions.push(text);
            currentDocumentText += text;
          })
        } as unknown as vscode.TextEditorEdit;
        cb(editBuilder);
      })
    } as unknown as jest.Mocked<vscode.TextEditor>;

    mockWindow = {
      showInformationMessage: jest.fn(() => Promise.resolve(undefined)) as unknown as jest.MockedFunction<VsWindow["showInformationMessage"]>,
      showTextDocument: jest.fn(async () => mockEditor) as unknown as jest.MockedFunction<VsWindow["showTextDocument"]>
    } as unknown as jest.Mocked<VsWindow>;

    mockWorkspace = {
      getConfiguration: jest.fn(() => ({
        get: (key: string, fallback?: unknown) => (workspaceConfig[key] ?? fallback) as unknown
      })) as unknown as jest.MockedFunction<VsWorkspace["getConfiguration"]>,
      openTextDocument: jest.fn(async () => mockDocument) as unknown as jest.MockedFunction<VsWorkspace["openTextDocument"]>,
      workspaceFolders: [
        {
          uri: { fsPath: tempRoot } as vscode.Uri,
          index: 0,
          name: "workspace"
        }
      ]
    } as unknown as jest.Mocked<VsWorkspace>;

    mockClipboard = {
      readText: jest.fn(),
      writeText: jest.fn(() => Promise.resolve())
    } as unknown as jest.Mocked<vscode.Clipboard>;

    outputWriter = new OutputWriter({
      window: mockWindow,
      workspace: mockWorkspace,
      clipboard: mockClipboard
    });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("writes large content to editor using chunked edits", async () => {
    const progressEvents: number[] = [];

    const result = await outputWriter.writeOutput({
      target: { type: "editor", title: "Digest" },
      content: largeText,
      format: "markdown",
      progressCallback: (progress) => {
        progressEvents.push(progress.bytesWritten);
      }
    });

    expect(result.success).toBe(true);
    expect(editorInsertions.length).toBeGreaterThan(10);
    const chunkSizes = editorInsertions.map((text) => Buffer.byteLength(text, "utf8"));
    expect(Math.max(...chunkSizes)).toBeLessThanOrEqual(64 * 1024);
    expect(progressEvents.some((bytes) => bytes > 64 * 1024)).toBe(true);
  });

  it("creates directories when writing to file target using configuration defaults", async () => {
    const target: OutputTarget = { type: "file" };
    const progress = jest.fn();

    const result = await outputWriter.writeOutput({
      target,
      content: "file-content",
      format: "text",
      progressCallback: progress
    });

    expect(result.success).toBe(true);
    expect(result.uri?.fsPath).toBeDefined();
    const fileExists = await fs.stat(result.uri!.fsPath);
    expect(fileExists.isFile()).toBe(true);
    expect(progress).toHaveBeenCalled();
  });

  it("aborts when cancellation requested during file write", async () => {
    const cancellation = createCancellationTokenSource();
    cancellation.cancel();

    const result = await outputWriter.writeOutput({
      target: { type: "file", path: path.join(tempRoot, "cancelled.txt") },
      content: "cancelled",
      format: "text",
      cancellationToken: cancellation.token
    });

    expect(result.success).toBe(false);
    await expect(fs.access(path.join(tempRoot, "cancelled.txt"))).rejects.toThrow();
  });

  it("streams text to clipboard and reports completion", async () => {
    async function* generator() {
      yield "Hello";
      yield " ";
      yield "Clipboard";
    }

    const result = await outputWriter.writeStream({
      target: { type: "clipboard" },
      contentStream: generator(),
      format: "text"
    });

    expect(result.success).toBe(true);
  expect(mockClipboard.writeText).toHaveBeenCalledWith("Hello Clipboard");
  expect(mockWindow.showInformationMessage).toHaveBeenCalled();
  });

  it("resolves configured target paths and creates unique filenames", async () => {
    const first = outputWriter.resolveConfiguredTarget("markdown");
    const second = outputWriter.resolveConfiguredTarget("markdown");

  expect(first.type).toBe("file");
  expect(second.type).toBe("file");
  expect(first.path).toContain(path.join(tempRoot, "out"));
  expect(first.path?.endsWith(".markdown")).toBe(true);
  });

  it("formats helpful file system errors", async () => {
    const result = await outputWriter.writeOutput({
      target: { type: "file", path: path.join(tempRoot, "denied", "file.txt") },
      content: "",
      format: "text",
      createDirectories: false
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Directory does not exist/i);
  });

  it("writes stream to file incrementally", async () => {
    async function* chunks() {
      yield "chunk-";
      yield "a";
      yield "-chunk";
    }

    const filePath = path.join(tempRoot, "stream-output.txt");
    const result = await outputWriter.writeStream({
      target: { type: "file", path: filePath },
      contentStream: chunks(),
      format: "text",
      chunkSize: 8
    });

    expect(result.success).toBe(true);
    const content = await fs.readFile(filePath, "utf8");
    expect(content).toBe("chunk-a-chunk");
  });
});
