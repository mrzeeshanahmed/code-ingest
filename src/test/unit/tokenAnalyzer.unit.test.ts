import { describe, expect, it, jest } from "@jest/globals";

import type { TokenizationAdapter } from "../../services/tokenAnalyzer";
import { TokenAnalyzer } from "../../services/tokenAnalyzer";

describe("TokenAnalyzer", () => {
  function createAdapter({
    name,
    available = true,
    maxTokens,
    estimate
  }: {
    name: string;
    available?: boolean;
    maxTokens?: number;
    estimate?: (content: string) => Promise<number> | number;
  }): jest.Mocked<TokenizationAdapter> {
    return {
      getName: jest.fn(() => name),
      isAvailable: jest.fn(() => available),
      getMaxTokens: jest.fn(() => maxTokens),
      estimateTokens: jest.fn((content: string) => Promise.resolve(estimate ? estimate(content) : content.length)),
      warmup: jest.fn()
    } as unknown as jest.Mocked<TokenizationAdapter>;
  }

  function createAnalyzer(adapters: jest.Mocked<TokenizationAdapter>[], partialConfig: Partial<ConstructorParameters<typeof TokenAnalyzer>[0]> = {}) {
    return new TokenAnalyzer({ includeDefaultAdapters: false, adapters, ...partialConfig });
  }

  it("selects preferred adapters before others", async () => {
    const primary = createAdapter({ name: "primary" });
    const fallback = createAdapter({ name: "fallback" });
    const analyzer = new TokenAnalyzer({ includeDefaultAdapters: false, adapters: [primary, fallback], preferredAdapters: ["fallback"] });

    await analyzer.analyze("hello world", { preferredAdapters: ["fallback"] });

    expect(fallback.estimateTokens).toHaveBeenCalled();
    expect(primary.estimateTokens).not.toHaveBeenCalled();
  });

  it("falls back to secondary adapter when primary fails", async () => {
    const failing = createAdapter({
      name: "unstable",
      estimate: () => {
        throw new Error("boom");
      }
    });
    const stable = createAdapter({ name: "stable", estimate: (content) => content.length / 2 });
    const analyzer = createAnalyzer([failing, stable]);

    const analysis = await analyzer.analyze("fallback expected");

    expect(stable.estimateTokens).toHaveBeenCalled();
    expect(analysis.adapter).toBe("stable");
  });

  it("caches results unless skipCache is provided", async () => {
    const adapter = createAdapter({ name: "cacheable" });
    const analyzer = createAnalyzer([adapter]);

    const first = await analyzer.analyze("cache me");
    const second = await analyzer.analyze("cache me");
    const third = await analyzer.analyze("cache me", { skipCache: true });

    expect(first.cacheHit).toBe(false);
    expect(second.cacheHit).toBe(true);
    expect(third.cacheHit).toBe(false);
    expect(adapter.estimateTokens).toHaveBeenCalledTimes(2);
  });

  it("enforces token budgets and surfaces warnings", async () => {
    const adapter = createAdapter({ name: "budget", estimate: () => 1200 });
    const analyzer = createAnalyzer([adapter], {
      maxTokens: 1_000,
      warnThreshold: 800,
      warnRatio: 0.8,
      failOnBudget: false
    });

    const analysis = await analyzer.analyze("budget test", { budget: { limit: 1_000, warnAt: 900 } });

    expect(analysis.warnings).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/near the budget/i),
        expect.stringMatching(/exceeds the budget/i)
      ])
    );
    expect(analysis.exceededBudget).toBe(true);
  });

  it("throws when failOnExceed is set", async () => {
    const adapter = createAdapter({ name: "strict", estimate: () => 1500 });
    const analyzer = createAnalyzer([adapter]);

    await expect(
      analyzer.analyze("strict", {
        budget: {
          limit: 500,
          failOnExceed: true
        }
      })
    ).rejects.toThrow(/exceeds the budget/i);
  });

  it("analyzes batches respecting concurrency", async () => {
    const adapter = createAdapter({ name: "batch" });
    const analyzer = createAnalyzer([adapter]);

    const analyses = await analyzer.analyzeBatch(["one", "two", "three"], { concurrency: 2 });

    expect(analyses).toHaveLength(3);
    expect(adapter.estimateTokens).toHaveBeenCalledTimes(3);
  });

  it("propagates metadata into analysis results", async () => {
    const adapter = createAdapter({ name: "meta" });
    const analyzer = createAnalyzer([adapter]);

    const metadata = { id: "123", source: "unit-test" };
    const analysis = await analyzer.analyze("metadata", { metadata });

    expect(analysis.metadata).toEqual(metadata);
  });

  it("clears cache entries when requested", async () => {
    const adapter = createAdapter({ name: "cache" });
    const analyzer = createAnalyzer([adapter]);

    await analyzer.analyze("lorem");
    analyzer.clearCache();
    await analyzer.analyze("lorem");

    expect(adapter.estimateTokens).toHaveBeenCalledTimes(2);
  });

  it("provides formatted token helpers", () => {
    expect(TokenAnalyzer.formatTokens(999)).toBe("999 tokens");
    expect(TokenAnalyzer.formatTokens(12_300)).toBe("12.3k tokens");
    expect(TokenAnalyzer.warnIfExceedsLimit(1_500, 1_000)).toMatch(/exceeds/);
    expect(TokenAnalyzer.estimate("hello world")).toBeGreaterThan(0);
  });

  it("skips unavailable adapters and throws when none succeed", async () => {
    const unavailable = createAdapter({ name: "offline", available: false });
    const failing = createAdapter({
      name: "failing",
      estimate: () => {
        throw new Error("nope");
      }
    });
    const analyzer = createAnalyzer([unavailable, failing]);

    await expect(analyzer.analyze("will fail")).rejects.toThrow(/nope/i);
  });

  it("supports preferred adapter configuration at construction time", async () => {
    const low = createAdapter({ name: "low", estimate: () => 1 });
    const high = createAdapter({ name: "high", estimate: () => 100 });

    const analyzer = new TokenAnalyzer({ includeDefaultAdapters: false, adapters: [low, high], preferredAdapters: ["high"] });
    const analysis = await analyzer.analyze("abcdefghij");

    expect(analysis.adapter).toBe("high");
  });

  it("records cache metadata on hits and misses", async () => {
    const adapter = createAdapter({ name: "cache-metadata" });
    const analyzer = createAnalyzer([adapter]);

    const first = await analyzer.analyze("cache state");
    const second = await analyzer.analyze("cache state");

    expect(first.cacheHit).toBe(false);
    expect(second.cacheHit).toBe(true);
  });
});