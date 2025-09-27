export class TokenAnalyzer {
  private static readonly CHAR_PER_TOKEN = 4;

  /**
   * Estimates the token count based on a simple character-to-token ratio.
   */
  public static estimate(content: string): number {
    if (!content) {
      return 0;
    }
    const tokens = content.length / TokenAnalyzer.CHAR_PER_TOKEN;
    return Math.max(0, Math.round(tokens));
  }

  /**
   * Formats a token count into a compact human-readable string (e.g. 1.3k tokens).
   */
  public static formatEstimate(tokens: number): string {
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

  /**
   * Returns a warning string if the token count exceeds the provided limit; otherwise null.
   */
  public static warnIfExceedsLimit(tokens: number, limit: number): string | null {
    if (tokens <= limit) {
      return null;
    }

    const formattedTokens = TokenAnalyzer.formatEstimate(tokens);
    const formattedLimit = TokenAnalyzer.formatEstimate(limit);
    return `Warning: Estimated token usage (${formattedTokens}) exceeds the limit (${formattedLimit}).`;
  }

  private static formatWithPrecision(value: number): string {
    const rounded = Math.round(value * 10) / 10;
    return Number.isInteger(rounded) ? `${rounded.toFixed(0)}` : `${rounded.toFixed(1)}`;
  }
}
