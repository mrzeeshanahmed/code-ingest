import type { FilterResult } from "./filterService";

export type SkipReason = "include" | "exclude" | "gitignore" | "depth" | "symlink";

export interface SkipStats {
  count: number;
  samples: string[];
  details: Set<string>;
}

export type SkipStatsMap = Map<SkipReason, SkipStats>;

interface SkipMessageContext {
  maxDepth?: number;
  followSymlinks: boolean;
}

const SKIP_SAMPLE_LIMIT = 3;
const SKIP_DETAIL_LIMIT = 3;

export function createSkipStatsMap(): SkipStatsMap {
  return new Map<SkipReason, SkipStats>();
}

export function recordSkip(statsMap: SkipStatsMap, reason: SkipReason, relPath: string, detail?: string): void {
  if (!relPath) {
    return;
  }

  let stats = statsMap.get(reason);
  if (!stats) {
    stats = {
      count: 0,
      samples: [],
      details: new Set<string>()
    } satisfies SkipStats;
    statsMap.set(reason, stats);
  }

  stats.count += 1;
  if (stats.samples.length < SKIP_SAMPLE_LIMIT) {
    stats.samples.push(relPath);
  }
  if (detail) {
    stats.details.add(detail);
  }
}

export function recordFilterOutcome(statsMap: SkipStatsMap, relPath: string, result: FilterResult | undefined): void {
  if (!result || result.included) {
    return;
  }

  switch (result.reason) {
    case "excluded":
      if (result.matchedPattern) {
        recordSkip(statsMap, "exclude", relPath, result.matchedPattern);
      } else {
        recordSkip(statsMap, "include", relPath);
      }
      return;
    case "gitignored":
      recordSkip(statsMap, "gitignore", relPath);
      return;
    case "depth-limit":
      recordSkip(statsMap, "depth", relPath);
      return;
    case "symlink-skipped":
      recordSkip(statsMap, "symlink", relPath);
      return;
    default:
      recordSkip(statsMap, "include", relPath);
  }
}

export function buildSkipMessages(statsMap: SkipStatsMap, context: SkipMessageContext): string[] {
  const warnings: string[] = [];
  const orderedReasons: SkipReason[] = ["exclude", "gitignore", "depth", "symlink", "include"];

  for (const reason of orderedReasons) {
    const stats = statsMap.get(reason);
    if (!stats || stats.count === 0) {
      continue;
    }

    const plural = stats.count === 1 ? "" : "s";
    const sentences: string[] = [];

    switch (reason) {
      case "include":
        sentences.push(`Excluded ${stats.count} path${plural} that did not match include patterns.`);
        break;
      case "exclude": {
        sentences.push(`Skipped ${stats.count} path${plural} by exclude patterns.`);
        if (stats.details.size > 0) {
          const patterns = [...stats.details].slice(0, SKIP_DETAIL_LIMIT);
          const extra = stats.details.size - patterns.length;
          let patternText = `Patterns: ${patterns.join(", ")}`;
          if (extra > 0) {
            patternText += `, … (+${extra} more)`;
          }
          sentences.push(`${patternText}.`);
        }
        break;
      }
      case "gitignore":
        sentences.push(`Skipped ${stats.count} path${plural} ignored by gitignore.`);
        break;
      case "depth": {
        const depthLabel = typeof context.maxDepth === "number"
          ? `max depth ${context.maxDepth}`
          : "the configured depth limit";
        sentences.push(`Skipped ${stats.count} path${plural} beyond ${depthLabel}.`);
        break;
      }
      case "symlink":
        if (context.followSymlinks) {
          sentences.push(`Skipped ${stats.count} symlinked path${plural} due to imposed filters.`);
        } else {
          sentences.push(`Skipped ${stats.count} symlinked path${plural}; enable followSymlinks to include them.`);
        }
        break;
    }

    if (stats.samples.length > 0) {
      const samples = stats.samples.join(", ");
      const extraSamples = stats.count - stats.samples.length;
      const sampleText = extraSamples > 0
        ? `Examples: ${samples}, … (+${extraSamples} more).`
        : `Examples: ${samples}.`;
      sentences.push(sampleText);
    }

    warnings.push(sentences.join(" "));
  }

  return warnings;
}
