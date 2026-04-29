import { describe, expect, it, jest } from "@jest/globals";
import {
  TokenAnalyzer,
  type TokenizationAdapter,
  type TokenAnalysis
} from "../services/tokenAnalyzer";

class StubAdapter implements TokenizationAdapter {
  public constructor(private readonly name: string, private readonly estimator: (content: string) => number, private readonly available = true) {}

  getName(): string {
    return this.name;
  }

  isAvailable(): boolean {
    return this.available;
  }

  getMaxTokens(): number | undefined {
    return 10_000;
  }

  async estimateTokens(content: string): Promise<number> {
    return this.estimator(content);
  }
}

describe("TokenAnalyzer", () => {
  it("uses custom adapter and caches results", async () => {
    const adapter = new StubAdapter("words", (content) => content.trim().split(/\s+/).length);
    const analyzer = new TokenAnalyzer({ includeDefaultAdapters: false, adapters: [adapter] });

    const first = await analyzer.analyze("hello world");
    expect(first.tokens).toBe(2);
    expect(first.cacheHit).toBe(false);

    const second = await analyzer.analyze("hello world");
    expect(second.tokens).toBe(2);
    expect(second.cacheHit).toBe(true);
  });

  it("falls back to secondary adapter when primary throws", async () => {
    const failing = new StubAdapter("broken", () => {
      throw new Error("nope");
    });
    const working = new StubAdapter("chars", (content) => content.length);
    const analyzer = new TokenAnalyzer({ includeDefaultAdapters: false, adapters: [failing, working] });

    const result = await analyzer.analyze("abc");
    expect(result.tokens).toBe(3);
    expect(result.adapter).toBe("chars");
  });

  it("emits budget warnings when thresholds exceeded", async () => {
    const adapter = new StubAdapter("fixed", () => 1200);
    const analyzer = new TokenAnalyzer({ includeDefaultAdapters: false, adapters: [adapter], maxTokens: 1000, warnThreshold: 800 });

    const analysis = await analyzer.analyze("sample", { metadata: { path: "sample" } });
    expect(analysis.exceededBudget).toBe(true);
    expect(analysis.warnings).toHaveLength(2);
    expect(analysis.warnings[0]).toContain("near the budget");
    expect(analysis.warnings[1]).toContain("exceeds the budget");
  });

  it("supports batch analysis with concurrency", async () => {
    const spy = jest.fn((content: string) => content.length);
    const adapter = new StubAdapter("len", spy);
    const analyzer = new TokenAnalyzer({ includeDefaultAdapters: false, adapters: [adapter], concurrency: 2 });

    const analyses = await analyzer.analyzeBatch(["a", "bb", "ccc"]);
    const tokens = analyses.map((entry: TokenAnalysis) => entry.tokens);
    expect(tokens).toEqual([1, 2, 3]);
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it("keeps legacy static helpers available", () => {
    expect(TokenAnalyzer.estimate("abcd")).toBe(1);
    expect(TokenAnalyzer.formatEstimate(1500)).toBe("1.5k tokens");
    expect(TokenAnalyzer.warnIfExceedsLimit(2000, 1000)).toContain("exceeds the limit");
  });
});