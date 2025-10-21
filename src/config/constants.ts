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
