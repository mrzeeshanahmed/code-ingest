import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { deflate as zlibDeflate, inflate as zlibInflate, type ZlibOptions } from "node:zlib";
import * as vscode from "vscode";

import { wrapError } from "../utils/errorHandling";
import type { DigestResult } from "./digestGenerator";
import type { ProcessedContent } from "./contentProcessor";
import type { TokenAnalysis } from "./tokenAnalyzer";

const FIVE_MINUTES_SEC = 5 * 60;
const BYTES_PER_MB = 1024 * 1024;
const DEFAULT_CLEANUP_INTERVAL_MS = 60_000;
const DEFAULT_MAX_ENTRIES = 100;
const DEFAULT_MAX_MEMORY_MB = 50;
const DEFAULT_COMPRESSION_THRESHOLD_BYTES = 8 * 1024;
const DEFAULT_DISK_SYNC_DELAY_MS = 2_500;

const toUint8Array = (buffer: Buffer): Uint8Array => new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);

const deflateAsync = (data: Buffer, options: ZlibOptions): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    zlibDeflate(toUint8Array(data), options, (error, result) => {
      if (error) {
        reject(error);
      } else {
        resolve(result as Buffer);
      }
    });
  });

const inflateAsync = (data: Buffer): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    zlibInflate(toUint8Array(data), (error, result) => {
      if (error) {
        reject(error);
      } else {
        resolve(result as Buffer);
      }
    });
  });

export interface CacheEntry<T> {
  key: string;
  data: T;
  timestamp: Date;
  ttl: number;
  size: number;
  accessCount: number;
  lastAccessed: Date;
}

export interface CacheOptions {
  ttl?: number;
  maxEntries?: number;
  maxMemoryMB?: number;
  persistToDisk?: boolean;
  compressionEnabled?: boolean;
}

export interface CacheStats {
  totalEntries: number;
  memoryUsageMB: number;
  hitRate: number;
  missRate: number;
  evictionCount: number;
  oldestEntry?: Date | undefined;
  newestEntry?: Date | undefined;
}

export interface DiskCacheOptions {
  cacheDirectory: string;
  enableCompression: boolean;
  maxDiskSizeMB: number;
  syncFrequency: "immediate" | "batched" | "manual";
}

export interface CacheServiceConfig {
  defaultOptions?: CacheOptions;
  diskOptions?: DiskCacheOptions;
  cleanupIntervalMs?: number;
  hashFunction?: (payload: unknown) => string;
}

export interface CacheServiceDependencies {
  workspace?: typeof vscode.workspace;
}

interface NormalizedOptions {
  ttlMs: number;
  maxEntries: number;
  maxMemoryBytes: number;
  persistToDisk: boolean;
  compressionEnabled: boolean;
  compressionLevel: number;
}

interface InternalEntry {
  key: string;
  hash: string;
  createdAt: number;
  lastAccessed: number;
  ttlMs: number;
  size: number;
  accessCount: number;
  persist: boolean;
  compression: "none" | "deflate";
  value?: unknown;
  serialized?: string;
  compressed?: Buffer;
}

interface SerializedEntry {
  key: string;
  hash: string;
  createdAt: number;
  lastAccessed: number;
  ttlMs: number;
  accessCount: number;
  persist: boolean;
  compression: "none" | "deflate";
  size: number;
  serialized?: string;
  compressed?: string;
}

/**
 * CacheService provides intelligent caching with TTL, LRU eviction, optional disk persistence,
 * and helper methods tailored for the Code Ingest pipeline.
 */
export class CacheService {
  private readonly workspace: typeof vscode.workspace;

  private readonly enabled: boolean;

  private readonly entries = new Map<string, InternalEntry>();

  private readonly cleanupIntervalMs: number;

  private readonly defaultOptions: NormalizedOptions;

  private readonly diskOptions: DiskCacheOptions | undefined;

  private readonly diskPersistenceEnabled: boolean;

  private readonly hashFn: (payload: unknown) => string;

  private readonly compressionThresholdBytes = DEFAULT_COMPRESSION_THRESHOLD_BYTES;

  private readonly restorePromise: Promise<void>;

  private cleanupTimer: NodeJS.Timeout | null = null;

  private pendingDiskFlush: NodeJS.Timeout | null = null;

  private totalMemoryBytes = 0;

  private hitCount = 0;

  private missCount = 0;

  private evictionCount = 0;

  private disposed = false;

  public constructor(config: CacheServiceConfig = {}, deps: CacheServiceDependencies = {}) {
    this.workspace = deps.workspace ?? vscode.workspace;

    const configuration = this.workspace.getConfiguration?.("codeIngest");
    const enabledFromConfig = configuration?.get<boolean>("cache.enabled", true) ?? true;
    this.enabled = enabledFromConfig;

    const compressionLevelConfig = configuration?.get<number>("cache.compressionLevel", 6) ?? 6;
    const sanitizedCompressionLevel = Math.min(Math.max(Math.floor(compressionLevelConfig), 0), 9);

    const baseDefaults: NormalizedOptions = {
      ttlMs: FIVE_MINUTES_SEC * 1000,
      maxEntries: DEFAULT_MAX_ENTRIES,
      maxMemoryBytes: DEFAULT_MAX_MEMORY_MB * BYTES_PER_MB,
      persistToDisk: configuration?.get<boolean>("cache.persistToDisk", false) ?? false,
      compressionEnabled: sanitizedCompressionLevel > 0,
      compressionLevel: sanitizedCompressionLevel
    };

    this.defaultOptions = this.applyDefaultOverrides(baseDefaults, config.defaultOptions);

    this.cleanupIntervalMs = config.cleanupIntervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS;
    this.diskOptions = config.diskOptions;
    this.diskPersistenceEnabled = this.defaultOptions.persistToDisk || Boolean(this.diskOptions);

    this.hashFn = config.hashFunction ?? ((payload: unknown) => {
      const serialized = typeof payload === "string" ? payload : JSON.stringify(payload ?? null);
      const hash = createHash("sha1");
      hash.update(serialized);
      return hash.digest("hex");
    });

    if (this.enabled && this.cleanupIntervalMs > 0) {
      this.cleanupTimer = setInterval(() => {
        void this.cleanupExpired().catch((error) => {
          const wrapped = wrapError(error, { scope: "cacheService", operation: "cleanup" });
          console.warn(wrapped.message);
        });
      }, this.cleanupIntervalMs);
      this.cleanupTimer.unref?.();
    }

    this.restorePromise = this.enabled && this.diskPersistenceEnabled ? this.restoreFromDisk() : Promise.resolve();
  }

  /**
   * Disposes timers and flushes pending disk writes.
   */
  public async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    if (this.pendingDiskFlush) {
      clearTimeout(this.pendingDiskFlush);
      this.pendingDiskFlush = null;
    }
    if (this.diskPersistenceEnabled) {
      await this.flushToDisk();
    }
  }

  /**
   * Stores data in the cache for the provided key.
   */
  public async set<T>(key: string, data: T, options?: CacheOptions): Promise<boolean> {
    if (!this.enabled || this.disposed) {
      return false;
    }

    await this.restorePromise;

    try {
      const normalized = this.mergeOptions(options);
      const now = Date.now();

      const existing = this.entries.get(key);
      if (existing) {
        this.removeInternal(existing, false);
        this.entries.delete(key);
      }

      const prepared = await this.prepareStorage(data, normalized);

      const entry: InternalEntry = {
        key,
        hash: this.hashFn(prepared.serialized),
        createdAt: now,
        lastAccessed: now,
        ttlMs: normalized.ttlMs,
        size: prepared.size,
        accessCount: 0,
        persist: normalized.persistToDisk,
        compression: prepared.compression
      };

      if (prepared.compression === "none") {
        entry.serialized = prepared.serialized;
        entry.value = data;
      } else {
        entry.compressed = prepared.compressed!;
      }

      this.entries.set(key, entry);
      this.totalMemoryBytes += entry.size;
      this.touch(key, entry);

      await this.enforceLimits(normalized);

      if (entry.persist && this.diskPersistenceEnabled) {
        this.scheduleDiskFlush();
      }

      return true;
    } catch (error) {
      const wrapped = wrapError(error, { scope: "cacheService", operation: "set", key });
      console.warn(wrapped.message);
      return false;
    }
  }

  /**
   * Retrieves cached data for the given key.
   */
  public async get<T>(key: string): Promise<T | null> {
    if (!this.enabled || this.disposed) {
      return null;
    }

    await this.restorePromise;

    const entry = this.entries.get(key);
    if (!entry) {
      this.missCount += 1;
      return null;
    }

    const now = Date.now();
    if (this.isExpired(entry, now)) {
      this.entries.delete(key);
      this.removeInternal(entry, true);
      this.missCount += 1;
      return null;
    }

    try {
      const value = await this.hydrateEntry<T>(entry);
      entry.accessCount += 1;
      entry.lastAccessed = now;
      this.touch(key, entry);
      this.hitCount += 1;
      return value;
    } catch (error) {
      const wrapped = wrapError(error, { scope: "cacheService", operation: "get", key });
      console.warn(wrapped.message);
      this.entries.delete(key);
      this.removeInternal(entry, true);
      this.missCount += 1;
      return null;
    }
  }

  /**
   * Determines if an entry exists without updating usage statistics.
   */
  public has(key: string): boolean {
    const entry = this.entries.get(key);
    if (!entry) {
      return false;
    }
    if (this.isExpired(entry, Date.now())) {
      this.entries.delete(key);
      this.removeInternal(entry, true);
      return false;
    }
    return true;
  }

  /**
   * Deletes a single entry.
   */
  public async delete(key: string): Promise<boolean> {
    await this.restorePromise;
    const entry = this.entries.get(key);
    if (!entry) {
      return false;
    }
    this.entries.delete(key);
    this.removeInternal(entry, false);
    if (entry.persist && this.diskPersistenceEnabled) {
      this.scheduleDiskFlush();
    }
    return true;
  }

  /**
   * Clears all cache entries.
   */
  public async clear(): Promise<void> {
    await this.restorePromise;
    for (const entry of this.entries.values()) {
      this.removeInternal(entry, false);
    }
    this.entries.clear();
    this.totalMemoryBytes = 0;
    this.hitCount = 0;
    this.missCount = 0;
    this.evictionCount = 0;
    if (this.diskPersistenceEnabled) {
      await this.deleteDiskSnapshot();
    }
  }

  /**
   * Returns active cache keys in LRU order.
   */
  public keys(): string[] {
    return Array.from(this.entries.keys());
  }

  /**
   * Reports aggregated cache statistics.
   */
  public stats(): CacheStats {
    const totalEntries = this.entries.size;
    const totalAccesses = this.hitCount + this.missCount;
    const memoryUsageMB = this.totalMemoryBytes / BYTES_PER_MB;

    let oldest: Date | undefined;
    let newest: Date | undefined;

    for (const entry of this.entries.values()) {
      const created = new Date(entry.createdAt);
      if (!oldest || created < oldest) {
        oldest = created;
      }
      if (!newest || created > newest) {
        newest = created;
      }
    }

    const stats: CacheStats = {
      totalEntries,
      memoryUsageMB,
      hitRate: totalAccesses === 0 ? 0 : this.hitCount / totalAccesses,
      missRate: totalAccesses === 0 ? 0 : this.missCount / totalAccesses,
      evictionCount: this.evictionCount
    };

    if (oldest) {
      stats.oldestEntry = oldest;
    }
    if (newest) {
      stats.newestEntry = newest;
    }

    return stats;
  }

  /**
   * Caches a digest result for a workspace key.
   */
  public cacheDigest(workspaceKey: string, digest: DigestResult, ttlSeconds?: number): Promise<boolean> {
    const options = typeof ttlSeconds === "number" ? { ttl: ttlSeconds } : undefined;
    return this.set(this.composeDigestKey(workspaceKey), digest, options);
  }

  /**
   * Retrieves a cached digest if present.
   */
  public getCachedDigest(workspaceKey: string): Promise<DigestResult | null> {
    return this.get<DigestResult>(this.composeDigestKey(workspaceKey));
  }

  /**
   * Caches processed content for a file URI.
   */
  public cacheProcessedContent(fileUri: string, content: ProcessedContent): Promise<boolean> {
    return this.set(this.composeContentKey(fileUri), content);
  }

  /**
   * Retrieves cached processed content.
   */
  public getCachedProcessedContent(fileUri: string): Promise<ProcessedContent | null> {
    return this.get<ProcessedContent>(this.composeContentKey(fileUri));
  }

  /**
   * Caches token analysis results by hash.
   */
  public cacheTokenAnalysis(contentHash: string, analysis: TokenAnalysis): Promise<boolean> {
    return this.set(this.composeTokenKey(contentHash), analysis);
  }

  /**
   * Retrieves cached token analysis.
   */
  public getCachedTokenAnalysis(contentHash: string): Promise<TokenAnalysis | null> {
    return this.get<TokenAnalysis>(this.composeTokenKey(contentHash));
  }

  /**
   * Forces a disk snapshot immediately.
   */
  public async flushToDisk(): Promise<void> {
    if (!this.diskPersistenceEnabled) {
      return;
    }

    await this.restorePromise;

    try {
      const directory = await this.ensureDiskDirectory();
      const entries = await this.serializeSnapshot();
      const payload = JSON.stringify({ version: 1, entries });
      let buffer = Buffer.from(payload, "utf8");
      if (this.diskOptions?.enableCompression) {
        buffer = await deflateAsync(buffer, { level: this.defaultOptions.compressionLevel });
      }
      const maxBytes = (this.diskOptions?.maxDiskSizeMB ?? 128) * BYTES_PER_MB;
      if (buffer.byteLength > maxBytes) {
        throw new Error("Cache snapshot exceeds configured disk budget");
      }
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, "cache.bin"), toUint8Array(buffer));
    } catch (error) {
      const wrapped = wrapError(error, { scope: "cacheService", operation: "flushToDisk" });
      console.warn(wrapped.message);
    }
  }

  private applyDefaultOverrides(base: NormalizedOptions, overrides?: CacheOptions): NormalizedOptions {
    if (!overrides) {
      return { ...base };
    }

    const merged: NormalizedOptions = { ...base };

    if (typeof overrides.ttl === "number") {
      merged.ttlMs = Math.max(1, Math.floor(overrides.ttl)) * 1000;
    }
    if (typeof overrides.maxEntries === "number") {
      merged.maxEntries = Math.max(1, Math.floor(overrides.maxEntries));
    }
    if (typeof overrides.maxMemoryMB === "number") {
      merged.maxMemoryBytes = Math.max(1, overrides.maxMemoryMB) * BYTES_PER_MB;
    }
    if (typeof overrides.persistToDisk === "boolean") {
      merged.persistToDisk = overrides.persistToDisk;
    }
    if (typeof overrides.compressionEnabled === "boolean") {
      merged.compressionEnabled = overrides.compressionEnabled;
    }

    return merged;
  }

  private mergeOptions(options?: CacheOptions): NormalizedOptions {
    const merged: NormalizedOptions = { ...this.defaultOptions };
    if (!options) {
      return merged;
    }
    if (typeof options.ttl === "number") {
      merged.ttlMs = Math.max(1, Math.floor(options.ttl)) * 1000;
    }
    if (typeof options.maxEntries === "number") {
      merged.maxEntries = Math.max(1, Math.floor(options.maxEntries));
    }
    if (typeof options.maxMemoryMB === "number") {
      merged.maxMemoryBytes = Math.max(1, options.maxMemoryMB) * BYTES_PER_MB;
    }
    if (typeof options.persistToDisk === "boolean") {
      merged.persistToDisk = options.persistToDisk;
    }
    if (typeof options.compressionEnabled === "boolean") {
      merged.compressionEnabled = options.compressionEnabled;
    }
    return merged;
  }

  private touch(key: string, entry: InternalEntry): void {
    this.entries.delete(key);
    this.entries.set(key, entry);
  }

  private async enforceLimits(options: NormalizedOptions): Promise<void> {
    const maxEntries = Math.min(options.maxEntries, this.defaultOptions.maxEntries);
    const maxMemoryBytes = Math.min(options.maxMemoryBytes, this.defaultOptions.maxMemoryBytes);

    while (this.entries.size > maxEntries || this.totalMemoryBytes > maxMemoryBytes) {
      const lruKey = this.entries.keys().next().value as string | undefined;
      if (!lruKey) {
        break;
      }
      const lruEntry = this.entries.get(lruKey);
      if (!lruEntry) {
        this.entries.delete(lruKey);
        continue;
      }
      this.entries.delete(lruKey);
      this.removeInternal(lruEntry, true);
      this.evictionCount += 1;
    }
  }

  private removeInternal(entry: InternalEntry, evicted: boolean): void {
    this.totalMemoryBytes -= entry.size;
    if (this.totalMemoryBytes < 0) {
      this.totalMemoryBytes = 0;
    }
    if (evicted && entry.persist && this.diskPersistenceEnabled) {
      this.scheduleDiskFlush();
    }
  }

  private isExpired(entry: InternalEntry, now: number): boolean {
    if (now <= entry.createdAt + entry.ttlMs) {
      return false;
    }
    const graceMs = Math.min(entry.ttlMs * 0.1, 30_000);
    return now - entry.lastAccessed > graceMs;
  }

  private async hydrateEntry<T>(entry: InternalEntry): Promise<T> {
    if (entry.compression === "none") {
      if (entry.value !== undefined) {
        if (!this.validateHash(entry)) {
          throw new Error("Cache hash mismatch");
        }
        return entry.value as T;
      }
      if (entry.serialized !== undefined) {
        const parsed = JSON.parse(entry.serialized) as T;
        entry.value = parsed;
        if (!this.validateHash(entry)) {
          throw new Error("Cache hash mismatch");
        }
        return parsed;
      }
      throw new Error("Cache entry missing payload");
    }

    const compressed = entry.compressed;
    if (!compressed) {
      throw new Error("Compressed cache entry missing data");
    }
    const inflated = await inflateAsync(compressed);
    const serialized = inflated.toString("utf8");
    const parsed = JSON.parse(serialized) as T;
    entry.serialized = serialized;
    entry.value = parsed;

    if (!this.validateHash(entry)) {
      throw new Error("Cache hash mismatch");
    }

    return parsed;
  }

  private validateHash(entry: InternalEntry): boolean {
    if (entry.serialized === undefined && entry.value === undefined) {
      return false;
    }
    const serialized = entry.serialized ?? JSON.stringify(entry.value ?? null);
    const computed = this.hashFn(serialized);
    return computed === entry.hash;
  }

  private async prepareStorage(data: unknown, options: NormalizedOptions): Promise<{ serialized: string; size: number; compression: "none" | "deflate"; compressed?: Buffer }> {
    try {
      const serialized = JSON.stringify(data ?? null);
      const uncompressedSize = Buffer.byteLength(serialized, "utf8");
      if (!(options.compressionEnabled && uncompressedSize >= this.compressionThresholdBytes)) {
        return { serialized, size: uncompressedSize, compression: "none" };
      }
      const compressed = await deflateAsync(Buffer.from(serialized, "utf8"), { level: options.compressionLevel });
      return { serialized, size: compressed.byteLength, compression: "deflate", compressed };
    } catch (error) {
      throw wrapError(error, { scope: "cacheService", operation: "prepare" });
    }
  }

  private composeDigestKey(workspaceKey: string): string {
    return `digest:${workspaceKey}`;
  }

  private composeContentKey(fileUri: string): string {
    return `content:${fileUri}`;
  }

  private composeTokenKey(contentHash: string): string {
    return `tokens:${contentHash}`;
  }

  private async cleanupExpired(): Promise<void> {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (this.isExpired(entry, now)) {
        this.entries.delete(key);
        this.removeInternal(entry, true);
        this.evictionCount += 1;
      }
    }
  }

  private scheduleDiskFlush(): void {
    if (!this.diskPersistenceEnabled) {
      return;
    }

    const frequency = this.diskOptions?.syncFrequency ?? "batched";
    if (frequency === "manual") {
      return;
    }

    if (frequency === "immediate") {
      void this.flushToDisk();
      return;
    }

    if (this.pendingDiskFlush) {
      return;
    }

    this.pendingDiskFlush = setTimeout(() => {
      this.pendingDiskFlush = null;
      void this.flushToDisk();
    }, DEFAULT_DISK_SYNC_DELAY_MS);
    this.pendingDiskFlush.unref?.();
  }

  private async ensureDiskDirectory(): Promise<string> {
    if (this.diskOptions?.cacheDirectory) {
      return this.diskOptions.cacheDirectory;
    }
    const workspaceFolder = this.workspace.workspaceFolders?.[0];
    if (workspaceFolder) {
      return path.join(workspaceFolder.uri.fsPath, ".code-ingest-cache");
    }
    return path.join(process.cwd(), ".code-ingest-cache");
  }

  private async serializeSnapshot(): Promise<SerializedEntry[]> {
    const result: SerializedEntry[] = [];
    for (const entry of this.entries.values()) {
      const serializedEntry: SerializedEntry = {
        key: entry.key,
        hash: entry.hash,
        createdAt: entry.createdAt,
        lastAccessed: entry.lastAccessed,
        ttlMs: entry.ttlMs,
        accessCount: entry.accessCount,
        persist: entry.persist,
        compression: entry.compression,
        size: entry.size
      };
      if (entry.compression === "none") {
        if (entry.serialized !== undefined) {
          serializedEntry.serialized = entry.serialized;
        } else if (entry.value !== undefined) {
          serializedEntry.serialized = JSON.stringify(entry.value ?? null);
        }
      } else if (entry.compressed) {
        serializedEntry.compressed = entry.compressed.toString("base64");
      }
      result.push(serializedEntry);
    }
    return result;
  }

  private async restoreFromDisk(): Promise<void> {
    try {
      const directory = await this.ensureDiskDirectory();
      const filePath = path.join(directory, "cache.bin");
      const exists = await fs.stat(filePath).then(() => true).catch(() => false);
      if (!exists) {
        return;
      }
      let buffer = await fs.readFile(filePath);
      if (this.diskOptions?.enableCompression) {
        buffer = await inflateAsync(buffer);
      }
      const snapshot = JSON.parse(buffer.toString("utf8")) as { version: number; entries: SerializedEntry[] };
      if (!snapshot?.entries) {
        return;
      }
      for (const serialized of snapshot.entries) {
        const entry: InternalEntry = {
          key: serialized.key,
          hash: serialized.hash,
          createdAt: serialized.createdAt,
          lastAccessed: serialized.lastAccessed,
          ttlMs: serialized.ttlMs,
          size: serialized.size,
          accessCount: serialized.accessCount,
          persist: serialized.persist,
          compression: serialized.compression
        };
        if (serialized.compression === "none" && serialized.serialized) {
          entry.serialized = serialized.serialized;
        } else if (serialized.compression === "deflate" && serialized.compressed) {
          entry.compressed = Buffer.from(serialized.compressed, "base64");
        }
        this.entries.set(serialized.key, entry);
        this.totalMemoryBytes += entry.size;
      }
    } catch (error) {
      const wrapped = wrapError(error, { scope: "cacheService", operation: "restore" });
      console.warn(wrapped.message);
      this.entries.clear();
      this.totalMemoryBytes = 0;
    }
  }

  private async deleteDiskSnapshot(): Promise<void> {
    try {
      const directory = await this.ensureDiskDirectory();
      await fs.rm(path.join(directory, "cache.bin"), { force: true });
    } catch (error) {
      const wrapped = wrapError(error, { scope: "cacheService", operation: "deleteSnapshot" });
      console.warn(wrapped.message);
    }
  }
}
