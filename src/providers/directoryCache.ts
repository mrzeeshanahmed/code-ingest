import * as path from "node:path";
import * as vscode from "vscode";
import type { FileNode, DirectoryScanResult } from "../services/fileScanner";
import { FileScanner } from "../services/fileScanner";
import { ConfigurationService } from "../services/configurationService";
import { Diagnostics } from "../utils/validateConfig";
import { wrapError } from "../utils/errorHandling";

export interface DirectoryEntry {
  nodes: Array<FileNode | undefined>;
  totalCount: number;
  lastScanned: Date;
  isComplete: boolean;
  nextOffset: number;
}

export interface CacheOptions {
  maxEntries?: number;
  ttlMs?: number;
  pageSize?: number;
  autoRefresh?: boolean;
  maxMemoryMb?: number;
}

interface CacheNode {
  entry: DirectoryEntry;
  lastAccess: number;
  expiresAt: number;
  sizeEstimate: number;
}

interface CacheStats {
  hits: number;
  misses: number;
  evictions: number;
  invalidations: number;
  loads: number;
  loadErrors: number;
  lastCleanup: number;
  memoryBytes: number;
}

interface ErrorEvent {
  dirPath: string;
  error: Error;
}

const DEFAULT_MAX_ENTRIES = 100;
const DEFAULT_TTL = 5 * 60 * 1000;
const DEFAULT_PAGE_SIZE = 200;
const DEFAULT_AUTO_REFRESH = true;
const DEFAULT_MAX_MEMORY_MB = 50;
const CLEANUP_INTERVAL_MS = 60 * 1000;
const INVALIDATION_DEBOUNCE_MS = 150;

/**
 * The DirectoryCache coordinates lazy-loading directory listings with an in-memory
 * LRU cache guarded by TTL and memory constraints. It integrates with FileScanner
 * for data population, listens to file system changes for selective invalidation,
 * and surfaces statistics for diagnostics.
 */
export class DirectoryCache implements vscode.Disposable {
  private readonly cache = new Map<string, CacheNode>();
  private readonly stats: CacheStats = {
    hits: 0,
    misses: 0,
    evictions: 0,
    invalidations: 0,
    loads: 0,
    loadErrors: 0,
    lastCleanup: Date.now(),
    memoryBytes: 0
  };
  private readonly disposables: vscode.Disposable[] = [];
  private readonly errorEmitter = new vscode.EventEmitter<ErrorEvent>();
  private cleanupTimer: NodeJS.Timeout | undefined;
  private readonly pendingInvalidations = new Map<string, NodeJS.Timeout>();
  private workspaceWatcher: vscode.FileSystemWatcher | undefined;
  private disposed = false;

  private enabled: boolean;
  private options: Required<CacheOptions>;

  constructor(
    private readonly workspaceUri: vscode.Uri,
    private readonly fileScanner: FileScanner,
    private readonly diagnostics: Diagnostics = {
      addError: (m: string) => console.error(m),
      addWarning: (m: string) => console.warn(m)
    },
    private readonly configurationService?: ConfigurationService,
    options?: CacheOptions
  ) {
    const { enabled, options: resolved } = this.resolveOptions(options);
    this.enabled = enabled;
    this.options = resolved;

    try {
      this.configurationService?.loadConfig();
    } catch (error) {
      this.diagnostics.addWarning?.(`DirectoryCache configuration load failed: ${(error as Error).message}`);
    }

    if (this.enabled && this.options.autoRefresh) {
      this.initializeWatcher();
    }

    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("codeIngest.directoryCache")) {
          this.applyConfiguration();
        }
      })
    );

    this.scheduleCleanupTimer();
  }

  get onDidError(): vscode.Event<ErrorEvent> {
    return this.errorEmitter.event;
  }

  getCachedDirectory(dirPath: string): DirectoryEntry | null {
    if (!this.enabled) {
      return null;
    }

    const key = this.normalizePath(dirPath);
    const node = this.cache.get(key);
    if (!node) {
      this.stats.misses += 1;
      return null;
    }

    if (Date.now() > node.expiresAt) {
      this.removeEntry(key, node);
      this.stats.misses += 1;
      return null;
    }

    this.cache.delete(key);
    this.cache.set(key, { ...node, lastAccess: Date.now() });
    this.stats.hits += 1;
    return node.entry;
  }

  setCachedDirectory(dirPath: string, entry: DirectoryEntry): void {
    if (!this.enabled) {
      return;
    }

    const key = this.normalizePath(dirPath);
    const sizeEstimate = this.estimateEntrySize(entry);

    const expiresAt = Date.now() + this.options.ttlMs;
    const node: CacheNode = {
      entry,
      lastAccess: Date.now(),
      expiresAt,
      sizeEstimate
    };

    const previous = this.cache.get(key);
    if (previous) {
      this.stats.memoryBytes -= previous.sizeEstimate;
      this.cache.delete(key);
    }

    this.cache.set(key, node);
    this.stats.memoryBytes += sizeEstimate;

    this.evictIfNeeded();
  }

  invalidateDirectory(dirPath: string): void {
    const key = this.normalizePath(dirPath);
    const node = this.cache.get(key);
    if (node) {
      this.removeEntry(key, node, false);
      this.stats.invalidations += 1;
    }
  }

  clearCache(): void {
    for (const [key, node] of this.cache.entries()) {
      this.removeEntry(key, node, false);
    }
    this.cache.clear();
    this.stats.memoryBytes = 0;
  }

  has(dirPath: string): boolean {
    return this.cache.has(this.normalizePath(dirPath));
  }

  async getDirectoryPage(dirPath: string, offset: number, limit: number, token?: vscode.CancellationToken): Promise<DirectoryEntry> {
    const effectiveLimit = limit || this.options.pageSize;
    if (!this.enabled) {
      return this.directScan(dirPath, offset, effectiveLimit, token);
    }

    const key = this.normalizePath(dirPath);
    let cached = this.getCachedDirectory(key);
    if (cached && this.isRangeLoaded(cached, offset, effectiveLimit)) {
      return this.toPageResult(cached, offset, effectiveLimit);
    }

    cached = await this.populateSegment(key, offset, effectiveLimit, token);
    return this.toPageResult(cached, offset, effectiveLimit);
  }

  async loadMoreFiles(dirPath: string, additionalCount: number, token?: vscode.CancellationToken): Promise<FileNode[]> {
    const key = this.normalizePath(dirPath);
    let entry = this.getCachedDirectory(key);
    const offset = entry ? this.getNextContiguousOffset(entry.nodes) : 0;

    entry = await this.populateSegment(key, offset, additionalCount, token);
    return this.collectRange(entry, offset, additionalCount);
  }

  isDirectoryFullyLoaded(dirPath: string): boolean {
    const entry = this.getCachedDirectory(dirPath);
    return entry ? entry.isComplete : false;
  }

  getStats(): CacheStats {
    return { ...this.stats };
  }

  inspectCache(): Array<{ dirPath: string; entry: DirectoryEntry; expiresAt: number }> {
    const summary: Array<{ dirPath: string; entry: DirectoryEntry; expiresAt: number }> = [];
    for (const [key, node] of this.cache.entries()) {
      summary.push({ dirPath: key, entry: node.entry, expiresAt: node.expiresAt });
    }
    return summary;
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;

    this.clearCache();

    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }

    for (const timeout of this.pendingInvalidations.values()) {
      clearTimeout(timeout);
    }
    this.pendingInvalidations.clear();

    this.workspaceWatcher?.dispose();
    this.workspaceWatcher = undefined;

    this.errorEmitter.dispose();

    while (this.disposables.length > 0) {
      const disposable = this.disposables.pop();
      try {
        disposable?.dispose();
      } catch (error) {
        this.diagnostics.addWarning?.(`DirectoryCache dispose error: ${(error as Error).message}`);
      }
    }
  }

  private async populateSegment(dirPath: string, offset: number, limit: number, token?: vscode.CancellationToken): Promise<DirectoryEntry> {
    const key = this.normalizePath(dirPath);
    let existing = this.cache.get(key)?.entry;

    try {
      const result = await this.scanDirectory(key, offset, limit, token);

      if (!existing) {
        existing = {
          nodes: [],
          totalCount: 0,
          isComplete: false,
          nextOffset: 0,
          lastScanned: new Date(0)
        };
      }

      const mergedNodes = existing.nodes.slice();
      const startIndex = offset;
      for (let index = 0; index < result.nodes.length; index += 1) {
        mergedNodes[startIndex + index] = result.nodes[index];
      }
      const totalCount = Math.max(existing.totalCount, result.total);
      const nextOffset = Math.min(this.getNextContiguousOffset(mergedNodes), totalCount);
      const isComplete = nextOffset >= totalCount;
      const entry: DirectoryEntry = {
        nodes: mergedNodes,
        totalCount,
        isComplete,
        nextOffset,
        lastScanned: new Date()
      };

      this.setCachedDirectory(key, entry);
      this.stats.loads += 1;
      return entry;
    } catch (error) {
      this.stats.loadErrors += 1;
      this.invalidateDirectory(key);
      this.errorEmitter.fire({ dirPath: key, error: error as Error });

      if (!this.enabled) {
        throw error;
      }

      return this.directScan(key, offset, limit, token);
    }
  }

  private async directScan(dirPath: string, offset: number, limit: number, token?: vscode.CancellationToken): Promise<DirectoryEntry> {
    const result = await this.scanDirectory(dirPath, offset, limit, token);
    return {
      nodes: result.nodes,
      totalCount: result.total,
      isComplete: !result.hasMore,
      nextOffset: Math.min(result.nextOffset, result.total),
      lastScanned: new Date()
    };
  }

  private async scanDirectory(dirPath: string, offset: number, limit: number, token?: vscode.CancellationToken): Promise<DirectoryScanResult> {
    const uri = dirPath.startsWith("file:") ? vscode.Uri.parse(dirPath) : vscode.Uri.file(dirPath);
    try {
      return await this.fileScanner.scanDirectoryShallow(uri, {
        offset,
        limit,
        token,
        includeDirectories: true,
        includeFiles: true
      });
    } catch (error) {
      this.diagnostics.addError(`DirectoryCache scan failed for ${dirPath}: ${(error as Error).message}`);
      this.invalidateDirectory(dirPath);
      throw wrapError(error, { dirPath, offset, limit });
    }
  }

  private resolveOptions(overrides?: CacheOptions): { enabled: boolean; options: Required<CacheOptions> } {
    const config = vscode.workspace.getConfiguration("codeIngest");
    const enabled = config.get<boolean>("directoryCache.enabled", true);

    const option: Required<CacheOptions> = {
      maxEntries: overrides?.maxEntries ?? config.get<number>("directoryCache.maxEntries", DEFAULT_MAX_ENTRIES),
      ttlMs: overrides?.ttlMs ?? config.get<number>("directoryCache.ttlMs", DEFAULT_TTL),
      pageSize: overrides?.pageSize ?? config.get<number>("directoryCache.pageSize", DEFAULT_PAGE_SIZE),
      autoRefresh: overrides?.autoRefresh ?? config.get<boolean>("directoryCache.autoRefresh", DEFAULT_AUTO_REFRESH),
      maxMemoryMb: overrides?.maxMemoryMb ?? config.get<number>("directoryCache.maxMemoryMb", DEFAULT_MAX_MEMORY_MB)
    };

    return { enabled, options: option };
  }

  private applyConfiguration(): void {
    const { enabled, options } = this.resolveOptions();
    this.enabled = enabled;
    this.options = options;

    if (!this.enabled) {
      this.clearCache();
    }

    if (this.enabled && this.options.autoRefresh && !this.workspaceWatcher) {
      this.initializeWatcher();
    } else if ((!this.enabled || !this.options.autoRefresh) && this.workspaceWatcher) {
      this.workspaceWatcher.dispose();
      this.workspaceWatcher = undefined;
    }

    this.evictIfNeeded();
  }

  private initializeWatcher(): void {
    if (this.workspaceWatcher || this.workspaceUri.scheme !== "file") {
      return;
    }

    const pattern = new vscode.RelativePattern(this.workspaceUri, "**/*");
    this.workspaceWatcher = vscode.workspace.createFileSystemWatcher(pattern, false, false, false);

    const handler = (uri: vscode.Uri) => {
      const targetPath = uri.fsPath;
      if (this.has(targetPath)) {
        this.scheduleInvalidation(targetPath);
      }

      const parentPath = path.dirname(targetPath);
      if (parentPath && parentPath !== targetPath) {
        this.scheduleInvalidation(parentPath);
      }
    };

    this.workspaceWatcher.onDidChange(handler, undefined, this.disposables);
    this.workspaceWatcher.onDidCreate(handler, undefined, this.disposables);
    this.workspaceWatcher.onDidDelete(handler, undefined, this.disposables);
  }

  private scheduleInvalidation(dirPath: string): void {
    const key = this.normalizePath(dirPath);
    if (this.pendingInvalidations.has(key)) {
      return;
    }

    const timeout = setTimeout(async () => {
      this.pendingInvalidations.delete(key);
      if (!this.enabled) {
        return;
      }

      this.invalidateDirectory(key);

      if (this.options.autoRefresh) {
        try {
          await this.populateSegment(key, 0, this.options.pageSize);
        } catch (error) {
          this.diagnostics.addWarning?.(`DirectoryCache auto-refresh failed for ${key}: ${(error as Error).message}`);
        }
      }
    }, INVALIDATION_DEBOUNCE_MS);

    this.pendingInvalidations.set(key, timeout);
  }

  private scheduleCleanupTimer(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }

    this.cleanupTimer = setInterval(() => {
      this.cleanupExpiredEntries();
    }, CLEANUP_INTERVAL_MS);
  }

  private cleanupExpiredEntries(): void {
    const now = Date.now();
    for (const [key, node] of this.cache.entries()) {
      if (node.expiresAt <= now) {
        this.removeEntry(key, node);
      }
    }
    this.stats.lastCleanup = now;
  }

  private evictIfNeeded(): void {
    const maxEntries = Math.max(1, this.options.maxEntries);
    const maxMemoryBytes = Math.max(1, this.options.maxMemoryMb * 1024 * 1024);

    while (this.cache.size > maxEntries || this.stats.memoryBytes > maxMemoryBytes) {
      const oldestKey = this.cache.keys().next().value as string | undefined;
      if (!oldestKey) {
        break;
      }
      const oldest = this.cache.get(oldestKey);
      if (!oldest) {
        this.cache.delete(oldestKey);
        continue;
      }
      this.removeEntry(oldestKey, oldest, false);
      this.stats.evictions += 1;
    }
  }

  private removeEntry(key: string, node: CacheNode, updateStats = true): void {
    this.cache.delete(key);
    if (updateStats) {
      this.stats.evictions += 1;
    }
    this.stats.memoryBytes = Math.max(0, this.stats.memoryBytes - node.sizeEstimate);
  }

  private normalizePath(dirPath: string): string {
    if (dirPath.startsWith("file:")) {
      return vscode.Uri.parse(dirPath).fsPath;
    }
    return path.normalize(dirPath);
  }

  private isRangeLoaded(entry: DirectoryEntry, offset: number, limit: number): boolean {
    if (limit <= 0) {
      return true;
    }
    const end = Math.min(offset + limit, entry.totalCount);
    for (let index = offset; index < end; index += 1) {
      if (!entry.nodes[index]) {
        return false;
      }
    }
    return true;
  }

  private collectRange(entry: DirectoryEntry, offset: number, limit: number): FileNode[] {
    if (limit <= 0) {
      return [];
    }
    const end = Math.min(offset + limit, entry.totalCount);
    const collected: FileNode[] = [];
    for (let index = offset; index < end; index += 1) {
      const node = entry.nodes[index];
      if (node) {
        collected.push(node);
      }
    }
    return collected;
  }

  private getNextContiguousOffset(nodes: Array<FileNode | undefined>): number {
    let index = 0;
    while (index < nodes.length && nodes[index]) {
      index += 1;
    }
    return index;
  }

  private toPageResult(entry: DirectoryEntry, offset: number, limit: number): DirectoryEntry {
    return {
      nodes: this.collectRange(entry, offset, limit),
      totalCount: entry.totalCount,
      isComplete: entry.isComplete,
      nextOffset: entry.nextOffset,
      lastScanned: entry.lastScanned
    };
  }

  private estimateEntrySize(entry: DirectoryEntry): number {
    const json = JSON.stringify(entry);
    return Buffer.byteLength(json, "utf8");
  }
}
