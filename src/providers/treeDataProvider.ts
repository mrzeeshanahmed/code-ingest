import * as path from "node:path";
import * as vscode from "vscode";
import { FilterService, type FilterOptions } from "../services/filterService";
import type { GitignoreService } from "../services/gitignoreService";
import {
  type DirectoryScanOptions,
  FileScanner,
  type FileNode
} from "../services/fileScanner";
import { ExpandState } from "./expandState";
import { SelectionManager, type SelectionChangeEvent, type SelectionChangeSource } from "./selectionManager";
import { createTreeIcon, formatTooltip } from "./treeHelpers";

export interface TreeProgressEvent {
  readonly uri: vscode.Uri;
  readonly processed: number;
  readonly total?: number | undefined;
  readonly message?: string | undefined;
}

export interface TreeErrorEvent {
  readonly uri: vscode.Uri;
  readonly error: Error;
  readonly recoverable: boolean;
  readonly code?: string | undefined;
}

export interface TreeSelectionChange {
  readonly selected: string[];
  readonly selectedRelative: string[];
  readonly changed: string[];
  readonly changedRelative: string[];
  readonly type: SelectionChangeEvent["type"];
  readonly source: SelectionChangeSource;
}

export interface TreeDataProviderOptions {
  readonly includeGlobs?: string[];
  readonly excludeGlobs?: string[];
  readonly includeHidden?: boolean;
  readonly followSymlinks?: boolean;
  readonly paginationSize?: number;
  readonly refreshDebounceMs?: number;
  readonly filterService?: FilterService;
  readonly gitignoreService?: GitignoreService;
  readonly maxCachedDirectories?: number;
}

type FileDirectoryContext = `${"file" | "directory"}${"" | `.${string}`}`;
type TreeContextValue = "scanning" | "error" | "loadMore" | FileDirectoryContext;

export interface CodeIngestTreeItem extends vscode.TreeItem {
  uri: vscode.Uri;
  relPath: string;
  fileNode: FileNode;
  contextValue: TreeContextValue;
  command?: vscode.Command;
  isSelected?: boolean | undefined;
  childCount?: number | undefined;
}

interface DirectoryState {
  node?: FileNode | undefined;
  children: FileNode[];
  total: number;
  hasMore: boolean;
  nextOffset: number;
  loading: boolean;
  pending?: Promise<FileNode[]> | undefined;
  error?: string | undefined;
  lastAccessed: number;
}

interface LoadDirectoryOptions {
  readonly reset?: boolean;
  readonly append?: boolean;
  readonly emitProgress?: boolean;
}

const DEFAULT_REFRESH_DEBOUNCE = 200;
const DEFAULT_PAGE_SIZE = 200;
const DEFAULT_CACHE_LIMIT = 2048;

export class CodeIngestTreeProvider implements vscode.TreeDataProvider<FileNode>, vscode.Disposable {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<FileNode | undefined>();
  readonly onDidChangeTreeData: vscode.Event<FileNode | undefined> = this.onDidChangeTreeDataEmitter.event;

  private readonly onProgressEmitter = new vscode.EventEmitter<TreeProgressEvent>();
  readonly onProgress = this.onProgressEmitter.event;

  private readonly onErrorEmitter = new vscode.EventEmitter<TreeErrorEvent>();
  readonly onError = this.onErrorEmitter.event;

  private readonly onSelectionEmitter = new vscode.EventEmitter<TreeSelectionChange>();
  readonly onSelectionChanged = this.onSelectionEmitter.event;

  private readonly scanningPlaceholder: FileNode = {
    uri: "code-ingest://placeholder/scanning",
    name: "Scanning…",
    type: "file",
    placeholder: true,
    placeholderKind: "scanning"
  };

  private readonly includeGlobs: string[];
  private readonly excludeGlobs: string[];
  private readonly includeHidden: boolean;
  private readonly followSymlinks: boolean;
  private readonly paginationSize: number;
  private readonly refreshDebounceMs: number;
  private readonly filterServiceOverride: FilterService | undefined;
  private readonly gitignoreService: GitignoreService | undefined;
  private readonly maxCachedDirectories: number;
  private filterServiceInstance: FilterService | undefined;

  private readonly commandDisposables: vscode.Disposable[] = [];

  private readonly directoryCache = new Map<string, DirectoryState>();
  private readonly nodeIndex = new Map<string, FileNode>();

  private rootNodes: FileNode[] = [];
  private rootLoadPromise: Promise<FileNode[]> | undefined;
  private refreshTimer: NodeJS.Timeout | undefined;
  private refreshPromise: Promise<void> | undefined;
  private scanCancellationSource: vscode.CancellationTokenSource | undefined;
  private selectionListenerDisposable: vscode.Disposable | undefined;

  constructor(
    private readonly workspaceFolderUri: vscode.Uri,
    private readonly fileScanner: FileScanner,
    private readonly selectionManager: SelectionManager,
    private readonly expandState: ExpandState,
    options: TreeDataProviderOptions = {}
  ) {
    this.includeGlobs = options.includeGlobs ?? [];
    this.excludeGlobs = options.excludeGlobs ?? [];
    this.includeHidden = options.includeHidden ?? false;
    this.followSymlinks = options.followSymlinks ?? false;
    this.paginationSize = options.paginationSize ?? DEFAULT_PAGE_SIZE;
    this.refreshDebounceMs = options.refreshDebounceMs ?? DEFAULT_REFRESH_DEBOUNCE;
    this.filterServiceOverride = options.filterService;
    this.gitignoreService = options.gitignoreService;
    this.maxCachedDirectories = options.maxCachedDirectories ?? DEFAULT_CACHE_LIMIT;

    this.selectionListenerDisposable = this.selectionManager.onDidChangeSelection((event) => this.handleSelectionChange(event));
    this.commandDisposables.push(
      vscode.commands.registerCommand("codeIngest.tree.loadMore", async (target: vscode.Uri | string) => {
        const uri = this.resolveToUri(target);
        await this.expandDirectory(uri);
      }),
      vscode.commands.registerCommand("codeIngest.tree.retryDirectory", async (target: vscode.Uri | string) => {
        const uri = this.resolveToUri(target);
        this.directoryCache.delete(uri.toString());
        await this.loadDirectory(uri, { reset: true, emitProgress: true });
      })
    );
  }

  getTreeItem(element: FileNode): CodeIngestTreeItem {
    if (element.placeholder) {
      const item = new vscode.TreeItem(element.name, vscode.TreeItemCollapsibleState.None) as CodeIngestTreeItem;
      item.contextValue = element.placeholderKind === "loadMore" ? "loadMore" : "scanning";
      item.iconPath = createTreeIcon(element, false);
      item.fileNode = element;
      item.uri = vscode.Uri.parse(element.uri);
      item.relPath = element.relPath ?? element.uri;
      item.tooltip = element.placeholderKind === "loadMore" ? new vscode.MarkdownString("Load additional entries…") : new vscode.MarkdownString("Scanning in progress…");
      if (element.placeholderKind === "loadMore") {
        const parentUri = element.relPath ? vscode.Uri.parse(element.relPath) : undefined;
        if (parentUri) {
          item.command = {
            command: "codeIngest.tree.loadMore",
            title: "Load more",
            arguments: [parentUri]
          } satisfies vscode.Command;
        }
      }
      item.isSelected = false;
      return item;
    }

    const uri = vscode.Uri.parse(element.uri);
    const relPath = element.relPath ?? path.relative(this.workspaceFolderUri.fsPath, uri.fsPath);
    const isDirectory = element.type === "directory";
    const isExpanded = isDirectory && this.expandState.isExpanded(element.uri);

    const collapsibleState = isDirectory
      ? isExpanded
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.None;

    const label = path.basename(uri.fsPath) || element.name;
    const item = new vscode.TreeItem(label, collapsibleState) as CodeIngestTreeItem;
    item.id = element.uri;
    item.resourceUri = uri;
    item.fileNode = element;
    item.uri = uri;
    item.relPath = relPath;
    if (typeof element.childCount === "number") {
      item.childCount = element.childCount;
    }

    const contextSegments: string[] = [];

    const isSelected = element.type === "file" && this.selectionManager.isSelected(element.uri);
    item.isSelected = isSelected;
    if (element.type === "file" && !element.error) {
      item.command = {
        command: "vscode.open",
        title: "Open File",
        arguments: [uri]
      } satisfies vscode.Command;
      item.checkboxState = isSelected
        ? vscode.TreeItemCheckboxState.Checked
        : vscode.TreeItemCheckboxState.Unchecked;
      contextSegments.push("file");
      const metadata = element.metadata ?? {};
      if (metadata.languageId === "notebook" || element.name.toLowerCase().endsWith(".ipynb")) {
        contextSegments.push("notebook");
      }
      if (metadata.isBinary) {
        contextSegments.push("binary");
      }
      if (metadata.isSymbolicLink) {
        contextSegments.push("symlink");
      }
    }

    if (isDirectory && !element.error) {
      contextSegments.push("directory");
      const directoryState = this.computeDirectoryCheckboxState(uri);
      if (directoryState) {
        item.checkboxState = directoryState;
      }
      if (element.childCount && element.childCount > this.paginationSize) {
        contextSegments.push("large");
      }
      if (this.directoryCache.get(element.uri)?.hasMore) {
        contextSegments.push("hasMore");
      }
    }

    item.iconPath = createTreeIcon(element, isExpanded);
    item.tooltip = formatTooltip(element);

    if (element.error) {
      item.contextValue = "error";
      item.iconPath = new vscode.ThemeIcon("warning");
      delete (item as { checkboxState?: unknown }).checkboxState;
      delete (item as { command?: unknown }).command;
      const targetUri = element.relPath ? vscode.Uri.parse(element.relPath) : uri;
      item.command = {
        command: "codeIngest.tree.retryDirectory",
        title: "Retry directory load",
        arguments: [targetUri]
      } satisfies vscode.Command;
    } else if (element.type === "directory") {
      const contextValue = (contextSegments.join(".") || "directory") as TreeContextValue;
      item.contextValue = contextValue;
    } else {
      const contextValue = (contextSegments.join(".") || "file") as TreeContextValue;
      item.contextValue = contextValue;
    }

    return item;
  }

  async getChildren(element?: FileNode): Promise<FileNode[]> {
    if (!element) {
      if (this.rootNodes.length > 0) {
        return this.rootNodes;
      }
      if (!this.rootLoadPromise) {
        this.rootLoadPromise = this.loadWorkspaceRoot({ reset: false, emitProgress: true }).finally(() => {
          this.rootLoadPromise = undefined;
        });
        return [this.scanningPlaceholder];
      }
      await this.rootLoadPromise.catch(() => undefined);
      return this.rootNodes.length > 0 ? this.rootNodes : [this.scanningPlaceholder];
    }

    if (element.placeholder) {
      if (element.placeholderKind === "loadMore") {
        const targetUriString = element.relPath ?? element.uri.replace(/#load-more$/, "");
        const targetUri = vscode.Uri.parse(targetUriString);
        await this.expandDirectory(targetUri);
        const stateAfter = this.directoryCache.get(targetUri.toString());
        return stateAfter ? [...stateAfter.children] : [];
      }
      return [];
    }

    if (element.type !== "directory") {
      return [];
    }

    const state = this.ensureDirectoryState(element.uri, element);
    if (state.loading) {
      return [...state.children, this.scanningPlaceholder];
    }

    if (state.children.length === 0 || state.hasMore) {
      void this.loadDirectory(vscode.Uri.parse(element.uri), { append: state.children.length > 0, emitProgress: true });
      return state.children.length > 0 ? [...state.children] : [this.scanningPlaceholder];
    }

    return state.children;
  }

  async refreshTree(): Promise<void> {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }

    this.refreshPromise = new Promise((resolve, reject) => {
      this.refreshTimer = setTimeout(() => {
        void this.performRefresh().then(resolve).catch(reject);
      }, this.refreshDebounceMs);
    });

    return this.refreshPromise;
  }

  async expandDirectory(uri: vscode.Uri): Promise<void> {
    const key = uri.toString();
    const state = this.directoryCache.get(key);
    if (!state) {
      this.ensureDirectoryState(key);
    }

    const activeState = this.directoryCache.get(key);
    if (!activeState) {
      return;
    }

    this.expandState.setExpanded(key);

    if (activeState.loading) {
      await activeState.pending;
      return;
    }

    if (activeState.hasMore || activeState.children.length === 0) {
      await this.loadDirectory(uri, { append: activeState.children.length > 0, emitProgress: true });
    }
  }

  refresh(): void {
    void this.refreshTree();
  }

  dispose(): void {
    this.onDidChangeTreeDataEmitter.dispose();
    this.onProgressEmitter.dispose();
    this.onErrorEmitter.dispose();
    this.onSelectionEmitter.dispose();
    this.selectionListenerDisposable?.dispose();
    this.cancelActiveScan();
    for (const disposable of this.commandDisposables) {
      disposable.dispose();
    }
  }

  private async performRefresh(): Promise<void> {
    this.cancelActiveScan();
    this.directoryCache.clear();
    this.nodeIndex.clear();
    this.rootNodes = [];
    this.onDidChangeTreeDataEmitter.fire(undefined);
    await this.loadWorkspaceRoot({ reset: true, emitProgress: true });
  }

  private async loadWorkspaceRoot(options: LoadDirectoryOptions): Promise<FileNode[]> {
    const state = this.ensureDirectoryState(this.workspaceFolderUri.toString(), {
      uri: this.workspaceFolderUri.toString(),
      name: path.basename(this.workspaceFolderUri.fsPath) || this.workspaceFolderUri.fsPath,
      type: "directory",
      relPath: "."
    });
    const nodes = await this.loadDirectory(this.workspaceFolderUri, { ...options, append: false });
    this.rootNodes = nodes;
    return state.children;
  }

  private ensureDirectoryState(key: string, node?: FileNode): DirectoryState {
    const existing = this.directoryCache.get(key);
    if (existing) {
      existing.lastAccessed = Date.now();
      if (node && !existing.node) {
        existing.node = node;
      }
      return existing;
    }

    const state: DirectoryState = {
      node,
      children: [],
      total: 0,
      hasMore: true,
      nextOffset: 0,
      loading: false,
      lastAccessed: Date.now()
    };
    this.directoryCache.set(key, state);
    this.pruneCache();
    return state;
  }

  private async loadDirectory(uri: vscode.Uri, options: LoadDirectoryOptions): Promise<FileNode[]> {
    const key = uri.toString();
    const state = this.ensureDirectoryState(key);

    if (state.loading && state.pending) {
      return state.pending;
    }

    if (options.reset) {
      state.children = [];
      state.total = 0;
      state.hasMore = true;
      state.nextOffset = 0;
    }

    const offset = options.append ? state.nextOffset : 0;
    const tokenSource = this.ensureTokenSource();
    const scanOptions: DirectoryScanOptions = {
      offset,
      limit: this.paginationSize,
      includeHidden: this.includeHidden,
      followSymlinks: this.followSymlinks,
      token: tokenSource.token
    };

    state.loading = true;
    state.pending = (async () => {
      try {
        if (options.emitProgress) {
          this.emitProgress(uri, offset, state.total, "Scanning directory...");
        }

        const result = await this.fileScanner.scanDirectoryShallow(uri, scanOptions);
        const filtered = await this.applyFilters(result.nodes);
        const sorted = this.sortChildren(filtered);

        const withPagination = this.applyPagination(sorted, result.hasMore, uri);
        state.children = options.append ? this.mergeChildren(state.children, withPagination) : withPagination;
        state.total = result.total;
        state.hasMore = result.hasMore;
        state.nextOffset = result.nextOffset;
        state.error = undefined;
        state.lastAccessed = Date.now();

        this.indexChildren(state.children);

        const parentNode = state.node ?? this.nodeIndex.get(key);
        if (parentNode) {
          parentNode.children = state.children;
          parentNode.childCount = result.total;
        }

        this.onDidChangeTreeDataEmitter.fire(parentNode);
        if (options.emitProgress) {
          this.emitProgress(uri, Math.min(result.nextOffset, result.total), result.total);
        }
        return state.children;
      } catch (error) {
        if (error instanceof vscode.CancellationError) {
          return state.children;
        }
        const err = error instanceof Error ? error : new Error(String(error));
        state.children = [this.createErrorNode(uri, err.message)];
        state.total = 0;
        state.hasMore = false;
        state.nextOffset = 0;
        state.error = err.message;
        this.onErrorEmitter.fire({ uri, error: err, recoverable: true });
        const parentNode = state.node ?? this.nodeIndex.get(key);
        this.onDidChangeTreeDataEmitter.fire(parentNode);
        return state.children;
      } finally {
        state.loading = false;
        state.pending = undefined;
      }
    })();

    return state.pending;
  }

  private createErrorNode(uri: vscode.Uri, message: string): FileNode {
    return {
      uri: `${uri.toString()}#error`,
      name: message,
      type: "file",
      error: message,
      relPath: uri.toString()
    };
  }

  private mergeChildren(existing: FileNode[], incoming: FileNode[]): FileNode[] {
    const filteredExisting = existing.filter((child) => !child.placeholder || child.placeholderKind !== "loadMore");
    return [...filteredExisting, ...incoming];
  }

  private applyPagination(children: FileNode[], hasMore: boolean, parent: vscode.Uri): FileNode[] {
    if (!hasMore) {
      return children;
    }
    return [...children, this.createLoadMorePlaceholder(parent)];
  }

  private createLoadMorePlaceholder(parent: vscode.Uri): FileNode {
    return {
      uri: `${parent.toString()}#load-more`,
      name: "Load more…",
      type: "file",
      placeholder: true,
      placeholderKind: "loadMore",
      relPath: parent.toString()
    };
  }

  private sortChildren(children: FileNode[]): FileNode[] {
    const directories: FileNode[] = [];
    const files: FileNode[] = [];
    for (const child of children) {
      if (child.type === "directory") {
        directories.push(child);
      } else {
        files.push(child);
      }
    }
    directories.sort((a, b) => a.name.localeCompare(b.name));
    files.sort((a, b) => a.name.localeCompare(b.name));
    return [...directories, ...files];
  }

  private indexChildren(children: FileNode[]): void {
    for (const child of children) {
      if (child.placeholder) {
        continue;
      }
      this.nodeIndex.set(child.uri, child);
      if (child.type === "directory") {
        this.ensureDirectoryState(child.uri, child);
      }
    }
  }

  private emitProgress(uri: vscode.Uri, processed: number, total?: number, message?: string): void {
    this.onProgressEmitter.fire({ uri, processed, total, message });
  }

  private ensureTokenSource(): vscode.CancellationTokenSource {
    if (!this.scanCancellationSource) {
      this.scanCancellationSource = new vscode.CancellationTokenSource();
    }
    return this.scanCancellationSource;
  }

  private cancelActiveScan(): void {
    if (this.scanCancellationSource && !this.scanCancellationSource.token.isCancellationRequested) {
      this.scanCancellationSource.cancel();
    }
    this.scanCancellationSource?.dispose();
    this.scanCancellationSource = undefined;
  }

  private handleSelectionChange(event: SelectionChangeEvent): void {
    const parentsToRefresh = new Set<string>();
    for (const uri of event.files) {
      const node = this.nodeIndex.get(uri);
      if (node) {
        this.onDidChangeTreeDataEmitter.fire(node);
      }
      for (const parentUri of this.collectParentUris(uri)) {
        parentsToRefresh.add(parentUri);
      }
    }
    for (const parent of parentsToRefresh) {
      const parentNode = this.nodeIndex.get(parent);
      if (parentNode) {
        this.onDidChangeTreeDataEmitter.fire(parentNode);
      }
    }
    this.onSelectionEmitter.fire({
      selected: event.selected,
      selectedRelative: event.selectedRelative,
      changed: event.files,
      changedRelative: event.relativeFiles,
      type: event.type,
      source: event.source
    });
  }

  private async applyFilters(nodes: FileNode[]): Promise<FileNode[]> {
    const files = nodes.filter((node) => node.type === "file");
    if (files.length === 0) {
      return nodes;
    }
    const filterService = this.getFilterService();
    const absolutePaths = files.map((node) => vscode.Uri.parse(node.uri).fsPath);
    const filterOptions = {
      followSymlinks: this.followSymlinks,
      useGitignore: Boolean(this.gitignoreService),
      ...(this.includeGlobs.length > 0 ? { includePatterns: this.includeGlobs } : {}),
      ...(this.excludeGlobs.length > 0 ? { excludePatterns: this.excludeGlobs } : {})
    } satisfies FilterOptions;
    const resultMap = await filterService.batchFilter(absolutePaths, filterOptions);
    const allowed = new Set<string>();
    for (const [absPath, decision] of resultMap.entries()) {
      if (decision.included) {
        allowed.add(path.normalize(absPath));
      }
    }
    return nodes.filter((node) => {
      if (node.type === "directory") {
        return true;
      }
      const fsPath = path.normalize(vscode.Uri.parse(node.uri).fsPath);
      return allowed.has(fsPath);
    });
  }

  private getFilterService(): FilterService {
    if (this.filterServiceOverride) {
      return this.filterServiceOverride;
    }
    if (!this.filterServiceInstance) {
      this.filterServiceInstance = new FilterService({
        workspaceRoot: this.workspaceFolderUri.fsPath,
        ...(this.gitignoreService ? { gitignoreService: this.gitignoreService } : {})
      });
    }
    return this.filterServiceInstance;
  }

  private pruneCache(): void {
    if (this.directoryCache.size <= this.maxCachedDirectories) {
      return;
    }

    const entries = [...this.directoryCache.entries()].sort(([, a], [, b]) => a.lastAccessed - b.lastAccessed);
    while (this.directoryCache.size > this.maxCachedDirectories && entries.length > 0) {
      const [key] = entries.shift()!;
      if (key === this.workspaceFolderUri.toString()) {
        continue;
      }
      this.directoryCache.delete(key);
      this.nodeIndex.delete(key);
    }
  }

  private collectParentUris(target: string): string[] {
    const result: string[] = [];
    try {
      let current = vscode.Uri.parse(target);
      const workspaceFsPath = this.workspaceFolderUri.fsPath;
      while (true) {
        const fsPath = current.scheme === "file" ? current.fsPath : current.path;
        if (!fsPath || path.normalize(fsPath) === path.normalize(workspaceFsPath)) {
          break;
        }
        current = vscode.Uri.file(path.dirname(fsPath));
        const key = current.toString();
        if (this.nodeIndex.has(key)) {
          result.push(key);
        }
        if (path.normalize(fsPath) === path.dirname(fsPath)) {
          break;
        }
      }
    } catch {
      return result;
    }
    return result;
  }

  private computeDirectoryCheckboxState(uri: vscode.Uri): vscode.TreeItemCheckboxState | undefined {
    const folderString = uri.toString();
    const selectedUris = this.selectionManager.getSelectedUris();
    if (selectedUris.length === 0) {
      return undefined;
    }

    let hasSelectedDescendant = false;
    for (const selected of selectedUris) {
      if (this.isDescendant(folderString, selected)) {
        hasSelectedDescendant = true;
        break;
      }
    }

    if (!hasSelectedDescendant) {
      return undefined;
    }

    const checkboxStates = vscode.TreeItemCheckboxState as unknown as Record<string, vscode.TreeItemCheckboxState | undefined>;
    for (const key of ["Indeterminate", "Intermediate", "PartiallyChecked", "PartiallyCheck"]) {
      const value = checkboxStates?.[key];
      if (typeof value === "number") {
        return value;
      }
    }
    return undefined;
  }

  private isDescendant(parentUriString: string, candidateUriString: string): boolean {
    try {
      const parent = vscode.Uri.parse(parentUriString);
      const candidate = vscode.Uri.parse(candidateUriString);
      if (parent.scheme !== candidate.scheme) {
        return false;
      }
      const parentPath = this.normalizeFsPath(parent);
      const candidatePath = this.normalizeFsPath(candidate);
      if (!candidatePath.startsWith(parentPath)) {
        return false;
      }
      const relative = path.relative(parentPath, candidatePath);
      return relative !== "" && !relative.startsWith("..");
    } catch {
      return false;
    }
  }

  private normalizeFsPath(uri: vscode.Uri): string {
    const raw = uri.scheme === "file" ? uri.fsPath : uri.path;
    const normalized = path.normalize(raw);
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  }

  private resolveToUri(target: vscode.Uri | string): vscode.Uri {
    if (target instanceof vscode.Uri) {
      return target;
    }
    return typeof target === "string" ? vscode.Uri.parse(target) : this.workspaceFolderUri;
  }
}
