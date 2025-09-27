import { describe, expect, it } from "@jest/globals";
import { TokenAnalyzer } from "./tokenAnalyzer";

describe("TokenAnalyzer", () => {
  describe("estimate", () => {
    it("returns zero for empty content", () => {
      expect(TokenAnalyzer.estimate("")).toBe(0);
    });

    it("rounds to the nearest integer", () => {
      expect(TokenAnalyzer.estimate("abcd")).toBe(1);
      expect(TokenAnalyzer.estimate("abcdefgh")).toBe(2);
    });
  });

  describe("formatEstimate", () => {
    it("formats small numbers without suffix", () => {
      expect(TokenAnalyzer.formatEstimate(12)).toBe("12 tokens");
    });

    it("formats thousands with k suffix", () => {
      expect(TokenAnalyzer.formatEstimate(1500)).toBe("1.5k tokens");
    });
  });

  describe("warnIfExceedsLimit", () => {
    it("returns null when usage is within the limit", () => {
      expect(TokenAnalyzer.warnIfExceedsLimit(100, 200)).toBeNull();
    });

    it("returns a warning string when usage exceeds the limit", () => {
      const warning = TokenAnalyzer.warnIfExceedsLimit(2000, 1000);
      expect(warning).toBe("Warning: Estimated token usage (2k tokens) exceeds the limit (1k tokens).");
    });
  });
});