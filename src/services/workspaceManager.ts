import * as path from "node:path";
import * as vscode from "vscode";

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
}

interface BuildContext {
  count: number;
  truncated: boolean;
  filePaths: Set<string>;
  directoryDepths: Map<string, number>;
  warnings: string[];
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

function toPosix(relativePath: string): string {
  return relativePath.split(path.sep).join("/");
}

export class WorkspaceManager {
  private readonly maxEntries: number;
  private readonly autoExpandDepth: number;
  private readonly skipHidden: boolean;
  private readonly excludedDirectories: Set<string>;

  private rootUri: vscode.Uri | undefined;
  private tree: WorkspaceTreeNode[] = [];
  private selection = new Set<string>();
  private expandState = new Set<string>();
  private warnings: string[] = [];
  private totalFiles = 0;
  private lastScanId = "";
  private redactionOverride: boolean;
  private selectionLock: Promise<void> = Promise.resolve();

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
        return this.getStateSnapshot();
      }
    }

    const context: BuildContext = {
      count: 0,
      truncated: false,
      filePaths: new Set<string>(),
      directoryDepths: new Map<string, number>(),
      warnings: []
    };

    try {
      const nodes = await this.buildDirectory(this.rootUri!, 0, context);
      this.tree = nodes;
      this.totalFiles = context.filePaths.size;
      this.warnings = context.warnings;
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
        if (context.filePaths.has(relPath)) {
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
    }

    return this.getStateSnapshot();
  }

  updateSelection(filePath: string, selected: boolean): void {
    if (typeof filePath !== "string" || filePath.length === 0) {
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
    for (const relPath of paths) {
      if (typeof relPath === "string" && relPath.length > 0) {
        next.add(relPath);
      }
    }
    this.selection = next;
    return this.getSelection();
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

  private async buildDirectory(uri: vscode.Uri, depth: number, context: BuildContext): Promise<WorkspaceTreeNode[]> {
    if (context.count >= this.maxEntries) {
      context.truncated = true;
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

    const nodes: WorkspaceTreeNode[] = [];
    for (const [name, fileType] of entries) {
      if (context.count >= this.maxEntries) {
        context.truncated = true;
        break;
      }

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

      if (await this.gitignoreService.isIgnored(childUri.fsPath)) {
        continue;
      }

      const isDirectory = Boolean(fileType & vscode.FileType.Directory);
      const isFile = Boolean(fileType & vscode.FileType.File);

      if (isDirectory) {
        context.directoryDepths.set(relPath, depth);
        const children = await this.buildDirectory(childUri, depth + 1, context);
        const node: WorkspaceTreeNode = {
          uri: childUri.toString(),
          name,
          relPath,
          type: "directory",
          children,
          childCount: children.length
        };
        nodes.push(node);
        context.count += 1;
        continue;
      }

      if (isFile) {
        const stat = await this.safeStat(childUri);
        const size = stat?.size;
        context.filePaths.add(relPath);
        const fileNode: WorkspaceTreeNode = {
          uri: childUri.toString(),
          name,
          relPath,
          type: "file"
        };
        if (typeof size === "number") {
          fileNode.size = size;
        }
        nodes.push(fileNode);
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
