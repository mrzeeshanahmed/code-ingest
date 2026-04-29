import type { DigestMetadata, DigestResult, DigestSummary, ProcessedFileContent } from "../../services/digestGenerator";

export interface FormatterDigestOverrides {
  readonly metadata?: Partial<DigestMetadata>;
  readonly summary?: Partial<DigestSummary>;
  readonly files?: ProcessedFileContent[];
  readonly statistics?: Partial<DigestResult["statistics"]>;
}

export function createFormatterDigestFixture(overrides: FormatterDigestOverrides = {}): DigestResult {
  const metadata: DigestMetadata = {
    generatedAt: overrides.metadata?.generatedAt ?? new Date("2024-01-01T00:00:00.000Z"),
    workspaceRoot: overrides.metadata?.workspaceRoot ?? "/workspace",
    totalFiles: overrides.metadata?.totalFiles ?? 2,
    includedFiles: overrides.metadata?.includedFiles ?? 2,
    skippedFiles: overrides.metadata?.skippedFiles ?? 0,
    binaryFiles: overrides.metadata?.binaryFiles ?? 0,
    tokenEstimate: overrides.metadata?.tokenEstimate ?? 512,
    processingTime: overrides.metadata?.processingTime ?? 1234,
    redactionApplied: overrides.metadata?.redactionApplied ?? true,
    generatorVersion: overrides.metadata?.generatorVersion ?? "0.0.1"
  } satisfies DigestMetadata;

  const summary: DigestSummary = {
    overview: overrides.summary?.overview ?? {
      totalFiles: metadata.totalFiles,
      includedFiles: metadata.includedFiles,
      skippedFiles: metadata.skippedFiles,
      binaryFiles: metadata.binaryFiles,
      totalTokens: overrides.summary?.overview?.totalTokens ?? 1024
    },
    tableOfContents: overrides.summary?.tableOfContents ?? [
      { path: "src/index.ts", tokens: 256, truncated: false },
      { path: "src/utils/helpers.ts", tokens: 128, truncated: true }
    ],
    notes: overrides.summary?.notes ?? ["Sample note"]
  } satisfies DigestSummary;

  const files: ProcessedFileContent[] =
    overrides.files ??
    ([
      {
        path: "/workspace/src/index.ts",
        relativePath: "src/index.ts",
        tokens: 256,
        content: "export const answer = 42;\n",
        languageId: "typescript",
        encoding: "utf8",
        truncated: false,
        redacted: false,
        metadata: {
          size: 128,
          lines: 2,
          processingTime: 50
        },
        warnings: [],
        errors: []
      },
      {
        path: "/workspace/src/utils/helpers.ts",
        relativePath: "src/utils/helpers.ts",
        tokens: 128,
        content: "export function helper() { return true; }\n",
        languageId: "typescript",
        encoding: "utf8",
        truncated: true,
        redacted: false,
        metadata: {
          size: 64,
          lines: 1,
          processingTime: 30
        },
        warnings: ["Truncated due to size"],
        errors: []
      }
    ] satisfies ProcessedFileContent[]);

  const statistics: DigestResult["statistics"] = {
    filesProcessed: overrides.statistics?.filesProcessed ?? files.length,
    totalTokens: overrides.statistics?.totalTokens ?? 384,
    processingTime: overrides.statistics?.processingTime ?? 1234,
    warnings: overrides.statistics?.warnings ?? ["Low confidence in helper.ts"],
    errors: overrides.statistics?.errors ?? []
  } satisfies DigestResult["statistics"];

  return {
    content: {
      files,
      summary,
      metadata
    },
    statistics,
    redactionApplied: true,
    truncationApplied: files.some((file) => file.truncated)
  } satisfies DigestResult;
}

export const DEFAULT_FORMATTER_DIGEST: DigestResult = createFormatterDigestFixture();