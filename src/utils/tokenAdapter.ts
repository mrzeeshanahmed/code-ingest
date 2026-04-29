export class TokenAdapter {
  public estimateCount(text: string): number {
    if (!text.trim()) {
      return 0;
    }

    const words = text.split(/\s+/u).filter(Boolean).length;
    return Math.max(1, Math.ceil(words * 1.3));
  }

  public humanize(count: number): string {
    if (count >= 1_000_000) {
      return `${(count / 1_000_000).toFixed(1)}M`;
    }

    if (count >= 1_000) {
      return `${(count / 1_000).toFixed(1)}k`;
    }

    return String(Math.max(0, Math.round(count)));
  }

  public trimToBudget(text: string, maxTokens: number): string {
    if (!text.trim() || maxTokens <= 0) {
      return "";
    }

    const words = text.split(/\s+/u).filter(Boolean);
    if (words.length === 0) {
      return "";
    }

    let low = 0;
    let high = words.length;
    let best = 0;

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const candidate = words.slice(0, mid).join(" ");
      const tokens = this.estimateCount(candidate);

      if (tokens <= maxTokens) {
        best = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    return words.slice(0, best).join(" ");
  }

  public chunkByTokens(text: string, maxTokens: number, overlapTokens: number): string[] {
    if (!text.trim() || maxTokens <= 0) {
      return [];
    }

    const words = text.split(/\s+/u).filter(Boolean);
    if (words.length === 0) {
      return [];
    }

    const averageTokensPerWord = 1.3;
    const wordsPerChunk = Math.max(1, Math.floor(maxTokens / averageTokensPerWord));
    const overlapWords = Math.max(0, Math.floor(overlapTokens / averageTokensPerWord));
    const chunks: string[] = [];

    let index = 0;
    while (index < words.length) {
      const end = Math.min(words.length, index + wordsPerChunk);
      chunks.push(words.slice(index, end).join(" "));

      if (end >= words.length) {
        break;
      }

      index = Math.max(index + 1, end - overlapWords);
    }

    return chunks;
  }
}
