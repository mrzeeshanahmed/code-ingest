import * as vscode from "vscode";

export interface TokenBudgetConfig {
  totalBudget: number;
  reserveTokensPercent: number;
  reserveTokensMin: number;
}

export interface TokenCheckResult {
  withinBudget: boolean;
  usedTokens: number;
  remainingTokens: number;
}

export class TokenBudgetService {
  private readonly reserveTokens: number;
  private readonly effectiveBudget: number;

  constructor(private readonly config: TokenBudgetConfig) {
    const reserve = Math.max(config.reserveTokensPercent * config.totalBudget, config.reserveTokensMin);
    this.reserveTokens = Math.min(reserve, config.totalBudget * 0.5);
    this.effectiveBudget = config.totalBudget - this.reserveTokens;
  }

  public getReserveTokens(): number {
    return this.reserveTokens;
  }

  public getEffectiveBudget(): number {
    return this.effectiveBudget;
  }

  public async countTokens(text: string, model?: vscode.LanguageModelChat): Promise<number> {
    if (!text.trim()) {
      return 0;
    }
    if (model) {
      try {
        return await model.countTokens(text);
      } catch {
        // Fallback to heuristic if LM counting fails.
      }
    }
    // Heuristic fallback: ~1.3 tokens per word.
    const words = text.split(/\s+/u).filter(Boolean).length;
    return Math.max(1, Math.ceil(words * 1.3));
  }

  public async batchCountTokens(items: string[], model?: vscode.LanguageModelChat): Promise<number[]> {
    if (items.length === 0) {
      return [];
    }
    // Batch by concatenating with separators to reduce API calls.
    const separator = "\n\n---BATCH-SEPARATOR---\n\n";
    const combined = items.join(separator);
    const totalTokens = await this.countTokens(combined, model);

    // Distribute proportionally by text length.
    const totalLength = items.reduce((sum, item) => sum + item.length, 0);
    if (totalLength === 0) {
      return items.map(() => 0);
    }

    return items.map((item) => Math.round((item.length / totalLength) * totalTokens));
  }

  public checkBudget(usedTokens: number): TokenCheckResult {
    return {
      withinBudget: usedTokens <= this.effectiveBudget,
      usedTokens,
      remainingTokens: Math.max(0, this.effectiveBudget - usedTokens)
    };
  }
}
