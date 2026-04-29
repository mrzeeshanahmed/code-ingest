import { describe, expect, jest, test } from "@jest/globals";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  CodeIngestTreeProvider,
  type TreeSelectionChange,
  type TreeProgressEvent
} from "../../providers/treeDataProvider";
import { SelectionManager } from "../../providers/selectionManager";
import { ExpandState } from "../../providers/expandState";
import {
  FileScanner,
  type DirectoryScanResult,
  type FileNode,
  type DirectoryScanOptions
} from "../../services/fileScanner";
import type { GitignoreService } from "../../services/gitignoreService";

const flushPromises = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

interface MockScannerOptions {
  readonly yieldDelay?: boolean;
}

type ScanResponses = Record<string, Record<number, DirectoryScanResult | Error>>;

class MockFileScanner extends FileScanner {
  private readonly responses: ScanResponses;
  private readonly yieldDelay: boolean;

  constructor(workspaceUri: vscode.Uri, responses: ScanResponses, options: MockScannerOptions = {}) {
    super(workspaceUri);
    this.responses = responses;
    this.yieldDelay = options.yieldDelay ?? true;
  }

  async scanDirectoryShallow(uri: vscode.Uri, options: DirectoryScanOptions = {}): Promise<DirectoryScanResult> {
    const key = uri.toString();
    const offset = options.offset ?? 0;
    const entry = this.responses[key]?.[offset];
    if (!entry) {
      throw new Error(`Missing mock scan result for ${key} at offset ${offset}`);
    }
    if (this.yieldDelay) {
      await Promise.resolve();
    }
    if (entry instanceof Error) {
      throw entry;
    }
    return entry;
  }

  async scan(): Promise<FileNode[]> {
    return [];
  }
}

function makeDirectory(uri: vscode.Uri, name: string, childCount: number, relPath: string): FileNode {
  return {
    uri: uri.toString(),
    name,
    type: "directory",
    childCount,
    relPath
  };
}

function makeFile(uri: vscode.Uri, name: string, relPath: string): FileNode {
  return {
    uri: uri.toString(),
    name,
    type: "file",
    relPath
  };
}

describe("CodeIngestTreeProvider", () => {
  const workspaceUri = vscode.Uri.file(path.resolve("/__workspace__"));
  const srcUri = vscode.Uri.joinPath(workspaceUri, "src");
  const readmeUri = vscode.Uri.joinPath(workspaceUri, "README.md");
  const indexUri = vscode.Uri.joinPath(srcUri, "index.ts");
  const utilsUri = vscode.Uri.joinPath(srcUri, "utils.ts");
  const failingUri = vscode.Uri.joinPath(workspaceUri, "forbidden");

  class InMemoryMemento implements vscode.Memento {
    private readonly store = new Map<string, unknown>();

    get<T>(key: string, defaultValue?: T): T {
      if (this.store.has(key)) {
        return this.store.get(key) as T;
      }
      return defaultValue as T;
    }

    update(key: string, value: unknown): Thenable<void> {
      if (value === undefined) {
        this.store.delete(key);
      } else {
        this.store.set(key, value);
      }
      return Promise.resolve();
    }

    keys(): readonly string[] {
      return [...this.store.keys()];
    }
  }

  function createProvider(responses: ScanResponses, options: MockScannerOptions = {}) {
    const scanner = new MockFileScanner(workspaceUri, responses, options);
    const selectionManager = new SelectionManager({
      workspaceRoot: workspaceUri.fsPath,
      storage: new InMemoryMemento(),
      fileScanner: scanner,
      validatePathExists: () => true
    });
    const expandState = new ExpandState();
    const gitignoreService = {
      isIgnored: jest.fn(async () => false)
    } as unknown as GitignoreService;
    const registerCommand = jest.fn(() => new vscode.Disposable(() => undefined));

    const provider = new CodeIngestTreeProvider(workspaceUri, scanner, selectionManager, expandState, registerCommand, {
      gitignoreService,
      includeGlobs: [],
      excludeGlobs: [],
      paginationSize: 1
    });

    return { provider, selectionManager };
  }

  test("shows scanning placeholder then resolves root nodes", async () => {
    const responses: ScanResponses = {
      [workspaceUri.toString()]: {
        0: {
          nodes: [
            makeDirectory(srcUri, "src", 2, "src"),
            makeFile(readmeUri, "README.md", "README.md")
          ],
          total: 2,
          hasMore: false,
          nextOffset: 2
        }
      },
      [srcUri.toString()]: {}
    };

    const { provider } = createProvider(responses, { yieldDelay: true });

    const firstPass = await provider.getChildren();
    expect(firstPass).toHaveLength(1);
    expect(firstPass[0]?.placeholder).toBe(true);

    await flushPromises();

    const loaded = await provider.getChildren();
    expect(loaded.map((node) => node.name)).toEqual(["src", "README.md"]);
  });

  test("expands directories with pagination", async () => {
    const responses: ScanResponses = {
      [workspaceUri.toString()]: {
        0: {
          nodes: [makeDirectory(srcUri, "src", 2, "src")],
          total: 1,
          hasMore: false,
          nextOffset: 1
        }
      },
      [srcUri.toString()]: {
        0: {
          nodes: [makeFile(indexUri, "index.ts", path.join("src", "index.ts"))],
          total: 2,
          hasMore: true,
          nextOffset: 1
        },
        1: {
          nodes: [makeFile(utilsUri, "utils.ts", path.join("src", "utils.ts"))],
          total: 2,
          hasMore: false,
          nextOffset: 2
        }
      }
    };

    const { provider } = createProvider(responses, { yieldDelay: true });

  await provider.getChildren();
  await flushPromises();
  const rootChildren = await provider.getChildren();
    const srcNode = rootChildren.find((node) => node.name === "src");
    expect(srcNode).toBeDefined();

    const initialFetch = await provider.getChildren(srcNode);
    expect(initialFetch[0]?.placeholder).toBe(true);

    await flushPromises();
  const loadingChildren = await provider.getChildren(srcNode!);
  expect(loadingChildren.some((node) => node.placeholder)).toBe(true);

  await flushPromises();
  const firstPage = await provider.getChildren(srcNode!);
  const names = firstPage.map((node) => node.name);
  expect(names.slice(0, 2)).toEqual(["index.ts", "Load more…"]);
  expect(firstPage.some((node) => node.placeholder)).toBe(true);

    await provider.expandDirectory(srcUri);
    await flushPromises();
    const finalChildren = await provider.getChildren(srcNode!);
    expect(finalChildren.map((node) => node.name)).toEqual(["index.ts", "utils.ts"]);
  });

  test("emits selection change events", async () => {
    const responses: ScanResponses = {
      [workspaceUri.toString()]: {
        0: {
          nodes: [makeFile(readmeUri, "README.md", "README.md")],
          total: 1,
          hasMore: false,
          nextOffset: 1
        }
      }
    };

    const { provider, selectionManager } = createProvider(responses);

  await provider.getChildren();
  await flushPromises();
  const rootChildren = await provider.getChildren();
    const fileNode = rootChildren[0];

    const events: TreeSelectionChange[] = [];
    provider.onSelectionChanged((event) => events.push(event));

  selectionManager.toggleFile(fileNode.uri);

    expect(events).toHaveLength(1);
    expect(events[0]?.selected).toEqual([fileNode.uri]);
  });

  test("handles scanner errors gracefully", async () => {
    const responses: ScanResponses = {
      [workspaceUri.toString()]: {
        0: {
          nodes: [makeDirectory(failingUri, "forbidden", 0, "forbidden")],
          total: 1,
          hasMore: false,
          nextOffset: 1
        }
      },
      [failingUri.toString()]: {
        0: new Error("permission denied")
      }
    };

    const { provider } = createProvider(responses);
    await flushPromises();
    const rootChildren = await provider.getChildren();
    const failingNode = rootChildren[0];

    const onError = jest.fn();
    provider.onError(onError);

  await provider.getChildren(failingNode);
  await provider.expandDirectory(failingUri);
  await flushPromises();
    const directoryCache = (provider as unknown as { directoryCache: Map<string, { children: FileNode[] }> }).directoryCache;
    const state = directoryCache.get(failingUri.toString());
    expect(state?.children).toBeDefined();
    expect(state?.children.length).toBe(1);
    expect(state?.children[0]?.error).toContain("permission denied");
    expect(onError).toHaveBeenCalled();
  });

  test("emits progress events during refresh", async () => {
    const responses: ScanResponses = {
      [workspaceUri.toString()]: {
        0: {
          nodes: [makeFile(readmeUri, "README.md", "README.md")],
          total: 1,
          hasMore: false,
          nextOffset: 1
        }
      }
    };

    const { provider } = createProvider(responses, { yieldDelay: true });

    const progressEvents: TreeProgressEvent[] = [];
    provider.onProgress((event) => progressEvents.push(event));

    await provider.refreshTree();
    await flushPromises();

    expect(progressEvents.length).toBeGreaterThan(0);
    expect(progressEvents[0]?.uri.toString()).toBe(workspaceUri.toString());
  });
});