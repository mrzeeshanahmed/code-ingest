import type { DigestConfig } from "../utils/validateConfig";

export const DEFAULT_CONFIG: DigestConfig = {
  include: ["**/*"],
  exclude: ["node_modules/**", "dist/**", "out/**"],
  maxDepth: 5,
  maxFiles: 1000,
  outputFormat: 'markdown',
  binaryFilePolicy: 'skip',
  repoName: 'workspace',
  followSymlinks: false,
  respectGitIgnore: true,
  includeCodeCells: true,
  includeMarkdownCells: true,
  includeCellOutputs: false,
  maxConcurrency: 4,
  sectionSeparator: "\n\n"
};

export const GRAPH_SCHEMA_VERSION = 1;

export const VFS_DRAIN_TIMEOUT_MS = 5_000;
export const KNOWLEDGE_MAX_CONCURRENT_SYNTHESIZES = 2;
export const HNSW_COMPACTION_DOC_THRESHOLD = 5_000;
export const HNSW_COMPACTION_STALENESS_RATIO = 0.3;

export const GRAPH_DEFAULTS = {
  hopDepth: 3,
  defaultNodeMode: "file",
  maxNodes: 500,
  enableVectorSearch: true,
  layout: "cose",
  maxFileSizeKB: 10_240,
  maxFiles: 10_000,
  watcherDebounceMs: 800,
  excludePatterns: [] as string[],
  rebuildOnActivation: false,
  tokenBudget: 8_192,
  includeSourceContent: true,
  redactSecrets: true,
  semanticResultCount: 5,
  showCircularDepsWarning: true,
  focusModeOpacity: 0.15,
  autoFocusOnEditorChange: true
} as const;

export type GraphNodeMode = "file" | "function";
export type GraphLayout = "cose" | "radial";

export interface GraphSettings {
  hopDepth: number;
  defaultNodeMode: GraphNodeMode;
  maxNodes: number;
  enableVectorSearch: boolean;
  layout: GraphLayout;
  maxFileSizeKB: number;
  maxFiles: number;
  watcherDebounceMs: number;
  excludePatterns: string[];
  rebuildOnActivation: boolean;
  tokenBudget: number;
  includeSourceContent: boolean;
  redactSecrets: boolean;
  semanticResultCount: number;
  showCircularDepsWarning: boolean;
  focusModeOpacity: number;
  autoFocusOnEditorChange: boolean;
}
