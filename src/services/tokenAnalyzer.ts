import { createHash } from "crypto";
import { asyncPool } from "../utils/asyncPool";
import { wrapError } from "../utils/errorHandling";

const DEFAULT_MAX_TOKENS = 4_096;
const DEFAULT_WARN_RATIO = 0.85;
const DEFAULT_CACHE_MAX_ENTRIES = 256;
const DEFAULT_CONCURRENCY = 4;

export interface CancelToken {
  isCancelled(): boolean;
  onCancel?(callback: () => void): void;
}

export interface TokenBudgetOptions {
  /** Hard ceiling for tokens. */
  limit?: number;
  /** Explicit warning threshold; if omitted a ratio is applied. */
  warnAt?: number;
  /** Ratio applied to limit when warnAt is not supplied. */
  warnRatio?: number;
  /** Whether to throw when the budget is exceeded. */
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

type TikTokenEncoding = {
  encode(value: string): number[];
};

type TikTokenModule = {
  encoding_for_model?: (model: string) => TikTokenEncoding;
  get_encoding?: (encoding: string) => TikTokenEncoding;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export class TokenAnalyzer {
  private readonly config: NormalizedConfig;
  private readonly adapters: TokenizationAdapter[] = [];
  private readonly cache = new Map<string, CacheEntry>();
  private static readonly FALLBACK_CHARS_PER_TOKEN = 4;

  constructor(options: TokenAnalyzerConfig = {}) {
    this.config = TokenAnalyzer.normalizeConfig(options);

    const suppliedAdapters = options.adapters ?? [];
    for (const adapter of suppliedAdapters) {
      this.registerAdapter(adapter);
    }

    if (this.config.includeDefaultAdapters) {
      this.registerDefaultAdapters();
    }
  }

  public registerAdapter(adapter: TokenizationAdapter): void {
    const name = adapter.getName();
    if (!name) {
      throw new Error("Tokenization adapters must provide a non-empty name.");
    }

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
    const adapters = this.getOrderedAdapters();
    await asyncPool(
      adapters.map((adapter) => async () => {
        if (!adapter.warmup) {
          return;
        }
        try {
          await adapter.warmup();
        } catch (error) {
          throw wrapError(error, { scope: "tokenAnalyzer", adapter: adapter.getName(), stage: "warmup" });
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
    if (contents.length === 0) {
      return [];
    }

    const concurrency = options?.concurrency ?? this.config.concurrency;
    const tasks = contents.map((value) => () => this.analyze(value, options));
    return asyncPool(tasks, Math.max(1, concurrency));
  }

  public clearCache(): void {
    this.cache.clear();
  }

  private resolveAdapters(options?: AnalyzeOptions): TokenizationAdapter[] {
    const preferredNames = options?.preferredAdapters ?? this.config.preferredAdapters;
    const normalized: TokenizationAdapter[] = [];
    const seen = new Set<string>();

    if (preferredNames && preferredNames.length > 0) {
      for (const name of preferredNames) {
        const match = this.adapters.find((adapter) => adapter.getName() === name);
        if (match && !seen.has(match.getName())) {
          normalized.push(match);
          seen.add(match.getName());
        }
      }
    }

    for (const adapter of this.adapters) {
      if (!seen.has(adapter.getName())) {
        normalized.push(adapter);
        seen.add(adapter.getName());
      }
    }

    return normalized;
  }

  private getOrderedAdapters(): TokenizationAdapter[] {
    return this.resolveAdapters();
  }

  private getCacheKey(content: string, adapters: TokenizationAdapter[]): string | null {
    if (!this.config.enableCaching) {
      return null;
    }

    const hash = createHash("sha1");
    hash.update(content);
    hash.update("\0");
    for (const adapter of adapters) {
      hash.update(adapter.getName());
      hash.update("\0");
    }
    return hash.digest("hex");
  }

  private enforceCacheSize(): void {
    while (this.cache.size > this.config.cacheMaxEntries) {
      const firstKey = this.cache.keys().next().value;
      if (!firstKey) {
        break;
      }
      this.cache.delete(firstKey);
    }
  }

  private buildAnalysis(
    tokens: number,
    adapterName: string,
    cacheHit: boolean,
    options?: AnalyzeOptions,
    adapterMaxTokens?: number
  ): TokenAnalysis {
    const budget = this.resolveBudget(options?.budget, adapterMaxTokens);
    const { failOnExceed, ...publicBudget } = budget;
    const warnings: string[] = [];

    if (tokens >= publicBudget.warnAt) {
      warnings.push(
        `Estimated usage ${TokenAnalyzer.formatTokens(tokens)} is near the budget (${TokenAnalyzer.formatTokens(publicBudget.limit)}).`
      );
    }

    const exceededBudget = tokens > publicBudget.limit;
    if (exceededBudget) {
      const message = `Estimated usage ${TokenAnalyzer.formatTokens(tokens)} exceeds the budget (${TokenAnalyzer.formatTokens(publicBudget.limit)}).`;
      warnings.push(message);
      if (failOnExceed) {
        throw wrapError(new Error(message), { scope: "tokenAnalyzer", adapter: adapterName, stage: "budget" });
      }
    }

    const analysis: TokenAnalysis = {
      tokens,
      adapter: adapterName,
      cacheHit,
      exceededBudget,
      warnings,
      budget: publicBudget
    };

    if (options?.metadata) {
      analysis.metadata = { ...options.metadata };
    }

    return analysis;
  }

  private resolveBudget(budget: TokenBudgetOptions | undefined, adapterMax?: number): NormalizedBudget {
    const limit = Math.max(1, budget?.limit ?? adapterMax ?? this.config.maxTokens);
    const warnRatio = clamp(budget?.warnRatio ?? this.config.warnRatio, 0.1, 0.99);
    const warnAt = Math.max(1, budget?.warnAt ?? Math.floor(limit * warnRatio));
    return {
      limit,
      warnAt,
      warnRatio,
      failOnExceed: budget?.failOnExceed ?? this.config.failOnBudget
    };
  }

  private registerDefaultAdapters(): void {
    const tikToken = new TikTokenAdapter();
    this.registerAdapter(tikToken);
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
      preferredAdapters: options.preferredAdapters ?? [],
      includeDefaultAdapters: options.includeDefaultAdapters ?? true,
      concurrency: Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY)
    } satisfies NormalizedConfig;
  }

  public static formatTokens(tokens: number): string {
    const absTokens = Math.abs(tokens);
    if (absTokens < 1_000) {
      return `${tokens} tokens`;
    }
    if (absTokens < 1_000_000) {
      return `${TokenAnalyzer.formatWithPrecision(tokens / 1_000)}k tokens`;
    }
    if (absTokens < 1_000_000_000) {
      return `${TokenAnalyzer.formatWithPrecision(tokens / 1_000_000)}M tokens`;
    }
    return `${TokenAnalyzer.formatWithPrecision(tokens / 1_000_000_000)}B tokens`;
  }

  public static formatEstimate(tokens: number): string {
    return TokenAnalyzer.formatTokens(tokens);
  }

  public static estimate(content: string): number {
    if (!content) {
      return 0;
    }
    const tokens = Math.round(content.length / TokenAnalyzer.FALLBACK_CHARS_PER_TOKEN);
    return Math.max(0, tokens);
  }

  public static warnIfExceedsLimit(tokens: number, limit: number): string | null {
    if (tokens <= limit) {
      return null;
    }
    return `Warning: Estimated token usage (${TokenAnalyzer.formatTokens(tokens)}) exceeds the limit (${TokenAnalyzer.formatTokens(limit)}).`;
  }

  private static formatWithPrecision(value: number): string {
    const rounded = Math.round(value * 10) / 10;
    return Number.isInteger(rounded) ? `${rounded.toFixed(0)}` : `${rounded.toFixed(1)}`;
  }
}

class CharacterRatioAdapter implements TokenizationAdapter {
  private static readonly CHARS_PER_TOKEN = 4;

  public getName(): string {
    return "character-ratio";
  }

  public isAvailable(): boolean {
    return true;
  }

  public getMaxTokens(): number | undefined {
    return 100_000;
  }

  public async estimateTokens(content: string): Promise<number> {
    if (!content) {
      return 0;
    }

    const tokens = Math.round(content.length / CharacterRatioAdapter.CHARS_PER_TOKEN);
    return Math.max(0, tokens);
  }
}

class GPT3HeuristicAdapter implements TokenizationAdapter {
  private static readonly CHARS_PER_TOKEN = 3.7;

  public getName(): string {
    return "gpt3-heuristic";
  }

  public isAvailable(): boolean {
    return true;
  }

  public getMaxTokens(): number | undefined {
    return 100_000;
  }

  public async estimateTokens(content: string): Promise<number> {
    if (!content) {
      return 0;
    }

    const normalized = content.replace(/\s+/g, " ").trim();
    const punctuationAdjustment = Math.max(0, Math.ceil((content.match(/[\.,;:]/g)?.length ?? 0) / 10));
    const estimated = Math.ceil(normalized.length / GPT3HeuristicAdapter.CHARS_PER_TOKEN) + punctuationAdjustment;
    return Math.max(0, estimated);
  }
}

class TikTokenAdapter implements TokenizationAdapter {
  private encoding: TikTokenEncoding | undefined;
  private readonly encodingName: string;
  private modulePromise: Promise<TikTokenModule | undefined> | undefined;
  private available = true;

  constructor(encodingName = "cl100k_base") {
    this.encodingName = encodingName;
  }

  public getName(): string {
    return "tiktoken";
  }

  public isAvailable(): boolean {
    return this.available;
  }

  public getMaxTokens(): number | undefined {
    return 120_000;
  }

  public async warmup(): Promise<void> {
    await this.ensureEncoding();
  }

  public async estimateTokens(content: string): Promise<number> {
    try {
      await this.ensureEncoding();
    } catch (error) {
      this.available = false;
      throw error;
    }

    if (!this.encoding) {
      this.available = false;
      throw new Error("Failed to initialize TikToken encoding");
    }

    try {
      const encoded = this.encoding.encode(content ?? "");
      return encoded.length;
    } catch (error) {
      this.available = false;
      throw wrapError(error, { scope: "tokenAnalyzer", adapter: this.getName(), stage: "encode" });
    }
  }

  private async ensureEncoding(): Promise<void> {
    if (this.encoding) {
      return;
    }

    const module = await this.loadModule();
    if (!module) {
      this.available = false;
      throw new Error("TikToken module not available");
    }

    try {
      if (typeof module.encoding_for_model === "function") {
        this.encoding = module.encoding_for_model(this.encodingName);
      } else if (typeof module.get_encoding === "function") {
        this.encoding = module.get_encoding(this.encodingName);
      } else {
        throw new Error("TikToken module does not expose known encoding factories.");
      }
    } catch (error) {
      this.available = false;
      throw wrapError(error, { scope: "tokenAnalyzer", adapter: this.getName(), stage: "init" });
    }
  }

  private loadModule(): Promise<TikTokenModule | undefined> {
    if (!this.modulePromise) {
      this.modulePromise = import("@dqbd/tiktoken")
        .then((module) => module as unknown as TikTokenModule)
        .catch(() => undefined);
    }
    return this.modulePromise;
  }
}

export type TokenAnalyzerLike = Pick<TokenAnalyzer, "analyze" | "analyzeBatch"> & {
  formatTokens?(tokens: number): string;
  warnIfExceedsLimit?(tokens: number, limit: number): string | null;
};
