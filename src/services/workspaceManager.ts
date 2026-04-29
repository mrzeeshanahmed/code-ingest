import * as path from "node:path";
import * as vscode from "vscode";

import { FilterService, type FilterOptions, type FilterResult } from "./filterService";
import { createSkipStatsMap, recordSkip, recordFilterOutcome, buildSkipMessages, type SkipStatsMap } from "./filterDiagnostics";
import { DEFAULT_CONFIG } from "../config/constants";
import type { DigestConfig } from "../utils/validateConfig";
import type { Diagnostics } from "./diagnostics";
import type { GitignoreService } from "./gitignoreService";

export interface WorkspaceTreeNode {
  uri: string;
  name: string;
  relPath: string;
  type: "file" | "directory";
  children?: WorkspaceTreeNode[];
  childCount?: number;
  size?: number;
  expanded?: boolean;
  placeholder?: boolean;
}

interface WorkspaceManagerOptions {
  maxEntries?: number;
  autoExpandDepth?: number;
  skipHidden?: boolean;
  excludedDirectories?: string[];
  redactionOverride?: boolean;
  loadConfiguration?: () => DigestConfig;
}

interface BuildContext {
  count: number;
  truncated: boolean;
  filePaths: Set<string>;
  directoryDepths: Map<string, number>;
  warnings: string[];
  skipStats: SkipStatsMap;
}

export interface WorkspaceStateSnapshot {
  tree: WorkspaceTreeNode[];
  selection: string[];
  expandState: Record<string, boolean>;
  warnings: string[];
  scanId: string;
  status: "empty" | "ready";
  totalFiles: number;
  workspaceFolder?: string;
  redactionOverride: boolean;
}

const DEFAULT_MAX_ENTRIES = 2_000;
const DEFAULT_AUTO_EXPAND_DEPTH = 1;
const DEFAULT_EXCLUDED_DIRECTORIES = [".git", "node_modules", "dist", "out", "coverage", "tmp", "temp"];
const BULK_SELECTION_CHUNK_SIZE = 400;
interface FilterRuntime {
  service: FilterService;
  options: FilterOptions;
  excludeMatchers: Array<ReturnType<FilterService["compilePattern"]>>;
  maxDepth?: number;
  followSymlinks: boolean;
  useGitignore: boolean;
}

interface EntryMetadata {
  name: string;
  relPath: string;
  uri: vscode.Uri;
  isDirectory: boolean;
  isFile: boolean;
  isSymlink: boolean;
}

function toPosix(relativePath: string): string {
  return relativePath.split(path.sep).join("/");
}

export class WorkspaceManager {
  private readonly maxEntries: number;
  private readonly autoExpandDepth: number;
  private readonly skipHidden: boolean;
  private readonly excludedDirectories: Set<string>;
  private readonly loadConfiguration: (() => DigestConfig) | undefined;

  private rootUri: vscode.Uri | undefined;
  private tree: WorkspaceTreeNode[] = [];
  private selection = new Set<string>();
  private expandState = new Set<string>();
  private warnings: string[] = [];
  private totalFiles = 0;
  private lastScanId = "";
  private redactionOverride: boolean;
  private selectionLock: Promise<void> = Promise.resolve();
  private knownFiles = new Set<string>();

  constructor(
    private readonly diagnostics: Diagnostics,
    private readonly gitignoreService: GitignoreService,
    options: WorkspaceManagerOptions = {}
  ) {
    this.maxEntries = Math.max(200, options.maxEntries ?? DEFAULT_MAX_ENTRIES);
    this.autoExpandDepth = Math.max(0, options.autoExpandDepth ?? DEFAULT_AUTO_EXPAND_DEPTH);
    this.skipHidden = options.skipHidden ?? true;
    this.excludedDirectories = new Set(
      (options.excludedDirectories ?? DEFAULT_EXCLUDED_DIRECTORIES).map((dir) => dir.trim()).filter(Boolean)
    );
    this.redactionOverride = Boolean(options.redactionOverride);
    this.loadConfiguration = options.loadConfiguration;
  }

  async initialize(): Promise<void> {
    if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
      this.diagnostics.add("WorkspaceManager: No workspace folders detected.");
      this.rootUri = undefined;
      return;
    }

    this.rootUri = vscode.workspace.workspaceFolders[0]?.uri;
    if (!this.rootUri) {
      this.diagnostics.add("WorkspaceManager: Failed to resolve workspace URI.");
      return;
    }

    this.diagnostics.add(`WorkspaceManager initialized for ${this.rootUri.fsPath}`);
    await this.refreshWorkspaceTree();
  }

  getWorkspaceRoot(): vscode.Uri | undefined {
    return this.rootUri;
  }

  getSelection(): string[] {
    return Array.from(this.selection.values()).sort((a, b) => a.localeCompare(b));
  }

  getSelectionAbsolutePaths(): string[] {
    if (!this.rootUri) {
      return [];
    }
    return this.getSelection().map((relPath) => path.resolve(this.rootUri!.fsPath, relPath));
  }

  getExpandStateObject(): Record<string, boolean> {
    const snapshot: Record<string, boolean> = {};
    for (const relPath of this.expandState) {
      snapshot[relPath] = true;
    }
    return snapshot;
  }

  getTree(): WorkspaceTreeNode[] {
    return this.tree;
  }

  getWarnings(): string[] {
    return [...this.warnings];
  }

  getStateSnapshot(): WorkspaceStateSnapshot {
    const snapshot: WorkspaceStateSnapshot = {
      tree: this.tree,
      selection: this.getSelection(),
      expandState: this.getExpandStateObject(),
      warnings: this.getWarnings(),
      scanId: this.lastScanId,
      status: this.tree.length === 0 ? "empty" : "ready",
      totalFiles: this.totalFiles,
      redactionOverride: this.redactionOverride
    };

    if (this.rootUri) {
      snapshot.workspaceFolder = this.rootUri.fsPath;
    }

    return snapshot;
  }

  async refreshWorkspaceTree(): Promise<WorkspaceStateSnapshot> {
    if (!this.rootUri) {
      await this.initialize();
      if (!this.rootUri) {
        this.tree = [];
        this.selection.clear();
        this.expandState.clear();
        this.warnings = ["No workspace folder available."];
        this.totalFiles = 0;
        this.lastScanId = `scan-${Date.now()}`;
        this.knownFiles.clear();
        return this.getStateSnapshot();
      }
    }

    const configSnapshot = this.resolveConfiguration();
    const runtime = this.createFilterRuntime(configSnapshot, this.rootUri!);
    const context: BuildContext = {
      count: 0,
      truncated: false,
      filePaths: new Set<string>(),
      directoryDepths: new Map<string, number>(),
      warnings: [],
      skipStats: createSkipStatsMap()
    };

    try {
      const nodes = await this.buildDirectory(this.rootUri!, 0, context, runtime);
      this.tree = nodes;
      this.knownFiles = context.filePaths;
      this.totalFiles = this.knownFiles.size;
      const skipWarnings = buildSkipMessages(context.skipStats, {
        followSymlinks: runtime.followSymlinks,
        ...(typeof runtime.maxDepth === "number" ? { maxDepth: runtime.maxDepth } : {})
      });
      this.warnings = [...context.warnings, ...skipWarnings];
      if (context.truncated) {
        this.warnings.push(
          `Tree truncated after ${this.maxEntries} entries. Use filters or includes to narrow scope.`
        );
      }

      // Preserve previous expansion state where possible
      const nextExpand = new Set<string>();
      for (const [relPath, depth] of context.directoryDepths.entries()) {
        if (this.expandState.has(relPath) || depth <= this.autoExpandDepth) {
          nextExpand.add(relPath);
        }
      }
      this.expandState = nextExpand;

      // Ensure directory nodes reflect expansion
      this.applyExpandedState(this.tree, 0);

      // Discard selection entries that no longer exist
      const retained = new Set<string>();
      for (const relPath of this.selection) {
        if (this.knownFiles.has(relPath)) {
          retained.add(relPath);
        }
      }
      this.selection = retained;

      this.lastScanId = `scan-${Date.now()}`;
      this.diagnostics.add(`Workspace tree refreshed (${this.totalFiles} files discovered).`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.diagnostics.add(`Workspace tree refresh failed: ${message}`);
      this.tree = [];
      this.selection.clear();
      this.expandState.clear();
      this.warnings = [`Failed to scan workspace: ${message}`];
      this.totalFiles = 0;
      this.lastScanId = `scan-${Date.now()}`;
      this.knownFiles.clear();
    }

    return this.getStateSnapshot();
  }

  updateSelection(filePath: string, selected: boolean): void {
    if (typeof filePath !== "string" || filePath.length === 0) {
      return;
    }
    if (!this.knownFiles.has(filePath)) {
      return;
    }
    if (selected) {
      this.selection.add(filePath);
    } else {
      this.selection.delete(filePath);
    }
  }

  setSelection(paths: Iterable<string>): string[] {
    const next = new Set<string>();
    let requested = 0;
    for (const relPath of paths) {
      if (typeof relPath !== "string" || relPath.length === 0) {
        continue;
      }
      requested += 1;
      if (this.knownFiles.has(relPath)) {
        next.add(relPath);
      }
    }
    if (requested > next.size) {
      const dropped = requested - next.size;
      this.diagnostics.add(
        `Ignored ${dropped} selection ${dropped === 1 ? "entry" : "entries"} not present in the current tree.`
      );
    }
    this.selection = next;
    return this.getSelection();
  }

  async awaitSelectionSnapshot(): Promise<string[]> {
    return this.withSelectionLock(() => this.getSelection());
  }

  async selectAll(onProgress?: (processed: number, total: number) => void): Promise<string[]> {
    const totalFiles = this.totalFiles;
    if (totalFiles === 0) {
      this.selection.clear();
      onProgress?.(0, 0);
      return [];
    }

    const allFiles: string[] = [];
    await this.collectFilesIncrementally(this.tree, allFiles, onProgress, totalFiles);
    return this.setSelection(allFiles);
  }

  clearSelection(): void {
    this.selection.clear();
  }

  async withSelectionLock<T>(operation: () => Promise<T> | T): Promise<T> {
    let release: () => void = () => {};
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.selectionLock;
    this.selectionLock = previous.then(() => next, () => next);
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  expandAll(): void {
    const directories: string[] = [];
    this.collectDirectories(this.tree, directories);
    this.expandState = new Set(directories);
    this.applyExpandedState(this.tree, 0);
  }

  collapseAll(): void {
    const retain: string[] = [];
    if (this.autoExpandDepth >= 0) {
      this.collectDirectories(this.tree, retain, this.autoExpandDepth);
    }
    this.expandState = new Set(retain);
    this.applyExpandedState(this.tree, 0);
  }

  getRedactionOverride(): boolean {
    return this.redactionOverride;
  }

  setRedactionOverride(value: boolean): boolean {
    this.redactionOverride = Boolean(value);
    return this.redactionOverride;
  }

  toggleRedactionOverride(): boolean {
    this.redactionOverride = !this.redactionOverride;
    return this.redactionOverride;
  }

  private resolveConfiguration(): DigestConfig {
    const snapshot = this.loadConfiguration?.() ?? DEFAULT_CONFIG;
    const defaultInclude = Array.isArray(DEFAULT_CONFIG.include) && DEFAULT_CONFIG.include.length > 0
      ? DEFAULT_CONFIG.include
      : ["**/*"];
    const defaultExclude = Array.isArray(DEFAULT_CONFIG.exclude) && DEFAULT_CONFIG.exclude.length > 0
      ? DEFAULT_CONFIG.exclude
      : [];

    const include = Array.isArray(snapshot.include) && snapshot.include.length > 0
      ? [...snapshot.include]
      : [...defaultInclude];
    const exclude = Array.isArray(snapshot.exclude) && snapshot.exclude.length > 0
      ? [...snapshot.exclude]
      : [...defaultExclude];

    return {
      ...snapshot,
      include,
      exclude
    } satisfies DigestConfig;
  }

  private createFilterRuntime(config: DigestConfig, rootUri: vscode.Uri): FilterRuntime {
    const include = Array.isArray(config.include) && config.include.length > 0
      ? [...config.include]
      : [...(DEFAULT_CONFIG.include ?? ["**/*"])];
    const exclude = Array.isArray(config.exclude) && config.exclude.length > 0
      ? [...config.exclude]
      : [...(DEFAULT_CONFIG.exclude ?? [])];
    const followSymlinks = config.followSymlinks === true;
    const useGitignore = config.respectGitIgnore !== false;
    const maxDepth = typeof config.maxDepth === "number" && Number.isFinite(config.maxDepth)
      ? Math.max(0, Math.floor(config.maxDepth))
      : undefined;

    const options: FilterOptions = {
      includePatterns: include,
      excludePatterns: exclude,
      followSymlinks,
      useGitignore,
      ...(typeof maxDepth === "number" ? { maxDepth } : {})
    };

    const service = new FilterService({
      workspaceRoot: rootUri.fsPath,
      gitignoreService: this.gitignoreService,
      loadConfiguration: () => ({
        includePatterns: include,
        excludePatterns: exclude,
        followSymlinks,
        respectGitignore: useGitignore,
        ...(typeof maxDepth === "number" ? { maxDepth } : {})
      })
    });

    const excludeMatchers = exclude.map((pattern) => service.compilePattern(pattern, "exclude"));

    const runtime: FilterRuntime = {
      service,
      options,
      excludeMatchers,
      followSymlinks,
      useGitignore,
      ...(typeof maxDepth === "number" ? { maxDepth } : {})
    };

    return runtime;
  }

  private async buildDirectory(
    uri: vscode.Uri,
    depth: number,
    context: BuildContext,
    runtime: FilterRuntime
  ): Promise<WorkspaceTreeNode[]> {
    if (context.count >= this.maxEntries) {
      context.truncated = true;
      return [];
    }

    if (runtime.maxDepth !== undefined && depth > runtime.maxDepth) {
      return [];
    }

    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(uri);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      context.warnings.push(`Unable to read directory ${uri.fsPath}: ${message}`);
      return [];
    }

    entries.sort((a, b) => a[0].localeCompare(b[0], undefined, { sensitivity: "base" }));

    const metadata: EntryMetadata[] = [];
    for (const [name, fileType] of entries) {
      if (this.skipHidden && name.startsWith(".")) {
        continue;
      }
      if (depth > 0 && this.excludedDirectories.has(name)) {
        continue;
      }

      const childUri = vscode.Uri.joinPath(uri, name);
      const relPath = this.resolveRelativePath(childUri);
      if (!relPath) {
        continue;
      }

      const isDirectory = Boolean(fileType & vscode.FileType.Directory);
      const isFile = Boolean(fileType & vscode.FileType.File);
      const isSymlink = Boolean(fileType & vscode.FileType.SymbolicLink);

      if (!isDirectory && !isFile) {
        continue;
      }

      metadata.push({
        name,
        relPath,
        uri: childUri,
        isDirectory,
        isFile,
        isSymlink
      });
    }

    const fileEntries = metadata.filter((entry) => entry.isFile);
    let fileResults: Map<string, FilterResult> | undefined;
    if (fileEntries.length > 0) {
      try {
        const filePaths = fileEntries.map((entry) => entry.uri.fsPath);
        fileResults = await runtime.service.batchFilter(filePaths, runtime.options);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        context.warnings.push(`Failed to evaluate filters for ${uri.fsPath}: ${message}`);
      }
    }

    const nodes: WorkspaceTreeNode[] = [];

    for (const entry of metadata) {
      if (context.count >= this.maxEntries) {
        context.truncated = true;
        break;
      }

      if (entry.isDirectory) {
        if (!runtime.followSymlinks && entry.isSymlink) {
          recordSkip(context.skipStats, "symlink", entry.relPath);
          continue;
        }

        if (runtime.maxDepth !== undefined && depth + 1 > runtime.maxDepth) {
          recordSkip(context.skipStats, "depth", entry.relPath);
          continue;
        }

        if (runtime.useGitignore) {
          try {
            if (await this.gitignoreService.isIgnored(entry.uri.fsPath)) {
              recordSkip(context.skipStats, "gitignore", entry.relPath);
              continue;
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            context.warnings.push(`Gitignore check failed for ${entry.uri.fsPath}: ${message}`);
          }
        }

        const excludeMatch = runtime.excludeMatchers.find((pattern) => pattern.matcher(entry.relPath, true));
        if (excludeMatch) {
          recordSkip(context.skipStats, "exclude", entry.relPath, excludeMatch.source);
          continue;
        }

        const children = await this.buildDirectory(entry.uri, depth + 1, context, runtime);
        if (children.length === 0) {
          continue;
        }

        context.directoryDepths.set(entry.relPath, depth);
        const node: WorkspaceTreeNode = {
          uri: entry.uri.toString(),
          name: entry.name,
          relPath: entry.relPath,
          type: "directory",
          children,
          childCount: children.length
        };
        nodes.push(node);
        context.count += 1;
        continue;
      }

      if (entry.isFile) {
        if (!runtime.followSymlinks && entry.isSymlink) {
          recordSkip(context.skipStats, "symlink", entry.relPath);
          continue;
        }

        const hasFilterResults = Boolean(fileResults);
        const result = fileResults?.get(entry.uri.fsPath);
        if (hasFilterResults) {
          if (!result) {
            recordSkip(context.skipStats, "include", entry.relPath);
            continue;
          }
          if (!result.included) {
            recordFilterOutcome(context.skipStats, entry.relPath, result);
            continue;
          }
        }

        context.filePaths.add(entry.relPath);
        const stat = await this.safeStat(entry.uri);
        const node: WorkspaceTreeNode = {
          uri: entry.uri.toString(),
          name: entry.name,
          relPath: entry.relPath,
          type: "file",
          ...(typeof stat?.size === "number" ? { size: stat.size } : {})
        };
        nodes.push(node);
        context.count += 1;
      }
    }

    return nodes;
  }

  private applyExpandedState(nodes: WorkspaceTreeNode[], depth: number): void {
    for (const node of nodes) {
      if (node.type !== "directory") {
        continue;
      }
      const shouldExpand = this.expandState.has(node.relPath) || depth < this.autoExpandDepth;
      node.expanded = shouldExpand;
      if (shouldExpand) {
        this.expandState.add(node.relPath);
      }
      if (Array.isArray(node.children) && node.children.length > 0) {
        this.applyExpandedState(node.children, depth + 1);
      }
    }
  }

  private collectFiles(nodes: WorkspaceTreeNode[], acc: string[]): void {
    for (const node of nodes) {
      if (node.type === "file") {
        acc.push(node.relPath);
      } else if (node.type === "directory" && Array.isArray(node.children)) {
        this.collectFiles(node.children, acc);
      }
    }
  }

  private async collectFilesIncrementally(
    nodes: WorkspaceTreeNode[],
    acc: string[],
    onProgress?: (processed: number, total: number) => void,
    totalFiles = 0
  ): Promise<void> {
    if (!Array.isArray(nodes) || nodes.length === 0) {
      onProgress?.(acc.length, totalFiles);
      return;
    }

    const stack: WorkspaceTreeNode[] = [];
    for (let index = nodes.length - 1; index >= 0; index -= 1) {
      const node = nodes[index];
      if (node) {
        stack.push(node);
      }
    }

    let processed = acc.length;
    let visited = 0;

    while (stack.length > 0) {
      const node = stack.pop();
      if (!node) {
        continue;
      }
      visited += 1;

      if (node.type === "file") {
        acc.push(node.relPath);
        processed += 1;
        onProgress?.(processed, totalFiles);
      } else if (node.type === "directory" && Array.isArray(node.children)) {
        for (let childIndex = node.children.length - 1; childIndex >= 0; childIndex -= 1) {
          const child = node.children[childIndex];
          if (child) {
            stack.push(child);
          }
        }
      }

      if (visited % BULK_SELECTION_CHUNK_SIZE === 0) {
        onProgress?.(processed, totalFiles);
        await this.yieldToEventLoop();
      }
    }

    onProgress?.(processed, totalFiles);
  }

  private async yieldToEventLoop(): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }

  private collectDirectories(nodes: WorkspaceTreeNode[], acc: string[], maxDepth = Number.POSITIVE_INFINITY, depth = 0): void {
    for (const node of nodes) {
      if (node.type === "directory") {
        if (depth <= maxDepth) {
          acc.push(node.relPath);
        }
        if (Array.isArray(node.children)) {
          this.collectDirectories(node.children, acc, maxDepth, depth + 1);
        }
      }
    }
  }

  private resolveRelativePath(target: vscode.Uri): string | undefined {
    if (!this.rootUri) {
      return undefined;
    }
    const relative = path.relative(this.rootUri.fsPath, target.fsPath);
    if (!relative || relative.startsWith("..")) {
      return undefined;
    }
    return toPosix(relative === "" ? target.path : relative);
  }

  private async safeStat(uri: vscode.Uri): Promise<vscode.FileStat | undefined> {
    try {
      return await vscode.workspace.fs.stat(uri);
    } catch {
      return undefined;
    }
  }
}