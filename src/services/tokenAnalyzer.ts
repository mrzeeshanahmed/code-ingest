import { createHash } from "node:crypto";
import { asyncPool } from "../utils/asyncPool";
import { wrapError } from "../utils/errorHandling";
import { TokenAdapter } from "../utils/tokenAdapter";

const DEFAULT_MAX_TOKENS = 4_096;
const DEFAULT_WARN_RATIO = 0.85;
const DEFAULT_CACHE_MAX_ENTRIES = 256;
const DEFAULT_CONCURRENCY = 4;

export interface CancelToken {
  isCancelled(): boolean;
  onCancel?(callback: () => void): void;
}

export interface TokenBudgetOptions {
  limit?: number;
  warnAt?: number;
  warnRatio?: number;
  failOnExceed?: boolean;
}

export interface AnalyzeOptions {
  budget?: TokenBudgetOptions;
  skipCache?: boolean;
  cancelToken?: CancelToken;
  preferredAdapters?: string[];
  metadata?: Record<string, unknown>;
}

export interface AnalyzeBatchOptions extends AnalyzeOptions {
  concurrency?: number;
}

export interface TokenAnalysis {
  tokens: number;
  adapter: string;
  cacheHit: boolean;
  exceededBudget: boolean;
  warnings: string[];
  budget: {
    limit: number;
    warnAt: number;
    warnRatio: number;
  };
  metadata?: Record<string, unknown>;
}

export interface TokenizationAdapter {
  getName(): string;
  isAvailable(): boolean;
  getMaxTokens(): number | undefined;
  estimateTokens(content: string): Promise<number>;
  warmup?(): Promise<void>;
}

export interface TokenAnalyzerConfig {
  maxTokens?: number;
  warnThreshold?: number;
  warnRatio?: number;
  failOnBudget?: boolean;
  enableCaching?: boolean;
  cacheMaxEntries?: number;
  preferredAdapters?: string[];
  includeDefaultAdapters?: boolean;
  adapters?: TokenizationAdapter[];
  concurrency?: number;
}

interface NormalizedConfig {
  maxTokens: number;
  warnThreshold: number;
  warnRatio: number;
  failOnBudget: boolean;
  enableCaching: boolean;
  cacheMaxEntries: number;
  preferredAdapters: string[];
  includeDefaultAdapters: boolean;
  concurrency: number;
}

interface CacheEntry {
  tokens: number;
  adapter: string;
}

type NormalizedBudget = TokenAnalysis["budget"] & { failOnExceed: boolean };

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

class HeuristicTokenAdapter implements TokenizationAdapter {
  private readonly adapter = new TokenAdapter();

  public getName(): string {
    return "internal-heuristic";
  }

  public isAvailable(): boolean {
    return true;
  }

  public getMaxTokens(): number | undefined {
    return undefined;
  }

  public async estimateTokens(content: string): Promise<number> {
    return this.adapter.estimateCount(content);
  }
}

class CharacterRatioAdapter implements TokenizationAdapter {
  public getName(): string {
    return "character-ratio";
  }

  public isAvailable(): boolean {
    return true;
  }

  public getMaxTokens(): number | undefined {
    return undefined;
  }

  public async estimateTokens(content: string): Promise<number> {
    return Math.max(1, Math.ceil(content.length / 4));
  }
}

class GPT3HeuristicAdapter implements TokenizationAdapter {
  private readonly adapter = new TokenAdapter();

  public getName(): string {
    return "gpt3-heuristic";
  }

  public isAvailable(): boolean {
    return true;
  }

  public getMaxTokens(): number | undefined {
    return 16_384;
  }

  public async estimateTokens(content: string): Promise<number> {
    return this.adapter.estimateCount(content);
  }
}

export class TokenAnalyzer {
  private readonly config: NormalizedConfig;
  private readonly adapters: TokenizationAdapter[] = [];
  private readonly cache = new Map<string, CacheEntry>();

  constructor(options: TokenAnalyzerConfig = {}) {
    this.config = TokenAnalyzer.normalizeConfig(options);

    for (const adapter of options.adapters ?? []) {
      this.registerAdapter(adapter);
    }

    if (this.config.includeDefaultAdapters) {
      this.registerDefaultAdapters();
    }
  }

  public registerAdapter(adapter: TokenizationAdapter): void {
    const name = adapter.getName();
    const existingIndex = this.adapters.findIndex((entry) => entry.getName() === name);
    if (existingIndex >= 0) {
      this.adapters.splice(existingIndex, 1, adapter);
      return;
    }

    this.adapters.push(adapter);
  }

  public removeAdapter(name: string): void {
    const index = this.adapters.findIndex((adapter) => adapter.getName() === name);
    if (index >= 0) {
      this.adapters.splice(index, 1);
    }
  }

  public listAdapters(): TokenizationAdapter[] {
    return [...this.adapters];
  }

  public async warmStartup(): Promise<void> {
    await asyncPool(
      this.getOrderedAdapters().map((adapter) => async () => {
        if (adapter.warmup) {
          await adapter.warmup();
        }
      }),
      this.config.concurrency
    );
  }

  public async analyze(content: string, options?: AnalyzeOptions): Promise<TokenAnalysis> {
    if (!content) {
      return this.buildAnalysis(0, "noop", true, options);
    }

    if (options?.cancelToken?.isCancelled()) {
      throw wrapError(new Error("Token analysis cancelled"), { scope: "tokenAnalyzer", stage: "precheck" });
    }

    const adapters = this.resolveAdapters(options);
    if (adapters.length === 0) {
      throw wrapError(new Error("No tokenization adapters available"), { scope: "tokenAnalyzer", stage: "resolve" });
    }

    const cacheKey = this.getCacheKey(content, adapters);
    if (cacheKey && !options?.skipCache) {
      const cached = this.cache.get(cacheKey);
      if (cached) {
        return this.buildAnalysis(cached.tokens, cached.adapter, true, options);
      }
    }

    let lastError: unknown;
    for (const adapter of adapters) {
      if (!adapter.isAvailable()) {
        continue;
      }

      if (options?.cancelToken?.isCancelled()) {
        throw wrapError(new Error("Token analysis cancelled"), {
          scope: "tokenAnalyzer",
          adapter: adapter.getName(),
          stage: "cancelled"
        });
      }

      try {
        const tokens = await adapter.estimateTokens(content);
        const analysis = this.buildAnalysis(tokens, adapter.getName(), false, options, adapter.getMaxTokens());

        if (cacheKey && this.config.enableCaching && !options?.skipCache) {
          this.cache.set(cacheKey, { tokens, adapter: adapter.getName() });
          this.enforceCacheSize();
        }

        return analysis;
      } catch (error) {
        lastError = wrapError(error, {
          scope: "tokenAnalyzer",
          adapter: adapter.getName(),
          stage: "estimate"
        });
      }
    }

    throw (lastError instanceof Error ? lastError : wrapError(new Error("Token estimation failed"), { scope: "tokenAnalyzer" }));
  }

  public async analyzeBatch(contents: string[], options?: AnalyzeBatchOptions): Promise<TokenAnalysis[]> {
    const concurrency = Math.max(1, options?.concurrency ?? this.config.concurrency);
    return asyncPool(
      contents.map((content) => () => this.analyze(content, options)),
      concurrency
    );
  }

  public clearCache(): void {
    this.cache.clear();
  }

  public static estimate(content: string): number {
    return new TokenAdapter().estimateCount(content);
  }

  public static formatEstimate(tokens: number): string {
    return new TokenAdapter().humanize(tokens);
  }

  private resolveAdapters(options?: AnalyzeOptions): TokenizationAdapter[] {
    const preferredNames = options?.preferredAdapters ?? this.config.preferredAdapters;
    if (!preferredNames.length) {
      return this.getOrderedAdapters();
    }

    const preferred = preferredNames
      .map((name) => this.adapters.find((adapter) => adapter.getName() === name))
      .filter((adapter): adapter is TokenizationAdapter => Boolean(adapter));

    const remainder = this.adapters.filter((adapter) => !preferred.some((entry) => entry.getName() === adapter.getName()));
    return [...preferred, ...remainder];
  }

  private getOrderedAdapters(): TokenizationAdapter[] {
    return [...this.adapters];
  }

  private getCacheKey(content: string, adapters: TokenizationAdapter[]): string | null {
    if (!this.config.enableCaching || adapters.length === 0) {
      return null;
    }

    const hash = createHash("sha1");
    hash.update(content);
    hash.update("\n");
    hash.update(adapters.map((adapter) => adapter.getName()).join(","));
    return hash.digest("hex");
  }

  private buildAnalysis(
    tokens: number,
    adapterName: string,
    cacheHit: boolean,
    options?: AnalyzeOptions,
    adapterMaxTokens?: number
  ): TokenAnalysis {
    const budget = this.normalizeBudget(options?.budget, adapterMaxTokens);
    const warnings: string[] = [];
    const exceededBudget = tokens > budget.limit;

    if (tokens >= budget.warnAt) {
      warnings.push(`Token usage approaching limit (${tokens}/${budget.limit}).`);
    }

    if (exceededBudget) {
      warnings.push(`Token budget exceeded (${tokens}/${budget.limit}).`);
      if (budget.failOnExceed) {
        throw wrapError(new Error(`Token budget exceeded (${tokens}/${budget.limit})`), {
          scope: "tokenAnalyzer",
          stage: "budget"
        });
      }
    }

    const analysis: TokenAnalysis = {
      tokens,
      adapter: adapterName,
      cacheHit,
      exceededBudget,
      warnings,
      budget: {
        limit: budget.limit,
        warnAt: budget.warnAt,
        warnRatio: budget.warnRatio
      }
    };

    if (options?.metadata) {
      analysis.metadata = { ...options.metadata };
    }

    return analysis;
  }

  private normalizeBudget(options: TokenBudgetOptions | undefined, adapterMaxTokens?: number): NormalizedBudget {
    const limit = Math.max(1, options?.limit ?? adapterMaxTokens ?? this.config.maxTokens);
    const warnRatio = clamp(options?.warnRatio ?? this.config.warnRatio, 0.1, 0.99);
    const warnAt = Math.max(1, options?.warnAt ?? this.config.warnThreshold ?? Math.floor(limit * warnRatio));
    return {
      limit,
      warnAt,
      warnRatio,
      failOnExceed: options?.failOnExceed ?? this.config.failOnBudget
    };
  }

  private enforceCacheSize(): void {
    while (this.cache.size > this.config.cacheMaxEntries) {
      const oldestKey = this.cache.keys().next().value as string | undefined;
      if (!oldestKey) {
        break;
      }
      this.cache.delete(oldestKey);
    }
  }

  private registerDefaultAdapters(): void {
    this.registerAdapter(new HeuristicTokenAdapter());
    this.registerAdapter(new GPT3HeuristicAdapter());
    this.registerAdapter(new CharacterRatioAdapter());
  }

  private static normalizeConfig(options: TokenAnalyzerConfig): NormalizedConfig {
    const maxTokens = Math.max(1, options.maxTokens ?? DEFAULT_MAX_TOKENS);
    const warnRatio = clamp(options.warnRatio ?? DEFAULT_WARN_RATIO, 0.1, 0.99);
    const warnThreshold = Math.max(1, options.warnThreshold ?? Math.floor(maxTokens * warnRatio));

    return {
      maxTokens,
      warnThreshold,
      warnRatio,
      failOnBudget: options.failOnBudget ?? false,
      enableCaching: options.enableCaching ?? true,
      cacheMaxEntries: Math.max(1, options.cacheMaxEntries ?? DEFAULT_CACHE_MAX_ENTRIES),
      preferredAdapters: [...(options.preferredAdapters ?? [])],
      includeDefaultAdapters: options.includeDefaultAdapters ?? true,
      concurrency: Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY)
    };
  }
}
