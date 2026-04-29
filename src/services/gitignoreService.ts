import * as path from "node:path";
import { promises as fs } from "node:fs";
import type { Stats } from "node:fs";
import { Minimatch } from "minimatch";

export interface MatcherCacheEntry {
  patterns: string[];
  compiled: Minimatch[];
  lastModified: Date;
  checkPath: (relativePath: string) => boolean | undefined;
  sources: Array<{ filePath: string; mtime: number }>;
}

export interface MatcherCache {
  [dirPath: string]: MatcherCacheEntry;
}

export interface GitignoreServiceOptions {
  gitignoreFiles?: string[];
  getIgnoreFilesSetting?: () => string[] | undefined;
  maxCacheEntries?: number;
  logger?: (message: string, meta?: Record<string, unknown>) => void;
}

interface PatternInfo {
  readonly raw: string;
  readonly normalized: string;
  readonly negated: boolean;
  readonly matcher: Minimatch;
}

interface DirectoryMatchers {
  readonly entry: MatcherCacheEntry;
  readonly cacheKey: string;
}

const DEFAULT_IGNORE_FILES = [".gitignore", ".gitingestignore", ".codeingestignore"] as const;
const DEFAULT_CACHE_SIZE = 128;

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

function isNegation(line: string): boolean {
  return line.startsWith("!") && !line.startsWith("\\!");
}

function stripEscapes(input: string): string {
  return input.replace(/\\([ #!\\])/g, "$1");
}

/**
 * Service responsible for walking the filesystem hierarchy, loading gitignore-like
 * files, compiling them into minimatch matchers, and caching the results with LRU
 * eviction semantics. Consumers can query whether a given file should be ignored,
 * preload directories, or inspect the cache for diagnostics.
 */
export class GitignoreService {
  private readonly cache = new Map<string, MatcherCacheEntry>();
  private readonly logger: ((message: string, meta?: Record<string, unknown>) => void) | undefined;
  private readonly maxCacheEntries: number;
  private readonly getConfiguredIgnoreFiles: (() => string[] | undefined) | undefined;
  private readonly explicitIgnoreFiles: string[] | undefined;

  constructor(options: GitignoreServiceOptions = {}) {
    this.logger = options.logger;
    this.maxCacheEntries = Math.max(1, options.maxCacheEntries ?? DEFAULT_CACHE_SIZE);
    this.getConfiguredIgnoreFiles = options.getIgnoreFilesSetting;
    this.explicitIgnoreFiles = options.gitignoreFiles;
  }

  /**
   * Resolve the ordered list of ignore file names. Configuration can override
   * the defaults; duplicates are removed while preserving order.
   */
  private resolveIgnoreFileNames(): string[] {
    const configured = this.getConfiguredIgnoreFiles?.();
    const candidates = this.explicitIgnoreFiles ?? configured ?? DEFAULT_IGNORE_FILES;
    const seen = new Set<string>();
    const names: string[] = [];
    for (const name of candidates) {
      const trimmed = name?.trim();
      if (!trimmed) continue;
      if (!seen.has(trimmed)) {
        names.push(trimmed);
        seen.add(trimmed);
      }
    }
    return names.length > 0 ? names : [...DEFAULT_IGNORE_FILES];
  }

  /**
   * Walk from the target path up to the repository root collecting ignore files
   * (default: .gitignore & .gitingestignore). Files are returned in root-to-leaf order.
   */
  public async findGitignoreFiles(targetPath: string): Promise<string[]> {
    const ignoreFiles: string[] = [];
    const ignoreNames = this.resolveIgnoreFileNames();

    let current = await this.resolveStartDirectory(targetPath);
    const visited = new Set<string>();

    while (!visited.has(current)) {
      visited.add(current);

      for (const name of ignoreNames) {
        const candidate = path.join(current, name);
        const stat = await this.statSafe(candidate);
        if (stat?.isFile()) {
          ignoreFiles.push(candidate);
        }
      }

      const gitMarker = await this.statSafe(path.join(current, ".git"));
      if (gitMarker?.isDirectory() || gitMarker?.isFile()) {
        break;
      }

      const parent = path.dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }

    return ignoreFiles.reverse();
  }

  /**
   * Determine whether a path should be ignored by applying hierarchical gitignore rules.
   */
  public async isIgnored(filePath: string): Promise<boolean> {
    const absolutePath = path.resolve(filePath);
    const ignoreFiles = await this.findGitignoreFiles(absolutePath);
    if (ignoreFiles.length === 0) {
      return false;
    }

    const processedDirs: string[] = [];
    const seen = new Set<string>();
    for (const file of ignoreFiles) {
      const dir = path.dirname(file);
      if (!seen.has(dir)) {
        processedDirs.push(dir);
        seen.add(dir);
      }
    }

    let decision: boolean | undefined;
    for (const dir of processedDirs) {
      const matcher = await this.getDirectoryMatchers(dir);
      if (!matcher) {
        continue;
      }
      const relative = this.normalizeRelativePath(dir, absolutePath);
      if (relative === undefined) {
        continue;
      }
      const result = matcher.entry.checkPath(relative);
      if (typeof result === "boolean") {
        decision = result;
      }
    }

    return decision === true;
  }

  /**
   * Batch helper that reuses cached matchers while evaluating multiple paths.
   */
  public async isIgnoredBatch(filePaths: string[]): Promise<Map<string, boolean>> {
    const results = new Map<string, boolean>();
    for (const filePath of filePaths) {
       
      results.set(filePath, await this.isIgnored(filePath));
    }
    return results;
  }

  /**
   * Build a matcher function from gitignore content. Relative paths should be provided
   * using POSIX separators. Useful for unit tests.
   */
  public buildMatcher(gitignoreContent: string): (relativePath: string) => boolean | undefined {
    const patterns = this.compilePatterns(".", "<inline>", gitignoreContent);
    return (relativePath: string) => {
      const candidate = toPosix(relativePath);
      let decision: boolean | undefined;
      for (const pattern of patterns) {
        if (!pattern.matcher.match(candidate)) {
          continue;
        }
        decision = pattern.negated ? false : true;
      }
      return decision;
    };
  }

  /**
   * Force eager loading of ignore files for a directory.
   */
  public async preloadDirectory(dirPath: string): Promise<void> {
    await this.getDirectoryMatchers(path.resolve(dirPath));
  }

  /**
   * Remove all cached matcher entries.
   */
  public clearCache(): void {
    this.cache.clear();
  }

  /**
   * Load a gitignore file from disk. Exposed for unit tests.
   */
  public async loadIgnoreFile(filePath: string): Promise<string | undefined> {
    try {
      return await fs.readFile(filePath, "utf8");
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== "ENOENT") {
        this.logger?.("gitignore.read.error", { filePath, error: err.message });
      }
      return undefined;
    }
  }

  /**
   * Compile gitignore content into pattern metadata. Exposed for testing.
   */
  public compilePatterns(dirPath: string, fileName: string, gitignoreContent: string): PatternInfo[] {
    const baseDir = path.resolve(path.dirname(path.join(dirPath, fileName)));
    const lines = gitignoreContent.split(/\r?\n/);
    const patterns: PatternInfo[] = [];

    for (const rawLine of lines) {
      let line = rawLine;
      if (!line || line.trim().length === 0) {
        continue;
      }

      if (line.startsWith("#") && !line.startsWith("\\#")) {
        continue;
      }

      let trimmed = line.trimEnd();
      trimmed = stripEscapes(trimmed);

      let negated = false;
      if (isNegation(trimmed)) {
        negated = true;
        trimmed = trimmed.slice(1);
      }

      const cleaned = trimmed.trim();
      if (!cleaned) {
        continue;
      }

      let pattern = cleaned;
      const anchored = pattern.startsWith("/");
      if (anchored) {
        pattern = pattern.slice(1);
      }

      let directoryOnly = pattern.endsWith("/");
      if (directoryOnly) {
        pattern = pattern.slice(0, -1);
      }

      let normalized = toPosix(pattern);
      if (directoryOnly) {
        normalized = normalized.length > 0 ? `${normalized}/**` : "**";
      }

      const options: { dot: boolean; nocomment: boolean; matchBase?: boolean } = {
        dot: true,
        nocomment: true
      };

      if (!anchored && normalized.indexOf("/") === -1) {
        options.matchBase = true;
      }

      try {
        const matcher = new Minimatch(normalized, options);
        patterns.push({
          raw: negated ? `!${cleaned}` : cleaned,
          normalized,
          negated,
          matcher
        });
      } catch (error) {
        const err = error as Error;
        this.logger?.("gitignore.pattern.invalid", {
          baseDir,
          fileName,
          pattern: rawLine,
          error: err.message
        });
      }
    }

    return patterns;
  }

  /**
   * Snapshot the current matcher cache for diagnostics.
   */
  public getCacheSnapshot(): MatcherCache {
    const snapshot: MatcherCache = {};
    for (const [key, entry] of this.cache.entries()) {
      snapshot[key] = {
        patterns: [...entry.patterns],
        compiled: entry.compiled,
        lastModified: new Date(entry.lastModified.getTime()),
        checkPath: entry.checkPath,
        sources: [...entry.sources]
      };
    }
    return snapshot;
  }

  private async resolveStartDirectory(targetPath: string): Promise<string> {
    const resolved = path.resolve(targetPath);
    const stat = await this.statSafe(resolved);
    if (stat?.isDirectory()) {
      return resolved;
    }
    return path.dirname(resolved);
  }

  private async getDirectoryMatchers(dirPath: string): Promise<DirectoryMatchers | undefined> {
    const directory = path.resolve(dirPath);
    const cached = await this.tryGetCachedEntry(directory);
    if (cached) {
      return { entry: cached, cacheKey: directory };
    }

    const ignoreFiles = await this.collectIgnoreFiles(directory);
    if (ignoreFiles.length === 0) {
      return undefined;
    }

    const patterns: PatternInfo[] = [];
    const rawPatterns: string[] = [];
    const sources: Array<{ filePath: string; mtime: number }> = [];

    for (const filePath of ignoreFiles) {
      const content = await this.loadIgnoreFile(filePath);
      if (typeof content !== "string") {
        continue;
      }
      const stat = await this.statSafe(filePath);
      if (stat) {
        sources.push({ filePath, mtime: stat.mtimeMs });
      }
      const compiled = this.compilePatterns(directory, path.basename(filePath), content);
      patterns.push(...compiled);
      rawPatterns.push(...compiled.map((pattern) => pattern.raw));
    }

    const entry: MatcherCacheEntry = {
      patterns: rawPatterns,
      compiled: patterns.map((pattern) => pattern.matcher),
      lastModified: new Date(sources.reduce((acc, value) => Math.max(acc, value.mtime), 0)),
      sources,
      checkPath: (relativePath: string) => {
        const candidate = toPosix(relativePath);
        let decision: boolean | undefined;
        for (const pattern of patterns) {
          if (!pattern.matcher.match(candidate)) {
            continue;
          }
          decision = pattern.negated ? false : true;
        }
        return decision;
      }
    };

    this.storeInCache(directory, entry);
    return { entry, cacheKey: directory };
  }

  private async tryGetCachedEntry(directory: string): Promise<MatcherCacheEntry | undefined> {
    const cached = this.cache.get(directory);
    if (!cached) {
      return undefined;
    }

    const valid = await this.isCacheEntryValid(cached);
    if (!valid) {
      this.cache.delete(directory);
      return undefined;
    }

    this.touchCacheEntry(directory, cached);
    return cached;
  }

  private touchCacheEntry(directory: string, entry: MatcherCacheEntry): void {
    this.cache.delete(directory);
    this.cache.set(directory, entry);
  }

  private storeInCache(directory: string, entry: MatcherCacheEntry): void {
    this.cache.set(directory, entry);
    if (this.cache.size > this.maxCacheEntries) {
      const [firstKey] = this.cache.keys();
      if (typeof firstKey === "string") {
        this.cache.delete(firstKey);
      }
    }
  }

  private async isCacheEntryValid(entry: MatcherCacheEntry): Promise<boolean> {
    if (entry.sources.length === 0) {
      return true;
    }
    for (const source of entry.sources) {
      const stat = await this.statSafe(source.filePath);
      if (!stat || stat.mtimeMs !== source.mtime) {
        return false;
      }
    }
    return true;
  }

  private async collectIgnoreFiles(directory: string): Promise<string[]> {
    const ignoreNames = this.resolveIgnoreFileNames();
    const files: string[] = [];
    for (const name of ignoreNames) {
      const candidate = path.join(directory, name);
      const stat = await this.statSafe(candidate);
      if (stat?.isFile()) {
        files.push(candidate);
      }
    }
    return files;
  }

  private normalizeRelativePath(baseDir: string, filePath: string): string | undefined {
    const relative = path.relative(baseDir, filePath);
    if (!relative || relative.startsWith("..")) {
      return undefined;
    }
    return toPosix(relative === "" ? "./" : relative);
  }

  private async statSafe(targetPath: string): Promise<Stats | undefined> {
    try {
      return await fs.stat(targetPath);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code && ["ENOENT", "ENOTDIR", "EACCES"].includes(err.code)) {
        return undefined;
      }
      this.logger?.("gitignore.stat.error", { targetPath, error: err.message });
      return undefined;
    }
  }
}
