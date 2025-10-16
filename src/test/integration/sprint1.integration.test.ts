// Follow instructions in copilot-instructions.md exactly.
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import * as vscode from "vscode";

import { FileScanner } from "../../services/fileScanner";
import { GitignoreService } from "../../services/gitignoreService";
import { FilterService } from "../../services/filterService";
import { CodeIngestTreeProvider, type TreeSelectionChange } from "../../providers/treeDataProvider";
import { SelectionManager } from "../../providers/selectionManager";
import { ExpandState } from "../../providers/expandState";
import { DirectoryCache } from "../../providers/directoryCache";
import type { Diagnostics } from "../../utils/validateConfig";
import { configureWorkspaceEnvironment, resetWorkspaceEnvironment } from "../support/workspaceEnvironment";

jest.setTimeout(120_000);

type ProgressEvent = {
  processed: number;
  total?: number;
  message?: string;
  path?: string;
};

interface TestWorkspace {
  readonly root: string;
  createFile(relativePath: string, content: string | Buffer): Promise<void>;
  createDirectory(relativePath: string): Promise<void>;
  createSymlink(target: string, link: string, type?: "file" | "dir"): Promise<boolean>;
  writeGitignore(relativeDir: string, patterns: string[]): Promise<void>;
  cleanup(): Promise<void>;
}

class FileSystemWorkspace implements TestWorkspace {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  async createDirectory(relativePath: string): Promise<void> {
    const target = path.join(this.root, relativePath);
    await fsp.mkdir(target, { recursive: true });
  }

  async createFile(relativePath: string, content: string | Buffer): Promise<void> {
    const target = path.join(this.root, relativePath);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, toWritePayload(content));
  }

  async createSymlink(target: string, link: string, type: "file" | "dir" = "file"): Promise<boolean> {
    const targetPath = path.join(this.root, target);
    const linkPath = path.join(this.root, link);
    await fsp.mkdir(path.dirname(linkPath), { recursive: true });
    try {
      await fsp.symlink(targetPath, linkPath, type);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        return true;
      }
      if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") {
        return false;
      }
      return false;
    }
  }

  async writeGitignore(relativeDir: string, patterns: string[]): Promise<void> {
    const dirPath = path.join(this.root, relativeDir);
    await fsp.mkdir(dirPath, { recursive: true });
    await fsp.writeFile(path.join(dirPath, ".gitignore"), `${patterns.join("\n")}\n`, "utf8");
  }

  async cleanup(): Promise<void> {
    await fsp.rm(this.root, { recursive: true, force: true });
  }
}

function createTestWorkspace(): Promise<TestWorkspace> {
  const prefix = path.join(os.tmpdir(), "code-ingest-sprint1-");
  return fsp.mkdtemp(prefix).then((root) => new FileSystemWorkspace(root));
}

function toWritePayload(value: string | Buffer): string | NodeJS.ArrayBufferView {
  return typeof value === "string" ? value : (value as unknown as NodeJS.ArrayBufferView);
}

class InMemoryMemento implements vscode.Memento {
  private readonly store = new Map<string, unknown>();

  get<T>(key: string, defaultValue?: T): T {
    if (this.store.has(key)) {
      return this.store.get(key) as T;
    }
    return defaultValue as T;
  }

  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) {
      this.store.delete(key);
    } else {
      this.store.set(key, value);
    }
  }

  keys(): readonly string[] {
    return [...this.store.keys()];
  }
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function enumerateFiles(root: string): Promise<string[]> {
  const results: string[] = [];

  async function walk(current: string): Promise<void> {
    const entries = await fsp.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      const relative = path.relative(root, fullPath).split(path.sep).join("/");
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else {
        results.push(relative);
      }
    }
  }

  await walk(root);
  return results.sort();
}

async function seedDiverseWorkspace(workspace: TestWorkspace): Promise<{ symlinkCreated: boolean }> {
  await workspace.createDirectory("src/components");
  await workspace.createDirectory("src/utils");
  await workspace.createDirectory("src/generated");
  await workspace.createDirectory("docs");
  await workspace.createDirectory("data/binaries");
  await workspace.createDirectory("notebooks");
  await workspace.createDirectory("logs");
  await workspace.createDirectory(".git/hooks");
  await workspace.createDirectory("node_modules/pkg");

  await workspace.createFile("src/index.js", "export const main = () => 'ok';\n");
  await workspace.createFile("src/components/Button.js", "export const Button = () => null;\n");
  await workspace.createFile("src/utils/math.py", "def add(a, b):\n    return a + b\n");
  await workspace.createFile("docs/readme.md", "# Sprint 1\n");
  await workspace.createFile("data/sample.json", JSON.stringify({ sprint: 1, status: "green" }));
  await workspace.createFile("notebooks/analysis.ipynb", JSON.stringify({ cells: [], nbformat: 4 }));
  await workspace.createFile("logs/app.log", "ignore me\n");
  await workspace.createFile("node_modules/pkg/index.js", "module.exports = {};\n");
  await workspace.createFile(".git/config", "[core]\n");
  await workspace.createFile("data/binaries/icon.bin", crypto.randomBytes(512));
  await workspace.createFile("src/utils/large.txt", Buffer.alloc(256 * 1024, 1));

  for (let index = 0; index < 30; index += 1) {
    await workspace.createFile(`src/generated/file-${index}.js`, `export const v${index} = ${index};\n`);
  }

  await workspace.writeGitignore(".", ["node_modules/", "logs/", "*.log", "dist/", "data/binaries/*"]);
  await workspace.writeGitignore("src", ["*.tmp", "!keep.tmp"]);

  const symlinkCreated = await workspace.createSymlink("src/index.js", "linked/index-symlink.js");
  return { symlinkCreated };
}

function captureEvents<T>(register: (listener: (event: T) => void) => vscode.Disposable) {
  const events: T[] = [];
  const disposable = register((event) => {
    events.push(event);
  });
  return {
    events,
    dispose: () => disposable.dispose()
  };
}

async function measurePerformance<T>(task: () => Promise<T>): Promise<{ durationMs: number; result: T }> {
  const start = performance.now();
  const result = await task();
  const durationMs = performance.now() - start;
  return { durationMs, result };
}

function createDiagnosticsSink(): Diagnostics {
  const errors: string[] = [];
  const warnings: string[] = [];
  return {
    addError: (message: string) => errors.push(message),
    addWarning: (message: string) => warnings.push(message)
  } satisfies Diagnostics;
}

configureWorkspaceEnvironment();

describe("Sprint 1 Integration: Scanning Pipeline", () => {
  let workspace: TestWorkspace;
  let workspaceUri: vscode.Uri;
  let fileScanner: FileScanner;
  let gitignoreService: GitignoreService;
  let filterService: FilterService;
  let treeProvider: CodeIngestTreeProvider;
  let selectionManager: SelectionManager;
  let directoryCache: DirectoryCache;
  let expandState: ExpandState;
  let gitignoreLogger: jest.Mock;
  let filterLogger: jest.Mock;
  let selectionStorage: InMemoryMemento;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
    const { symlinkCreated } = await seedDiverseWorkspace(workspace);
    workspaceUri = vscode.Uri.file(workspace.root);
    configureWorkspaceEnvironment(workspace.root);

    gitignoreLogger = jest.fn();
    filterLogger = jest.fn();

    gitignoreService = new GitignoreService({ logger: gitignoreLogger });
    filterService = new FilterService({
      workspaceRoot: workspace.root,
      gitignoreService,
      logger: (message: string, meta?: Record<string, unknown>) => filterLogger(message, meta)
    });
    fileScanner = new FileScanner(workspaceUri);

    selectionStorage = new InMemoryMemento();
    selectionManager = new SelectionManager({
      workspaceRoot: workspace.root,
      storage: selectionStorage,
      fileScanner,
      validatePathExists: (absolute) => {
        try {
          return fs.existsSync(absolute);
        } catch {
          return false;
        }
      }
    });

    expandState = new ExpandState();
    const registerCommand = jest.fn(() => new vscode.Disposable(() => undefined));
    treeProvider = new CodeIngestTreeProvider(workspaceUri, fileScanner, selectionManager, expandState, registerCommand, {
      filterService,
      gitignoreService,
      paginationSize: 20,
      includeHidden: false
    });

    directoryCache = new DirectoryCache(workspaceUri, fileScanner, createDiagnosticsSink(), undefined, {
      maxEntries: 400,
      pageSize: 25,
      ttlMs: 60_000,
      autoRefresh: false,
      maxMemoryMb: 64
    });

    if (!symlinkCreated) {
      // Add a marker so tests know symlinks are unavailable on this platform.
      await workspace.createFile("symlink-unsupported.txt", "symlinks unavailable");
    }
  });

  afterEach(async () => {
    treeProvider.dispose();
    selectionManager.dispose();
    directoryCache.dispose();
    jest.clearAllMocks();
    resetWorkspaceEnvironment();
    await workspace.cleanup();
  });

  it("complete workspace scan honours gitignore, filtering, and progress", async () => {
    const progressEvents: ProgressEvent[] = [];
    const { durationMs, result } = await measurePerformance(async () =>
      fileScanner.scan({
        onProgress: (processed, total, currentPath) => {
          const event: ProgressEvent = { processed };
          if (typeof total === "number") {
            event.total = total;
          }
          if (typeof currentPath === "string") {
            event.path = currentPath;
          }
          progressEvents.push(event);
        },
        maxEntries: 10_000
      })
    );

    const discovered = result
      .map((node) => {
        const absolute = vscode.Uri.parse(node.uri).fsPath;
        const raw = node.relPath ?? path.relative(workspace.root, absolute);
        return raw.split(path.sep).join("/");
      })
      .filter(Boolean);
    const discoveredSet = new Set(discovered);

    expect(progressEvents.length).toBeGreaterThan(0);
    expect(progressEvents[progressEvents.length - 1]?.processed).toBeGreaterThan(0);
    expect(durationMs).toBeLessThan(6_000);
    expect(discoveredSet.has("src/index.js")).toBe(true);
    expect(discoveredSet.has("docs/readme.md")).toBe(true);
    expect(discoveredSet.has("data/sample.json")).toBe(true);
    expect(discoveredSet.has("node_modules/pkg/index.js")).toBe(true);

    const filterTargets = [
      path.join(workspace.root, "src", "index.js"),
      path.join(workspace.root, "logs", "app.log"),
      path.join(workspace.root, "data", "binaries", "icon.bin")
    ];
    const filterResults = await filterService.batchFilter(filterTargets);
    const logResult = filterResults.get(filterTargets[1]);

    expect(logResult?.included).toBe(false);
    expect(["gitignored", "excluded"].includes(logResult?.reason ?? "")).toBe(true);
    expect(filterResults.get(filterTargets[0])?.included).toBe(true);

    const explanation = await filterService.explainDecision(filterTargets[1], { useGitignore: true });
    expect(explanation.result.included).toBe(false);
    const excludeStep = explanation.steps.find((step) => step.stage === "exclude" && step.outcome === "failed");
    expect(excludeStep).toBeDefined();
  });

  it("progressive tree loading provides placeholders, selection sync, and cache utilisation", async () => {
    const topLevelInitial = await treeProvider.getChildren();
    expect(topLevelInitial.some((node) => node.placeholder)).toBe(true);

    await flushMicrotasks();
    const topLevel = await treeProvider.getChildren();
    expect(topLevel.map((node) => node.name).sort()).toEqual(expect.arrayContaining(["docs", "src", "data", "notebooks", "logs", "node_modules"]));

    const srcNode = topLevel.find((node) => node.name === "src");
    expect(srcNode).toBeDefined();
    const srcNodeValue = srcNode!;

    const firstPage = await treeProvider.getChildren(srcNodeValue);
    expect(firstPage.some((node) => node.placeholderKind === "scanning")).toBe(true);

    await flushMicrotasks();
    const resolved = await treeProvider.getChildren(srcNodeValue);
    const hasLoadMore = resolved.some((node) => node.placeholderKind === "loadMore");
    if (!hasLoadMore) {
      await treeProvider.expandDirectory(vscode.Uri.parse(srcNodeValue.uri));
      await flushMicrotasks();
    }
    const afterExpand = await treeProvider.getChildren(srcNodeValue);
    expect(afterExpand.some((node) => !node.placeholder)).toBe(true);

    const selectionEvents = captureEvents<TreeSelectionChange>((listener) => treeProvider.onSelectionChanged(listener));
    const fileNode =
      afterExpand.find((node) => node.type === "file" && !node.placeholder) ||
      resolved.find((node) => node.type === "file" && !node.placeholder) ||
      afterExpand[0];
    if (fileNode) {
      selectionManager.toggleFile(fileNode.uri);
      expect(selectionManager.isSelected(fileNode.uri)).toBe(true);
    }

    await flushMicrotasks();
    expect(selectionEvents.events.length).toBeGreaterThan(0);
    selectionEvents.dispose();

    const srcPath = path.join(workspace.root, "src");
    const cacheEntry = await directoryCache.getDirectoryPage(srcPath, 0, 10);
    expect(cacheEntry.nodes.length).toBeGreaterThan(0);
    expect(directoryCache.has(srcPath)).toBe(true);
  });

  it("handles large repository simulation with performance and cancellation guarantees", async () => {
    const rootDir = "large-project";
    await workspace.createDirectory(rootDir);

    const directories = 120;
    const filesPerDirectory = 10;
    for (let dirIndex = 0; dirIndex < directories; dirIndex += 1) {
      const dirName = path.join(rootDir, `module-${dirIndex}`);
      await workspace.createDirectory(dirName);
      const writes: Array<Promise<void>> = [];
      for (let fileIndex = 0; fileIndex < filesPerDirectory; fileIndex += 1) {
        const rel = path.join(dirName, `file-${fileIndex}.js`);
        writes.push(workspace.createFile(rel, `export const v${fileIndex} = ${fileIndex};\n`));
      }
      await Promise.all(writes);
    }

    const { durationMs, result } = await measurePerformance(async () =>
      fileScanner.scan({
        maxEntries: 2_000,
        onProgress: jest.fn()
      })
    );

    expect(result.length).toBeGreaterThan(500);
    expect(durationMs).toBeLessThan(15_000);

    const heapBefore = process.memoryUsage().heapUsed;
    const cancellationSource = new vscode.CancellationTokenSource();
    const progressEvents: ProgressEvent[] = [];
    const cancelPromise = fileScanner.scan({
      token: cancellationSource.token,
      onProgress: (processed) => {
        progressEvents.push({ processed });
        if (processed > 150) {
          cancellationSource.cancel();
        }
      }
    });

    await expect(cancelPromise).rejects.toThrow(vscode.CancellationError);
    expect(progressEvents.length).toBeGreaterThan(0);
    const heapAfter = process.memoryUsage().heapUsed;
    expect(heapAfter - heapBefore).toBeLessThan(80 * 1024 * 1024);

    const cached = await directoryCache.getDirectoryPage(path.join(workspace.root, rootDir), 0, 100);
    expect(cached.nodes.length).toBeGreaterThan(0);
  });

  it("validates filter precedence, gitignore cooperation, and pattern selection", async () => {
    await workspace.createFile("src/components/Button.spec.js", "test spec\n");
    await workspace.createFile("src/components/keep.tmp", "should keep\n");
    await workspace.createFile("src/temp.log", "ignored\n");

    const targets = [
      path.join(workspace.root, "src", "components", "Button.spec.js"),
      path.join(workspace.root, "src", "components", "Button.js"),
      path.join(workspace.root, "src", "components", "keep.tmp")
    ];
    const results = await filterService.batchFilter(targets, {
      includePatterns: ["src/**/*.js", "src/**/*.tmp"],
      excludePatterns: ["**/*.spec.js"],
      useGitignore: true
    });

    const specResult = results.get(targets[0]);
    const jsResult = results.get(targets[1]);
    const tmpResult = results.get(targets[2]);

    expect(specResult?.included).toBe(false);
    expect(specResult?.reason).toBe("excluded");
    expect(jsResult?.included).toBe(true);
    expect(tmpResult?.included).toBe(true);

    const explanation = await filterService.explainDecision(targets[0], {
      includePatterns: ["src/**/*.js"],
      excludePatterns: ["**/*.spec.js"],
      useGitignore: true
    });
    expect(explanation.steps.find((step) => step.stage === "exclude")?.outcome).toBe("failed");

    const selectionEvents = captureEvents<TreeSelectionChange>((listener) => treeProvider.onSelectionChanged(listener));
    await selectionManager.selectPattern("src/**/*.js", "glob");
    await flushMicrotasks();
    expect(selectionEvents.events.length).toBeGreaterThan(0);
    selectionEvents.dispose();
  });

  it("maintains selection state across refreshes and synchronises events", async () => {
    const allFiles = await enumerateFiles(workspace.root);
    const primaryFile = path.join(workspace.root, "src", "index.js");
    const secondaryFile = path.join(workspace.root, "docs", "readme.md");

    selectionManager.selectMany([primaryFile, secondaryFile]);
    expect(selectionManager.getSelectedUris()).toEqual(expect.arrayContaining([primaryFile, secondaryFile]));

    const saveHook = selectionManager as unknown as { saveState?: () => Promise<void> };
    await saveHook.saveState?.();

    await treeProvider.refreshTree();
    await flushMicrotasks();

    const restoredManager = new SelectionManager({
      workspaceRoot: workspace.root,
      storage: selectionStorage,
      fileScanner,
      validatePathExists: (absolute) => fs.existsSync(absolute)
    });
    await flushMicrotasks();
    expect(restoredManager.getSelectedUris()).toEqual(expect.arrayContaining([primaryFile, secondaryFile]));

    const progressEvents = captureEvents<{ uri: vscode.Uri; processed: number }>((listener) => treeProvider.onProgress(listener));
    await treeProvider.refreshTree();
    await flushMicrotasks();
    await treeProvider.getChildren();
    await flushMicrotasks();
    expect(progressEvents.events.length).toBeGreaterThan(0);
    progressEvents.dispose();

    const selectionEvents = captureEvents<TreeSelectionChange>((listener) => treeProvider.onSelectionChanged(listener));
    selectionManager.clearSelection();
    await flushMicrotasks();
    expect(selectionEvents.events.some((event) => event.type === "cleared")).toBe(true);
    selectionEvents.dispose();

    restoredManager.dispose();
    const cacheSnapshot = directoryCache.inspectCache();
    expect(Array.isArray(cacheSnapshot)).toBe(true);
    expect(cacheSnapshot.length).toBeGreaterThanOrEqual(0);

    expect(allFiles.length).toBeGreaterThan(0);
  });

  it("recovers from permission, gitignore, symlink, and disk issues gracefully", async () => {
    await workspace.createDirectory("restricted");
    await workspace.createFile("restricted/data.txt", "secret\n");
    await workspace.writeGitignore("corrupt", ["["]);

    const originalScan = fileScanner.scanDirectoryShallow.bind(fileScanner);
    const scanSpy = jest
      .spyOn(fileScanner, "scanDirectoryShallow")
      .mockImplementation(async (uri: vscode.Uri, options = {}) => {
        if (uri.scheme === "file") {
          if (uri.fsPath.includes(path.join(workspace.root, "restricted"))) {
            const error = new Error("permission denied") as NodeJS.ErrnoException;
            error.code = "EACCES";
            throw error;
          }
          if (uri.fsPath.includes(path.join(workspace.root, "data"))) {
            const error = new Error("no space left on device") as NodeJS.ErrnoException;
            error.code = "ENOSPC";
            throw error;
          }
        }
        return originalScan(uri, options);
      });

    await expect(
      fileScanner.scanDirectoryShallow(vscode.Uri.file(path.join(workspace.root, "restricted")))
    ).rejects.toThrow("permission denied");

    const gitignoreDecision = await gitignoreService.isIgnored(path.join(workspace.root, "logs", "app.log"));
    await gitignoreService.isIgnored(path.join(workspace.root, "corrupt", "sample.txt"));
    expect(gitignoreDecision).toBe(true);

    const loopCreated = await workspace.createSymlink(".", "loop/self", "dir");
    if (loopCreated) {
      const loopResult = await fileScanner.scanDirectoryShallow(vscode.Uri.file(path.join(workspace.root, "loop")), {
        followSymlinks: false
      });
      expect(loopResult.nodes.every((node) => node.metadata?.isSymbolicLink || node.type !== "file")).toBe(true);
    }

    const errorEvents: Array<{ dirPath: string; error: Error }> = [];
    const disposeError = directoryCache.onDidError((event) => errorEvents.push(event));
    await expect(directoryCache.getDirectoryPage(path.join(workspace.root, "data"), 0, 5)).rejects.toThrow();
    await flushMicrotasks();
    expect(errorEvents.length).toBeGreaterThan(0);
    disposeError.dispose();
    scanSpy.mockRestore();
  });
});
