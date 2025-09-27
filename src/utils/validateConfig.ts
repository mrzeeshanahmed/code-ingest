export interface DigestConfig {
  /** Glob patterns to include when generating digests. */
  include?: string[];
  /** Glob patterns to exclude when generating digests. */
  exclude?: string[];
  /** Maximum directory traversal depth. */
  maxDepth?: number;
  /** Maximum number of files to process in a single run. */
  maxFiles?: number;
  /** Output format for generated digests. */
  outputFormat?: 'json' | 'markdown' | string;
  /** Policy for handling binary files encountered during scanning. */
  binaryFilePolicy?: 'skip' | 'base64' | 'placeholder' | string;
  /** Human readable repository name. */
  repoName?: string;
  /** Whether symbolic links should be followed during traversal. */
  followSymlinks?: boolean;
  /** Respect gitignore files when discovering entries. */
  respectGitIgnore?: boolean;
  /** Whether to include code cells when processing notebooks. */
  includeCodeCells?: boolean;
  /** Whether to include markdown cells when processing notebooks. */
  includeMarkdownCells?: boolean;
  /** Whether to include notebook cell outputs. */
  includeCellOutputs?: boolean;
  /** Maximum number of concurrent file processing tasks. */
  maxConcurrency?: number;
  /** Separator string used when assembling multi-section outputs. */
  sectionSeparator?: string;
  /** Absolute workspace root used for building relative paths in summaries. */
  workspaceRoot?: string;
}

export interface Diagnostics {
  /** Registers an unrecoverable configuration error. */
  addError(message: string): void;
  /** Optionally surface non-fatal warnings. */
  addWarning?(message: string): void;
}

const DEFAULT_INCLUDE = ["src"];
const DEFAULT_EXCLUDE = ["node_modules", "dist", "out"];
const DEFAULT_MAX_DEPTH = 5;
const DEFAULT_MAX_FILES = 1000;
const DEFAULT_REPO_NAME = "workspace";
const DEFAULT_OUTPUT_FORMAT = 'markdown';
const DEFAULT_BINARY_POLICY = 'skip';
const DEFAULT_INCLUDE_CODE_CELLS = true;
const DEFAULT_INCLUDE_MARKDOWN_CELLS = true;
const DEFAULT_INCLUDE_CELL_OUTPUTS = false;
const DEFAULT_MAX_CONCURRENCY = 4;
const DEFAULT_SECTION_SEPARATOR = "\n\n";

/**
 * Normalizes an arbitrary value into an array of strings.
 */
function normalizeStringArray(
  value: unknown,
  fallback: string[],
  field: keyof Pick<DigestConfig, "include" | "exclude">,
  diagnostics: Diagnostics
): string[] {
  if (Array.isArray(value)) {
    const sanitized = value
      .filter((entry) => {
        const isString = typeof entry === "string";
        if (!isString && diagnostics) {
          diagnostics.addError(`Configuration field "${String(field)}" must contain only strings.`);
        }
        return isString;
      })
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);

    if (sanitized.length === 0) {
      if (diagnostics) {
        diagnostics.addError(`Configuration field "${String(field)}" must contain at least one non-empty string.`);
      }
      return [...fallback];
    }

    return sanitized;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    return [value.trim()];
  }

  if (value != null && diagnostics) {
    diagnostics.addError(`Configuration field "${String(field)}" must be an array of strings.`);
  }

  return [...fallback];
}

/* coerceMaxDepth removed in favor of the generic coercePositiveInteger helper */

/**
 * Ensures a candidate value is a non-negative integer; returns default and logs a warning on failure.
 */
function coercePositiveInteger(value: unknown, diagnostics: Diagnostics, fieldName: string, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const n = Math.floor(value);
    if (n >= 0) return n;
    diagnostics.addWarning?.(`Configuration field "${fieldName}" must be >= 0; using default ${fallback}.`);
    return fallback;
  }

  if (value != null) {
    diagnostics.addWarning?.(`Configuration field "${fieldName}" must be a number; using default ${fallback}.`);
  }

  return fallback;
}

/**
 * Ensures the repo name is a non-empty string.
 */
function coerceRepoName(value: unknown, diagnostics: Diagnostics): string {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }

  if (value != null && diagnostics) {
    diagnostics.addError("Configuration field \"repoName\" must be a non-empty string.");
  }

  return DEFAULT_REPO_NAME;
}

function coerceString(value: unknown, field: keyof DigestConfig, diagnostics: Diagnostics, fallback: string): string {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }

  if (value != null) {
    diagnostics.addWarning?.(`Configuration field "${String(field)}" must be a non-empty string; using default.`);
  }

  return fallback;
}

/**
 * Turns an unknown value into a boolean, reporting errors for unsupported types.
 */
function coerceBoolean(value: unknown, field: keyof DigestConfig, diagnostics: Diagnostics, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }

  if (value != null) {
    diagnostics.addWarning?.(`Configuration field "${String(field)}" should be a boolean; coercing to ${fallback}.`);
  }

  return fallback;
}

/**
 * Validates that a string value is one of an allowed set; warns and returns default otherwise.
 */
function coerceEnum(
  value: unknown,
  allowed: readonly string[],
  diagnostics: Diagnostics,
  fieldName: string,
  fallback: string
): string {
  if (typeof value === 'string') {
    if ((allowed as readonly string[]).includes(value)) return value;
    diagnostics.addWarning?.(`Configuration field "${fieldName}" has invalid value "${value}"; using default "${fallback}".`);
    return fallback;
  }

  if (value != null) {
    diagnostics.addWarning?.(`Configuration field "${fieldName}" must be a string; using default "${fallback}".`);
  }

  return fallback;
}

/**
 * Validates and sanitizes a digest configuration object in place.
 *
 * @param config - The configuration object to validate. Properties will be normalized.
 * @param diagnostics - Collector used to report validation failures.
 *
 * @remarks
 * This function mutates {@link DigestConfig} by rewriting invalid or missing fields
 * with safe defaults. No value is returned; callers rely on the mutated `config` instance.
 */
export function validateConfig(config: DigestConfig, diagnostics: Diagnostics): void {
  if (!config) {
    throw new Error("A configuration object is required for validation.");
  }

  const safeDiagnostics: Diagnostics = diagnostics ?? {
    addError: () => {
      /* noop */
    },
    addWarning: () => {
      /* noop */
    }
  };

  config.include = normalizeStringArray(config.include, DEFAULT_INCLUDE, "include", safeDiagnostics);
  config.exclude = normalizeStringArray(config.exclude, DEFAULT_EXCLUDE, "exclude", safeDiagnostics);
  config.maxDepth = coercePositiveInteger(config.maxDepth, safeDiagnostics, 'maxDepth', DEFAULT_MAX_DEPTH);
  config.maxFiles = coercePositiveInteger(config.maxFiles, safeDiagnostics, 'maxFiles', DEFAULT_MAX_FILES);
  // enums
  config.outputFormat = coerceEnum(config.outputFormat as unknown, ['json', 'markdown'] as const, safeDiagnostics, 'outputFormat', DEFAULT_OUTPUT_FORMAT) as DigestConfig['outputFormat'];
  config.binaryFilePolicy = coerceEnum(config.binaryFilePolicy as unknown, ['skip', 'base64', 'placeholder'] as const, safeDiagnostics, 'binaryFilePolicy', DEFAULT_BINARY_POLICY) as DigestConfig['binaryFilePolicy'];
  config.repoName = coerceRepoName(config.repoName, safeDiagnostics);
  config.followSymlinks = coerceBoolean(config.followSymlinks, "followSymlinks", safeDiagnostics, false);
  config.respectGitIgnore = coerceBoolean(config.respectGitIgnore, "respectGitIgnore", safeDiagnostics, true);
  config.includeCodeCells = coerceBoolean(config.includeCodeCells, "includeCodeCells", safeDiagnostics, DEFAULT_INCLUDE_CODE_CELLS);
  config.includeMarkdownCells = coerceBoolean(config.includeMarkdownCells, "includeMarkdownCells", safeDiagnostics, DEFAULT_INCLUDE_MARKDOWN_CELLS);
  config.includeCellOutputs = coerceBoolean(config.includeCellOutputs, "includeCellOutputs", safeDiagnostics, DEFAULT_INCLUDE_CELL_OUTPUTS);
  config.maxConcurrency = Math.max(1, coercePositiveInteger(config.maxConcurrency, safeDiagnostics, "maxConcurrency", DEFAULT_MAX_CONCURRENCY));
  config.sectionSeparator = coerceString(config.sectionSeparator, "sectionSeparator", safeDiagnostics, DEFAULT_SECTION_SEPARATOR);
  if (config.workspaceRoot != null && typeof config.workspaceRoot !== "string") {
    safeDiagnostics.addWarning?.('Configuration field "workspaceRoot" must be a string; ignoring value.');
    delete config.workspaceRoot;
  }
}
