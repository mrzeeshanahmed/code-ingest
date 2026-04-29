import { describe, expect, jest, test } from "@jest/globals";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  CodeIngestTreeProvider,
  type TreeErrorEvent,
  type TreeProgressEvent,
  type TreeSelectionChange
} from "../../providers/treeDataProvider";
import { ExpandState } from "../../providers/expandState";
import { SelectionManager } from "../../providers/selectionManager";
import {
  FileScanner,
  type DirectoryScanOptions,
  type DirectoryScanResult,
  type FileNode
} from "../../services/fileScanner";
import type { FilterOptions, FilterResult, FilterService } from "../../services/filterService";
import type { GitignoreService } from "../../services/gitignoreService";
import { captureEvents, setWorkspaceFolder, withTempWorkspace } from "./testUtils";

const waitForNextTick = () => new Promise<void>((resolve) => setImmediate(resolve));

type ScanResponses = Record<string, Record<number, DirectoryScanResult | Error>>;

interface MockScannerOptions {
  readonly yieldDelay?: boolean;
}

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
    const response = this.responses[key]?.[offset];
    if (!response) {
      throw new Error(`Missing mock scan result for ${key} at offset ${offset}`);
    }
    if (this.yieldDelay) {
      await Promise.resolve();
    }
    if (response instanceof Error) {
      throw response;
    }
    return response;
  }

  async scan(): Promise<FileNode[]> {
    return [];
  }
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

type BatchFilterFn = (paths: string[], options?: FilterOptions) => Promise<Map<string, FilterResult>>;

interface ProviderSetup {
  provider: CodeIngestTreeProvider;
  selectionManager: SelectionManager;
  batchFilterMock: jest.MockedFunction<BatchFilterFn>;
}

interface CreateProviderOptions {
  paginationSize?: number;
  yieldDelay?: boolean;
  filterDecisions?: Map<string, boolean>;
}

function createFilterServiceStub(decisions?: Map<string, boolean>) {
  const batchFilterMock = jest.fn(async (paths: string[]): Promise<Map<string, FilterResult>> => {
    const results = new Map<string, FilterResult>();
    for (const candidate of paths) {
      const included = decisions?.get(candidate) ?? true;
      results.set(candidate, included ? { included: true, reason: "included" } : { included: false, reason: "excluded", matchedPattern: "mock" });
    }
    return results;
  }) as jest.MockedFunction<BatchFilterFn>;

  const filterService = { batchFilter: batchFilterMock } as unknown as FilterService;
  return { filterService, batchFilterMock };
}

function makeDirectory(workspaceUri: vscode.Uri, name: string, childCount: number): FileNode {
  const uri = vscode.Uri.joinPath(workspaceUri, name);
  return {
    uri: uri.toString(),
    name,
    type: "directory",
    childCount,
    relPath: name
  };
}

function makeFile(workspaceUri: vscode.Uri, relativePath: string): FileNode {
  const uri = vscode.Uri.joinPath(workspaceUri, ...relativePath.split("/"));
  return {
    uri: uri.toString(),
    name: path.basename(uri.fsPath),
    type: "file",
    relPath: relativePath
  };
}

function createProvider(root: string, responses: ScanResponses, options: CreateProviderOptions = {}): ProviderSetup {
  const workspaceUri = vscode.Uri.file(root);
  const scanner = new MockFileScanner(workspaceUri, responses, { yieldDelay: options.yieldDelay ?? true });
  const { filterService, batchFilterMock } = createFilterServiceStub(options.filterDecisions);
  const gitignoreService = { isIgnored: jest.fn(async () => false) } as unknown as GitignoreService;
  const selectionManager = new SelectionManager({
    workspaceRoot: root,
    storage: new InMemoryMemento(),
    fileScanner: scanner,
    validatePathExists: () => true
  });
  const expandState = new ExpandState();
  const registerCommand = jest.fn(() => ({ dispose: jest.fn() }) as unknown as vscode.Disposable);

  const provider = new CodeIngestTreeProvider(workspaceUri, scanner, selectionManager, expandState, registerCommand, {
    paginationSize: options.paginationSize ?? 200,
    filterService,
    gitignoreService
  });

  return { provider, selectionManager, batchFilterMock };
}

describe("CodeIngestTreeProvider (unit)", () => {
  test("produces tree items with selection metadata", async () => {
    await withTempWorkspace({}, async (root) => {
      setWorkspaceFolder(root);
      const workspaceUri = vscode.Uri.file(root);
      const responses: ScanResponses = {
        [workspaceUri.toString()]: {
          0: {
            nodes: [makeDirectory(workspaceUri, "src", 0), makeFile(workspaceUri, "README.md")],
            total: 2,
            hasMore: false,
            nextOffset: 2
          }
        }
      };
      const { provider, selectionManager, batchFilterMock } = createProvider(root, responses, { yieldDelay: true });

      const firstPass = await provider.getChildren();
      expect(firstPass).toHaveLength(1);
      expect(firstPass[0]?.placeholder).toBe(true);

      await waitForNextTick();

      const rootNodes = await provider.getChildren();
      expect(rootNodes.map((node) => node.name)).toEqual(["src", "README.md"]);
      expect(batchFilterMock).toHaveBeenCalledTimes(1);

      const fileNode = rootNodes[1]!;
      const selectionEvents = captureEvents<TreeSelectionChange>((listener) => provider.onSelectionChanged(listener));

      selectionManager.toggleFile(fileNode.uri);

      expect(selectionEvents.events).toHaveLength(1);
      expect(selectionEvents.events[0]?.selected).toContain(fileNode.uri);

      const fileItem = provider.getTreeItem(fileNode);
      expect(fileItem.contextValue).toBe("file");
      expect(fileItem.isSelected).toBe(true);
      expect(fileItem.checkboxState).toBe(vscode.TreeItemCheckboxState.Checked);
      expect(fileItem.command?.command).toBe("vscode.open");

  const directoryItem = provider.getTreeItem(rootNodes[0]!);
  expect(directoryItem.contextValue.startsWith("directory")).toBe(true);
      expect(directoryItem.collapsibleState).toBe(vscode.TreeItemCollapsibleState.Collapsed);

      selectionEvents.dispose();
      provider.dispose();
      selectionManager.dispose();
    });
  });

  test("honours pagination with load more placeholder", async () => {
    await withTempWorkspace({}, async (root) => {
      setWorkspaceFolder(root);
      const workspaceUri = vscode.Uri.file(root);
      const srcUri = vscode.Uri.joinPath(workspaceUri, "src");
      const responses: ScanResponses = {
        [workspaceUri.toString()]: {
          0: {
            nodes: [makeDirectory(workspaceUri, "src", 2)],
            total: 1,
            hasMore: false,
            nextOffset: 1
          }
        },
        [srcUri.toString()]: {
          0: {
            nodes: [makeFile(workspaceUri, "src/index.ts")],
            total: 2,
            hasMore: true,
            nextOffset: 1
          },
          1: {
            nodes: [makeFile(workspaceUri, "src/utils.ts")],
            total: 2,
            hasMore: false,
            nextOffset: 2
          }
        }
      };
      const { provider, selectionManager } = createProvider(root, responses, { paginationSize: 1, yieldDelay: true });
      const progressEvents = captureEvents<TreeProgressEvent>((listener) => provider.onProgress(listener));

      await provider.getChildren();
      await waitForNextTick();
      const rootNodes = await provider.getChildren();
      const srcNode = rootNodes[0]!;

      const initialChildren = await provider.getChildren(srcNode);
      expect(initialChildren).toHaveLength(1);
      expect(initialChildren[0]?.placeholder).toBe(true);

      await waitForNextTick();
      const firstPage = await provider.getChildren(srcNode);
      expect(firstPage.map((node) => node.name)).toEqual(["index.ts", "Load more…"]);
      const loadMorePlaceholder = firstPage.find((node) => node.placeholder);
      expect(loadMorePlaceholder?.placeholderKind).toBe("loadMore");

      await provider.expandDirectory(srcUri);
      await waitForNextTick();
      const finalChildren = await provider.getChildren(srcNode);
      expect(finalChildren.map((node) => node.name)).toEqual(["index.ts", "utils.ts"]);
      expect(progressEvents.events.length).toBeGreaterThan(0);

      progressEvents.dispose();
      provider.dispose();
      selectionManager.dispose();
    });
  });

  test("surfaces scanner errors as error nodes", async () => {
    await withTempWorkspace({}, async (root) => {
      setWorkspaceFolder(root);
      const workspaceUri = vscode.Uri.file(root);
      const failingUri = vscode.Uri.joinPath(workspaceUri, "restricted");
      const responses: ScanResponses = {
        [workspaceUri.toString()]: {
          0: {
            nodes: [makeDirectory(workspaceUri, "restricted", 0)],
            total: 1,
            hasMore: false,
            nextOffset: 1
          }
        },
        [failingUri.toString()]: {
          0: new Error("permission denied")
        }
      };
      const { provider, selectionManager } = createProvider(root, responses, { yieldDelay: true });
      const errorEvents = captureEvents<TreeErrorEvent>((listener) => provider.onError(listener));

      await provider.getChildren();
      await waitForNextTick();
      const rootNodes = await provider.getChildren();
      const restrictedNode = rootNodes[0]!;

      const firstAttempt = await provider.getChildren(restrictedNode);
      expect(firstAttempt).toHaveLength(1);
      expect(firstAttempt[0]?.placeholder).toBe(true);

      await waitForNextTick();
      const resolvedChildren = await provider.getChildren(restrictedNode);
      expect(resolvedChildren).toHaveLength(1);
      expect(resolvedChildren[0]?.error).toContain("permission denied");
      expect(errorEvents.events.length).toBe(1);
      expect(errorEvents.events[0]?.error.message).toContain("permission denied");

      errorEvents.dispose();
      provider.dispose();
      selectionManager.dispose();
    });
  });
});