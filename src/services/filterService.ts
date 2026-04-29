import * as path from "node:path";
import { promises as fs } from "node:fs";
import { performance } from "node:perf_hooks";
import { Minimatch } from "minimatch";
import type { GitignoreService } from "./gitignoreService";

const DEFAULT_INCLUDE_PATTERNS = ["**/*"] as const;
const DEFAULT_EXCLUDE_PATTERNS = ["node_modules/**", ".git/**", "**/*.log"] as const;
const DEFAULT_CACHE_LIMIT = 256;

/**
 * Options used to control filtering behaviour for files and directories.
 */
export interface FilterOptions {
  includePatterns?: string[];
  excludePatterns?: string[];
  useGitignore?: boolean;
  followSymlinks?: boolean;
  maxDepth?: number;
  respectGlobalGitignore?: boolean;
}

/**
 * Result returned by filtering operations describing inclusion state and origin.
 */
export interface FilterResult {
  included: boolean;
  reason: "included" | "excluded" | "gitignored" | "depth-limit" | "symlink-skipped";
  matchedPattern?: string;
}

/**
 * Detailed trace step produced by {@link FilterService.explainDecision}.
 */
export interface FilterDecisionStep {
  readonly stage: "depth" | "symlink" | "include" | "exclude" | "gitignore";
  readonly outcome: "passed" | "failed";
  readonly detail?: string;
  readonly matchedPattern?: string;
}

/**
 * Structured explanation of how a decision was made for a given path.
 */
export interface FilterDecisionExplanation {
  readonly path: string;
  readonly relativePath?: string;
  readonly result: FilterResult;
  readonly steps: ReadonlyArray<FilterDecisionStep>;
}

/**
 * Collector invoked with metrics after each evaluation.
 */
export interface FilterMetricsCollector {
  recordEvaluation(data: {
    readonly path: string;
    readonly type: "file" | "directory";
    readonly durationMs: number;
    readonly result: FilterResult;
  }): void;
}

/**
 * Snapshot of persisted configuration values that influence default behaviour.
 */
export interface FilterConfigurationSnapshot {
  readonly includePatterns?: string[];
  readonly excludePatterns?: string[];
  readonly followSymlinks?: boolean;
  readonly respectGitignore?: boolean;
  readonly maxDepth?: number;
}

/**
 * Dependencies provided to {@link FilterService} during construction.
 */
export interface FilterServiceDependencies {
  readonly workspaceRoot: string;
  readonly gitignoreService?: GitignoreService;
  readonly loadConfiguration?: () => FilterConfigurationSnapshot | undefined;
  readonly logger?: (message: string, meta?: Record<string, unknown>) => void;
  readonly metrics?: FilterMetricsCollector;
  readonly maxCacheEntries?: number;
}

type PatternKind = "include" | "exclude" | "custom";

type ResolvedFilterReason = FilterResult["reason"];

interface CompiledPattern {
  readonly source: string;
  readonly type: "glob" | "regex";
  readonly matcher: (candidate: string, isDirectory: boolean) => boolean;
  readonly caseInsensitive: boolean;
  readonly anchored: boolean;
  readonly directoryOnly: boolean;
}

interface PatternCacheEntry {
  readonly pattern: CompiledPattern;
  lastUsed: number;
}

interface ResolvedOptions {
  readonly includePatterns: string[];
  readonly excludePatterns: string[];
  readonly followSymlinks: boolean;
  readonly useGitignore: boolean;
  readonly maxDepth?: number;
  readonly respectGlobalGitignore: boolean;
}

interface EvaluationContext {
  readonly options: ResolvedOptions;
  readonly include: CompiledPattern[];
  readonly exclude: CompiledPattern[];
  readonly gitignoreMap?: Map<string, boolean>;
  readonly symlinkCache: Map<string, boolean>;
}

interface EvaluationOutcome {
  readonly result: FilterResult;
  readonly trace?: FilterDecisionStep[];
}

function toPosix(relativePath: string): string {
  return relativePath.split(path.sep).join("/");
}

function sanitizePatternList(patterns: string[] | undefined, fallback: readonly string[]): string[] {
  if (!patterns || patterns.length === 0) {
    return [...fallback];
  }
  const normalized: string[] = [];
  for (const pattern of patterns) {
    if (typeof pattern !== "string") {
      continue;
    }
    const trimmed = pattern.trim();
    if (!trimmed) {
      continue;
    }
    normalized.push(trimmed);
  }
  return normalized.length > 0 ? normalized : [...fallback];
}

function isRegexPattern(pattern: string): pattern is `/${string}` {
  if (!pattern.startsWith("/") || pattern.length < 2) {
    return false;
  }
  const closingSlash = pattern.lastIndexOf("/");
  if (closingSlash <= 0) {
    return false;
  }
  const body = pattern.slice(1, closingSlash);
  const flags = pattern.slice(closingSlash + 1);
  if (body.length === 0) {
    return false;
  }
  if (!/^([a-z]*)$/.test(flags)) {
    return false;
  }
  const unescaped = body.replace(/\\\//g, "/");
  return !unescaped.includes("\n");
}

function extractRegex(pattern: string): { regex: RegExp; directoryOnly: boolean } | undefined {
  const closingSlash = pattern.lastIndexOf("/");
  if (closingSlash <= 0) {
    return undefined;
  }
  const body = pattern.slice(1, closingSlash).replace(/\\\//g, "/");
  const flags = pattern.slice(closingSlash + 1);
  const directoryOnly = body.endsWith("/");
  const normalizedBody = directoryOnly ? body.slice(0, -1) : body;
  try {
    return { regex: new RegExp(normalizedBody, flags), directoryOnly };
  } catch {
    return undefined;
  }
}

function parseCaseSensitivity(pattern: string): { pattern: string; caseInsensitive: boolean } {
  if (pattern.startsWith("(?i)")) {
    return { pattern: pattern.slice(4), caseInsensitive: true };
  }
  if (pattern.startsWith("(?-i)")) {
    return { pattern: pattern.slice(5), caseInsensitive: false };
  }
  return { pattern, caseInsensitive: false };
}

function splitRelative(relativePath: string): string[] {
  return relativePath.split("/").filter((segment) => segment.length > 0 && segment !== ".");
}

/**
 * FilterService evaluates include/exclude rules, symlink policies, depth limits,
 * and gitignore decisions for both files and directories. Callers provide the
 * workspace root through the constructor and can override behaviour via
 * {@link FilterOptions} on each call.
 */
export class FilterService {
  private readonly workspaceRoot: string;
  private readonly gitignoreService: GitignoreService | undefined;
  private readonly logger: ((message: string, meta?: Record<string, unknown>) => void) | undefined;
  private readonly metrics: FilterMetricsCollector | undefined;
  private readonly maxCacheEntries: number;
  private readonly defaults: ResolvedOptions;
  private readonly patternCache = new Map<string, PatternCacheEntry>();

  constructor(dependencies: FilterServiceDependencies) {
    this.workspaceRoot = path.resolve(dependencies.workspaceRoot);
    this.gitignoreService = dependencies.gitignoreService ?? undefined;
    this.logger = dependencies.logger ?? undefined;
    this.metrics = dependencies.metrics ?? undefined;
    this.maxCacheEntries = Math.max(1, dependencies.maxCacheEntries ?? DEFAULT_CACHE_LIMIT);
    this.defaults = this.resolveDefaultOptions(dependencies.loadConfiguration);
  }

  /**
   * Convenience wrapper retained for backwards compatibility with legacy code
   * paths. Prefer {@link batchFilter} for new call sites.
   */
  public static async filterFileList(
    filePaths: string[],
    include: string[],
    exclude: string[],
    gitignoreService: GitignoreService,
    workspaceRoot: string
  ): Promise<string[]> {
    const service = new FilterService({ workspaceRoot, gitignoreService });
    const results = await service.batchFilter(filePaths, {
      includePatterns: include,
      excludePatterns: exclude,
      useGitignore: true
    });
    return filePaths.filter((filePath) => results.get(filePath)?.included ?? false);
  }

  /**
   * Determines if the provided file path should be included according to the
   * precedence rules described in {@link FilterOptions}.
   */
  public async shouldIncludeFile(filePath: string, options: FilterOptions = {}): Promise<FilterResult> {
    const context = await this.prepareContext([filePath], options);
    const outcome = await this.evaluatePath(filePath, false, context, false);
    return outcome.result;
  }

  /**
   * Determines if a directory should be included when traversing the workspace.
   */
  public async shouldIncludeDirectory(dirPath: string, options: FilterOptions = {}): Promise<FilterResult> {
    const context = await this.prepareContext([dirPath], options);
    const outcome = await this.evaluatePath(dirPath, true, context, false);
    return outcome.result;
  }

  /**
   * Evaluates a batch of paths using shared caches and compilation results.
   */
  public async batchFilter(paths: string[], options: FilterOptions = {}): Promise<Map<string, FilterResult>> {
    const context = await this.prepareContext(paths, options);
    const results = new Map<string, FilterResult>();

    for (const filePath of paths) {
      const outcome = await this.evaluatePath(filePath, false, context, false);
      results.set(filePath, outcome.result);
    }

    return results;
  }

  /**
   * Validates that a pattern can be compiled. Returns diagnostic information
   * that can be surfaced to users for configuration errors.
   */
  public validatePattern(pattern: string): { ok: boolean; type?: "glob" | "regex"; reason?: string } {
    if (typeof pattern !== "string" || pattern.trim().length === 0) {
      return { ok: false, reason: "Pattern must be a non-empty string." };
    }
    const trimmed = pattern.trim();
    if (isRegexPattern(trimmed)) {
      const regexInfo = extractRegex(trimmed);
      if (!regexInfo) {
        return { ok: false, reason: "Invalid regular expression." };
      }
      return { ok: true, type: "regex" };
    }
    const { pattern: normalized } = parseCaseSensitivity(trimmed);
    const anchored = normalized.startsWith("/") ? normalized.slice(1) : normalized;
    try {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const _matcher = new Minimatch(anchored.length === 0 ? "**/*" : anchored, {
        dot: true,
        nocomment: true,
        matchBase: !anchored.includes("/")
      });
    } catch (error) {
      const err = error as Error;
      return { ok: false, reason: err.message };
    }
    return { ok: true, type: "glob" };
  }

  /**
   * Compiles a pattern upfront and returns the cached matcher instance.
   */
  public compilePattern(pattern: string, kind: PatternKind = "custom"): CompiledPattern {
    return this.getOrCompilePattern(pattern, kind);
  }

  /**
   * Explains how a decision was reached for a given file path.
   */
  public async explainDecision(filePath: string, options: FilterOptions = {}): Promise<FilterDecisionExplanation> {
    const context = await this.prepareContext([filePath], options);
    const outcome = await this.evaluatePath(filePath, false, context, true);
    const relative = this.toRelativePath(filePath);
    return {
      path: path.resolve(filePath),
      result: outcome.result,
      steps: outcome.trace ?? [],
      ...(relative !== undefined ? { relativePath: relative } : {})
    };
  }

  /**
   * Provides a snapshot of compiled patterns currently stored in the LRU cache.
   */
  public getCompiledPatterns(): Array<{
    readonly key: string;
    readonly source: string;
    readonly type: "glob" | "regex";
    readonly caseInsensitive: boolean;
    readonly anchored: boolean;
    readonly directoryOnly: boolean;
  }> {
    return [...this.patternCache.entries()].map(([key, entry]) => ({
      key,
      source: entry.pattern.source,
      type: entry.pattern.type,
      caseInsensitive: entry.pattern.caseInsensitive,
      anchored: entry.pattern.anchored,
      directoryOnly: entry.pattern.directoryOnly
    }));
  }

  /**
   * Clears the compiled pattern cache. Primarily useful for tests.
   */
  public clearPatternCache(): void {
    this.patternCache.clear();
  }

  private resolveDefaultOptions(
    loadConfiguration: FilterServiceDependencies["loadConfiguration"]
  ): ResolvedOptions {
    const snapshot = loadConfiguration?.();
    const include = sanitizePatternList(snapshot?.includePatterns, DEFAULT_INCLUDE_PATTERNS);
    const exclude = sanitizePatternList(snapshot?.excludePatterns, DEFAULT_EXCLUDE_PATTERNS);
    const followSymlinks = snapshot?.followSymlinks ?? false;
    const useGitignore = snapshot?.respectGitignore ?? true;
      return {
        includePatterns: include,
        excludePatterns: exclude,
        followSymlinks,
        useGitignore,
        respectGlobalGitignore: snapshot?.respectGitignore ?? false,
        ...(typeof snapshot?.maxDepth === "number" ? { maxDepth: snapshot.maxDepth } : {})
      };
  }

  private async prepareContext(paths: string[], options: FilterOptions): Promise<EvaluationContext> {
    const resolved = this.resolveOptions(options);
    const include = resolved.includePatterns.map((pattern) => this.getOrCompilePattern(pattern, "include"));
    const exclude = resolved.excludePatterns.map((pattern) => this.getOrCompilePattern(pattern, "exclude"));

    let gitignoreMap: Map<string, boolean> | undefined;
    if (resolved.useGitignore && this.gitignoreService) {
      try {
        if (typeof this.gitignoreService.isIgnoredBatch === "function") {
          gitignoreMap = await this.gitignoreService.isIgnoredBatch(paths);
        }
      } catch (error) {
        const err = error as Error;
        this.logger?.("filter.gitignore.batch.error", { message: err.message });
      }
    }

      return {
      options: resolved,
      include,
      exclude,
        symlinkCache: new Map<string, boolean>(),
        ...(gitignoreMap ? { gitignoreMap } : {})
      };
  }

  private resolveOptions(options: FilterOptions): ResolvedOptions {
    const include = sanitizePatternList(options.includePatterns, this.defaults.includePatterns);
    const exclude = sanitizePatternList(options.excludePatterns, this.defaults.excludePatterns);
    const followSymlinks = options.followSymlinks ?? this.defaults.followSymlinks;
    const useGitignore = options.useGitignore ?? this.defaults.useGitignore;
      const maxDepth = typeof options.maxDepth === "number" ? options.maxDepth : this.defaults.maxDepth;
    const respectGlobalGitignore = options.respectGlobalGitignore ?? this.defaults.respectGlobalGitignore;


      const resolved: ResolvedOptions = {
      includePatterns: include,
      excludePatterns: exclude,
      followSymlinks,
      useGitignore,
        respectGlobalGitignore,
        ...(maxDepth !== undefined ? { maxDepth } : {})
      };
      return resolved;
  }

  private async evaluatePath(
    targetPath: string,
    isDirectory: boolean,
    context: EvaluationContext,
    trace: boolean
  ): Promise<EvaluationOutcome> {
    const steps: FilterDecisionStep[] = [];
    const start = performance.now();
    const absolutePath = path.resolve(targetPath);
    const relative = this.toRelativePath(absolutePath);
    const relativeForMatch = relative ?? toPosix(path.basename(absolutePath));

    const makeResult = (included: boolean, reason: ResolvedFilterReason, matchedPattern?: string): FilterResult =>
      matchedPattern !== undefined
        ? { included, reason, matchedPattern }
        : { included, reason };

    const recordStep = (
      stage: FilterDecisionStep["stage"],
      outcome: FilterDecisionStep["outcome"],
      detail?: string,
      matchedPattern?: string
    ): void => {
      if (!trace) {
        return;
      }
      const entry: FilterDecisionStep = {
        stage,
        outcome,
        ...(detail !== undefined ? { detail } : {}),
        ...(matchedPattern !== undefined ? { matchedPattern } : {})
      };
      steps.push(entry);
    };

    const depth = this.calculateDepth(relative);
    if (typeof context.options.maxDepth === "number" && depth !== undefined && depth > context.options.maxDepth) {
      recordStep("depth", "failed", `depth ${depth} > limit ${context.options.maxDepth}`);
      return this.completeEvaluation(start, absolutePath, isDirectory, makeResult(false, "depth-limit"), steps, trace);
    }
    recordStep("depth", "passed", depth === undefined ? "outside-root" : `depth ${depth}`);

    if (!context.options.followSymlinks) {
      const isSymlink = await this.isSymlink(absolutePath, context.symlinkCache);
      if (isSymlink) {
        recordStep("symlink", "failed", "symlink skipped");
        return this.completeEvaluation(start, absolutePath, isDirectory, makeResult(false, "symlink-skipped"), steps, trace);
      }
    }
    recordStep("symlink", "passed");

    let includeMatch: string | undefined;
    if (context.include.length > 0) {
      const matched = context.include.find((pattern) => pattern.matcher(relativeForMatch, isDirectory));
      if (!matched) {
        recordStep("include", "failed", "no include pattern matched");
        return this.completeEvaluation(start, absolutePath, isDirectory, makeResult(false, "excluded"), steps, trace);
      }
      includeMatch = matched.source;
      recordStep("include", "passed", `matched ${matched.source}`, matched.source);
    } else {
      recordStep("include", "passed", "no include patterns specified");
    }

    const excludeMatch = context.exclude.find((pattern) => pattern.matcher(relativeForMatch, isDirectory));
    if (excludeMatch) {
      recordStep("exclude", "failed", `matched ${excludeMatch.source}`, excludeMatch.source);
      return this.completeEvaluation(start, absolutePath, isDirectory, makeResult(false, "excluded", excludeMatch.source), steps, trace);
    }
    recordStep("exclude", "passed");

    if (context.options.useGitignore && this.gitignoreService) {
      try {
        let ignored = context.gitignoreMap?.get(absolutePath);
        if (typeof ignored !== "boolean") {
          ignored = await this.gitignoreService.isIgnored(absolutePath);
        }
        if (ignored) {
          recordStep("gitignore", "failed", "gitignore matched");
          return this.completeEvaluation(start, absolutePath, isDirectory, makeResult(false, "gitignored"), steps, trace);
        }
        recordStep("gitignore", "passed");
      } catch (error) {
        const err = error as Error;
        this.logger?.("filter.gitignore.error", { message: err.message, path: absolutePath });
        recordStep("gitignore", "passed", "gitignore error ignored");
      }
    } else {
      recordStep("gitignore", "passed", context.options.useGitignore ? "gitignore disabled" : "gitignore skipped");
    }

    return this.completeEvaluation(start, absolutePath, isDirectory, makeResult(true, "included", includeMatch), steps, trace);
  }

  private completeEvaluation(
    start: number,
    absolutePath: string,
    isDirectory: boolean,
    result: FilterResult,
    steps: FilterDecisionStep[],
    trace: boolean
  ): EvaluationOutcome {
    const durationMs = performance.now() - start;
    this.metrics?.recordEvaluation({
      path: absolutePath,
      type: isDirectory ? "directory" : "file",
      durationMs,
      result
    });
    const outcome: EvaluationOutcome = trace ? { result, trace: steps } : { result };
    return outcome;
  }

  private calculateDepth(relativePath: string | undefined): number | undefined {
    if (!relativePath) {
      return undefined;
    }
    const segments = splitRelative(relativePath);
    return segments.length;
  }

  private toRelativePath(targetPath: string): string | undefined {
    const relative = path.relative(this.workspaceRoot, targetPath);
    if (!relative || relative.startsWith("..")) {
      return undefined;
    }
    if (relative === "") {
      return ".";
    }
    return toPosix(relative);
  }

  private async isSymlink(targetPath: string, cache: Map<string, boolean>): Promise<boolean> {
    const normalized = path.normalize(targetPath);
    if (cache.has(normalized)) {
      return cache.get(normalized) ?? false;
    }
    try {
      const stat = await fs.lstat(normalized);
      const isLink = stat.isSymbolicLink();
      cache.set(normalized, isLink);
      return isLink;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code && ["ENOENT", "ENOTDIR", "EACCES"].includes(err.code)) {
        cache.set(normalized, false);
        return false;
      }
      this.logger?.("filter.symlink.error", { message: err.message, path: normalized });
      cache.set(normalized, false);
      return false;
    }
  }

  private getOrCompilePattern(pattern: string, kind: PatternKind): CompiledPattern {
    const key = `${kind}:${pattern}`;
    const cached = this.patternCache.get(key);
    if (cached) {
      cached.lastUsed = performance.now();
      return cached.pattern;
    }

    const compiled = this.compilePatternInternal(pattern);
    this.patternCache.set(key, { pattern: compiled, lastUsed: performance.now() });
    if (this.patternCache.size > this.maxCacheEntries) {
      this.evictOldestEntry();
    }
    return compiled;
  }

  private compilePatternInternal(pattern: string): CompiledPattern {
    const trimmed = pattern.trim();
    if (isRegexPattern(trimmed)) {
      const regexInfo = extractRegex(trimmed);
      if (!regexInfo) {
        throw new Error(`Invalid regular expression: ${pattern}`);
      }
      const matcher = (candidate: string, isDirectory: boolean): boolean => {
        if (regexInfo.directoryOnly && !isDirectory) {
          return false;
        }
        return regexInfo.regex.test(candidate);
      };
      return {
        source: pattern,
        type: "regex",
        matcher,
        caseInsensitive: regexInfo.regex.ignoreCase,
        anchored: true,
        directoryOnly: regexInfo.directoryOnly
      } satisfies CompiledPattern;
    }

    const { pattern: withoutCaseFlag, caseInsensitive } = parseCaseSensitivity(trimmed);
    const anchored = withoutCaseFlag.startsWith("/");
    let normalized = anchored ? withoutCaseFlag.slice(1) : withoutCaseFlag;
    let directoryOnly = false;
    if (normalized.endsWith("/")) {
      directoryOnly = true;
      normalized = normalized.slice(0, -1);
    }
    if (normalized.length === 0) {
      normalized = "**/*";
    }

    const containsSlash = normalized.includes("/");
    const matcher = new Minimatch(normalized, {
      dot: true,
      nocomment: true,
      nocase: caseInsensitive,
      matchBase: !anchored && !containsSlash
    });

    const fn = (candidate: string, isDirectory: boolean): boolean => {
      if (directoryOnly && !isDirectory) {
        return false;
      }
      if (anchored) {
        return matcher.match(candidate);
      }
      return matcher.match(candidate);
    };

    return {
      source: pattern,
      type: "glob",
      matcher: fn,
      caseInsensitive,
      anchored,
      directoryOnly
    } satisfies CompiledPattern;
  }

  private evictOldestEntry(): void {
    let oldestKey: string | undefined;
    let oldestLastUsed = Number.POSITIVE_INFINITY;
    for (const [key, entry] of this.patternCache.entries()) {
      if (entry.lastUsed < oldestLastUsed) {
        oldestLastUsed = entry.lastUsed;
        oldestKey = key;
      }
    }
    if (oldestKey) {
      this.patternCache.delete(oldestKey);
    }
  }
}