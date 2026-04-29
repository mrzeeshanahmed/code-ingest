import { describe, expect, it, beforeEach, afterEach } from "@jest/globals";
import * as path from "node:path";
import * as os from "node:os";
import { promises as fs } from "node:fs";
import * as vscode from "vscode";
import { FileScanner } from "../services/fileScanner";

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

async function writeFile(filePath: string, contents: string): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, contents, "utf8");
}

describe("FileScanner", () => {
  let tempDir: string;
  let workspaceUri: vscode.Uri;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "code-ingest-fs-"));
    workspaceUri = vscode.Uri.file(tempDir);

    await ensureDir(path.join(tempDir, "src"));
    await writeFile(path.join(tempDir, "src", "index.ts"), "export const value = 1;\n");
    await writeFile(path.join(tempDir, "README.md"), "# Hello\n");
    await writeFile(path.join(tempDir, ".hidden"), "secret\n");
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("scans directories shallowly with metadata and pagination", async () => {
    const scanner = new FileScanner(workspaceUri);
    const pageOne = await scanner.scanDirectoryShallow(workspaceUri, { limit: 2, includeHidden: false });
    expect(pageOne.hasMore).toBe(true);
    expect(pageOne.total).toBeGreaterThanOrEqual(3);
    expect(pageOne.nodes.length).toBeGreaterThan(0);

    const pageTwo = await scanner.scanDirectoryShallow(workspaceUri, {
      offset: pageOne.nextOffset,
      limit: 2,
      includeHidden: false
    });
    expect(pageTwo.nodes.length).toBeGreaterThanOrEqual(1);

    const combined = [...pageOne.nodes, ...pageTwo.nodes];
    const names = combined.map((node) => node.name);
    expect(names).toContain("src");
    expect(names).toContain("README.md");

    const readme = combined.find((node) => node.name === "README.md");
    expect(readme?.metadata?.size).toBeGreaterThan(0);
    expect(readme?.metadata?.languageId).toBe("markdown");

    const srcDir = combined.find((node) => node.name === "src");
    expect(srcDir?.type).toBe("directory");
    expect(typeof srcDir?.childCount === "number").toBe(true);
  });

  it("honors includeHidden option", async () => {
    const scanner = new FileScanner(workspaceUri);
    const hiddenExcluded = await scanner.scanDirectoryShallow(workspaceUri, { includeHidden: false });
    expect(hiddenExcluded.nodes.some((node) => node.name === ".hidden")).toBe(false);

    const hiddenIncluded = await scanner.scanDirectoryShallow(workspaceUri, { includeHidden: true });
    expect(hiddenIncluded.nodes.some((node) => node.name === ".hidden")).toBe(true);
  });

  it("respects maxEntries when scanning workspace", async () => {
    const scanner = new FileScanner(workspaceUri);
    const nodes = await scanner.scan({ maxEntries: 1 });
    expect(nodes.length).toBeLessThanOrEqual(1);
  });
});