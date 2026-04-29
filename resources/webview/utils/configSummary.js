/*
 * Follow instructions in copilot-instructions.md exactly.
 */

import { sanitizeText } from "./sanitizers.js";

const MAX_SUMMARY_ITEMS = 2;
const MAX_PATTERN_LENGTH = 256;

const unique = (values) => {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    result.push(value);
  }
  return result;
};

const normalizePatternList = (candidate) => {
  if (!Array.isArray(candidate)) {
    return [];
  }

  const normalized = [];
  for (const entry of candidate) {
    if (entry === null || entry === undefined) {
      continue;
    }
    const raw = typeof entry === "string" ? entry : String(entry);
    const sanitized = sanitizeText(raw, { maxLength: MAX_PATTERN_LENGTH });
    if (!sanitized) {
      continue;
    }
    normalized.push(sanitized);
  }

  return unique(normalized);
};

const summarizePatterns = (patterns, emptyLabel) => {
  if (patterns.length === 0) {
    return emptyLabel;
  }
  if (patterns.length <= MAX_SUMMARY_ITEMS) {
    return patterns.join(", ");
  }
  const head = patterns.slice(0, MAX_SUMMARY_ITEMS).join(", ");
  const remaining = patterns.length - MAX_SUMMARY_ITEMS;
  return `${head} (+${remaining} more)`;
};

const coerceBoolean = (value, fallback) => {
  if (typeof value === "boolean") {
    return value;
  }
  return fallback;
};

const sanitizeFormat = (value) => {
  if (typeof value !== "string") {
    return undefined;
  }
  const formatted = sanitizeText(value, { maxLength: 32 }).toLowerCase();
  return formatted || undefined;
};

const sanitizePreset = (value) => {
  if (typeof value !== "string") {
    return undefined;
  }
  const preset = sanitizeText(value, { maxLength: 64 });
  return preset || undefined;
};

export const buildConfigDisplay = (config) => {
  const source = config && typeof config === "object" ? config : {};

  const include = normalizePatternList(source.include ?? source.includePatterns);
  const exclude = normalizePatternList(source.exclude ?? source.excludePatterns);

  const statusInclude = summarizePatterns(include, "Workspace");
  const statusExclude = summarizePatterns(exclude, "Defaults");

  const followSymlinks = source.followSymlinks === true;
  const respectGitIgnore = coerceBoolean(
    source.respectGitIgnore ?? source.respectGitignore,
    true
  );
  const redactionOverride = source.redactionOverride === true;
  const outputFormat = sanitizeFormat(source.outputFormat);
  const preset = sanitizePreset(source.preset);

  const statusSegments = [`Include: ${statusInclude}`, `Exclude: ${statusExclude}`];
  if (outputFormat) {
    statusSegments.push(`Format: ${outputFormat}`);
  }
  statusSegments.push(`Redaction: ${redactionOverride ? "Off" : "On"}`);
  if (preset) {
    statusSegments.push(`Preset: ${preset}`);
  }

  const statusLine = statusSegments.join(" · ");

  const insightLines = [
    `Include patterns: ${include.length > 0 ? include.join(", ") : "Workspace (default)"}`,
    `Exclude patterns: ${exclude.length > 0 ? exclude.join(", ") : "Defaults"}`,
    `Gitignore: ${respectGitIgnore ? "On" : "Off"} · Symlinks: ${followSymlinks ? "Follow" : "Skip"}`,
    `Redaction: ${redactionOverride ? "Disabled (override on)" : "Enabled (masking)"}`
  ];

  if (outputFormat) {
    insightLines.push(`Output format: ${outputFormat}`);
  }
  if (preset) {
    insightLines.push(`Preset: ${preset}`);
  }

  return {
    include,
    exclude,
    followSymlinks,
    respectGitIgnore,
    redactionOverride,
    outputFormat,
    preset,
    includeSummary: statusInclude,
    excludeSummary: statusExclude,
    statusLine,
    lines: insightLines,
    insightText: insightLines.join("\n")
  };
};