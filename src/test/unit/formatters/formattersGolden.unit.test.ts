import { describe, expect, test } from "@jest/globals";
import { JsonFormatter } from "../../../formatters/jsonFormatter";
import { MarkdownFormatter } from "../../../formatters/markdownFormatter";
import { TextFormatter } from "../../../formatters/textFormatter";
import type { DigestResult } from "../../../services/digestGenerator";
import { createFormatterDigestFixture } from "../../support/formatters.fixture";

const EXPECTED_MARKDOWN_OUTPUT = `---
generated_at: 2024-01-01T00:00:00.000Z
workspace_root: /workspace
total_files: 2
included_files: 2
skipped_files: 0
binary_files: 0
token_estimate: 512
processing_time_ms: 1234
redaction_applied: true
generator_version: 0.0.1
---

## Digest Summary


- Total files: 2
- Included: 2
- Skipped: 0
- Binary: 0
- Total tokens: 1024


### Notes
- Sample note


### Table of Contents
- [src/index.ts](#srcindexts) — 256 tokens
- [src/utils/helpers.ts](#srcutilshelpersts) — 128 tokens _(truncated)_

### File Tree
\`\`\`mermaid
graph TD
  root["Workspace"]
  root_src_0["src"]
  root --> root_src_0
  root_src_0_index_ts_0["index.ts"]
  root_src_0 --> root_src_0_index_ts_0
  root_src_0_utils_1["utils"]
  root_src_0 --> root_src_0_utils_1
  root_src_0_utils_1_helpers_ts_0["helpers.ts"]
  root_src_0_utils_1 --> root_src_0_utils_1_helpers_ts_0
\`\`\`
- src
  - index.ts
  - utils
    - helpers.ts

### src/index.ts

\`\`\`typescript
export const answer = 42;

\`\`\`

### src/utils/helpers.ts

\`\`\`typescript
export function helper() { return true; }

\`\`\`

### Statistics
- Files processed: 2
- Total tokens: 384
- Processing time: 1s
- Warnings: 1
- Errors: 0
- Warnings:
  - Low confidence in helper.ts`;

const EXPECTED_JSON_OUTPUT = `{
  "metadata": {
    "generatedAt": "2024-01-01T00:00:00.000Z",
    "workspaceRoot": "/workspace",
    "totalFiles": 2,
    "includedFiles": 2,
    "skippedFiles": 0,
    "binaryFiles": 0,
    "tokenEstimate": 512,
    "processingTime": 1234,
    "redactionApplied": true,
    "generatorVersion": "0.0.1"
  },
  "summary": {
    "overview": {
      "totalFiles": 2,
      "includedFiles": 2,
      "skippedFiles": 0,
      "binaryFiles": 0,
      "totalTokens": 1024
    },
    "tableOfContents": [
      {
        "path": "src/index.ts",
        "tokens": 256,
        "truncated": false
      },
      {
        "path": "src/utils/helpers.ts",
        "tokens": 128,
        "truncated": true
      }
    ],
    "notes": [
      "Sample note"
    ]
  },
  "files": [
    {
      "path": "/workspace/src/index.ts",
      "relativePath": "src/index.ts",
      "tokens": 256,
      "content": "export const answer = 42;\\n",
      "languageId": "typescript",
      "encoding": "utf8",
      "truncated": false,
      "redacted": false,
      "metadata": {
        "size": 128,
        "lines": 2,
        "processingTime": 50
      },
      "warnings": [],
      "errors": []
    },
    {
      "path": "/workspace/src/utils/helpers.ts",
      "relativePath": "src/utils/helpers.ts",
      "tokens": 128,
      "content": "export function helper() { return true; }\\n",
      "languageId": "typescript",
      "encoding": "utf8",
      "truncated": true,
      "redacted": false,
      "metadata": {
        "size": 64,
        "lines": 1,
        "processingTime": 30
      },
      "warnings": [
        "Truncated due to size"
      ],
      "errors": []
    }
  ],
  "statistics": {
    "filesProcessed": 2,
    "totalTokens": 384,
    "processingTime": 1234,
    "warnings": [
      "Low confidence in helper.ts"
    ],
    "errors": []
  },
  "schema_version": "1.0.0"
}`;

const TEXT_LINE_WIDTH = 80;
const TEXT_LABEL_WIDTH = 18;
const TEXT_VALUE_WIDTH = 52;

describe("Formatter golden outputs", () => {
  test("markdown formatter matches captured output", () => {
    const formatter = new MarkdownFormatter();
    const digest = createFormatterDigestFixture();

    expect(formatter.finalize(digest)).toBe(EXPECTED_MARKDOWN_OUTPUT);
  });

  test("json formatter matches captured output", () => {
    const formatter = new JsonFormatter();
    const digest = createFormatterDigestFixture();

    expect(formatter.finalize(digest)).toBe(EXPECTED_JSON_OUTPUT);
  });

  test("text formatter matches captured output", () => {
    const formatter = new TextFormatter();
    const digest = createFormatterDigestFixture();

    expect(formatter.finalize(digest)).toBe(buildExpectedTextOutput(digest));
  });
});

function buildExpectedTextOutput(digest: DigestResult): string {
  const metadataLines = [
    formatKeyValue("Workspace", digest.content.metadata.workspaceRoot),
    formatKeyValue("Generated", digest.content.metadata.generatedAt.toISOString()),
    formatKeyValue("Total files", digest.content.metadata.totalFiles.toString()),
    formatKeyValue("Included", digest.content.metadata.includedFiles.toString()),
    formatKeyValue("Skipped", digest.content.metadata.skippedFiles.toString()),
    formatKeyValue("Binary", digest.content.metadata.binaryFiles.toString()),
    formatKeyValue("Token estimate", digest.content.metadata.tokenEstimate.toString()),
    formatKeyValue("Processing time", `${digest.content.metadata.processingTime} ms`),
    formatKeyValue("Redaction", digest.content.metadata.redactionApplied ? "yes" : "no"),
    formatKeyValue("Generator", digest.content.metadata.generatorVersion)
  ].flatMap((line) => line.split("\n"));

  const summaryLines = [
    formatKeyValue("Total files", digest.content.summary.overview.totalFiles.toString()),
    formatKeyValue("Included", digest.content.summary.overview.includedFiles.toString()),
    formatKeyValue("Skipped", digest.content.summary.overview.skippedFiles.toString()),
    formatKeyValue("Binary", digest.content.summary.overview.binaryFiles.toString()),
    formatKeyValue("Total tokens", digest.content.summary.overview.totalTokens.toString()),
    "",
    "Table of Contents",
    ...digest.content.summary.tableOfContents.map((entry) => {
      const suffix = entry.truncated ? " (truncated)" : "";
      return `  • ${entry.path} — ${entry.tokens} tokens${suffix}`;
    }),
    "",
    "Notes",
    ...digest.content.summary.notes.map((note) => `  • ${note}`)
  ];

  const fileTreeLines = buildAsciiTree(digest.content.files.map((file) => file.relativePath));

  const fileSections = digest.content.files.map((file) =>
    renderSection(
      `${file.relativePath} (${file.tokens} tokens${file.truncated ? ", truncated" : ""})`,
      truncateContent(file.content, undefined).split(/\r?\n/),
      { preserveSpacing: true }
    )
  );

  const statisticsLines = [
    formatKeyValue("Files processed", digest.statistics.filesProcessed.toString()),
    formatKeyValue("Total tokens", digest.statistics.totalTokens.toString()),
    formatKeyValue("Processing time", formatDuration(digest.statistics.processingTime)),
    formatKeyValue("Warnings", digest.statistics.warnings.length.toString()),
    formatKeyValue("Errors", digest.statistics.errors.length.toString()),
    ...(digest.statistics.warnings.length > 0
      ? ["", "Warnings", ...digest.statistics.warnings.map((warning) => `  • ${warning}`)]
      : []),
    ...(digest.statistics.errors.length > 0
      ? ["", "Errors", ...digest.statistics.errors.map((error) => `  • ${error}`)]
      : [])
  ];

  const sections = [
    renderSection("Digest Metadata", metadataLines),
    renderSection("Summary", summaryLines),
    renderSection("File Tree", fileTreeLines),
    ...fileSections,
    renderSection("Statistics", statisticsLines)
  ];

  return sections.join("\n\n");
}

function renderSection(title: string, bodyLines: string[], options: { preserveSpacing?: boolean } = {}): string {
  const lineWidth = TEXT_LINE_WIDTH;
  const useAsciiBox = true;

  if (!useAsciiBox) {
    const wrapped = bodyLines.flatMap((line) => wrapLine(line, lineWidth, options.preserveSpacing ?? false));
    return [title, "-".repeat(lineWidth), ...wrapped].join("\n");
  }

  const innerWidth = Math.min(
    lineWidth - 4,
    Math.max(
      title.length,
      ...bodyLines
        .flatMap((line) => wrapLine(line, lineWidth - 4, options.preserveSpacing ?? false))
        .map((line) => line.length)
    )
  );
  const effectiveInnerWidth = Math.max(10, innerWidth);
  const wrappedBody = bodyLines.flatMap((line) => wrapLine(line, effectiveInnerWidth, options.preserveSpacing ?? false));

  const top = `┌${"─".repeat(effectiveInnerWidth + 2)}┐`;
  const header = `│ ${padLine(title, effectiveInnerWidth)} │`;
  const content =
    wrappedBody.length > 0
      ? wrappedBody.map((line) => `│ ${padLine(line, effectiveInnerWidth)} │`)
      : [`│ ${"".padEnd(effectiveInnerWidth, " ")} │`];
  const bottom = `└${"─".repeat(effectiveInnerWidth + 2)}┘`;

  return [top, header, ...content, bottom].join("\n");
}

function wrapLine(line: string, maxWidth: number, preserveSpacing: boolean): string[] {
  if (line.length === 0) {
    return [""];
  }

  if (preserveSpacing) {
    return chunkLine(line, Math.max(1, maxWidth));
  }

  return wrapText(line, Math.max(1, maxWidth));
}

function wrapText(value: string, maxWidth: number): string[] {
  if (value.length <= maxWidth) {
    return [value];
  }

  const words = value.split(/\s+/);
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    if (current.length === 0) {
      current = word;
      continue;
    }

    if ((current + " " + word).length <= maxWidth) {
      current = `${current} ${word}`;
    } else {
      lines.push(current);
      if (word.length > maxWidth) {
        lines.push(...chunkLine(word, maxWidth));
        current = "";
      } else {
        current = word;
      }
    }
  }

  if (current.length > 0) {
    lines.push(current);
  }

  return lines;
}

function chunkLine(value: string, maxWidth: number): string[] {
  if (value.length === 0) {
    return [""];
  }

  const segments: string[] = [];
  let start = 0;
  while (start < value.length) {
    segments.push(value.slice(start, start + maxWidth));
    start += maxWidth;
  }
  return segments;
}

function padLine(line: string, width: number): string {
  if (line.length === width) {
    return line;
  }
  if (line.length < width) {
    return line.padEnd(width, " ");
  }
  return line.slice(0, width);
}

function formatKeyValue(label: string, value: string): string {
  const labelWidth = TEXT_LABEL_WIDTH;
  const valueWidth = TEXT_VALUE_WIDTH;

  const styledLabel = `${label}:`.padEnd(labelWidth, " ");
  const wrappedValue = wrapText(value, valueWidth);

  return wrappedValue
    .map((line, index) => (index === 0 ? `${styledLabel} ${line}` : `${" ".repeat(labelWidth)} ${line}`))
    .join("\n");
}

function buildAsciiTree(paths: string[]): string[] {
  if (paths.length === 0) {
    return ["<no files>"];
  }

  interface TreeNode {
    name: string;
    children: Map<string, TreeNode>;
    isFile: boolean;
  }

  const root: TreeNode = { name: "", isFile: false, children: new Map() };

  paths.forEach((relPath) => {
    const segments = relPath.split(/\\|\//);
    let current = root;
    segments.forEach((segment, index) => {
      const isFile = index === segments.length - 1;
      if (!current.children.has(segment)) {
        current.children.set(segment, { name: segment, isFile, children: new Map() });
      }
      const node = current.children.get(segment)!;
      if (isFile) {
        node.isFile = true;
      }
      current = node;
    });
  });

  const lines: string[] = [];

  const traverse = (node: TreeNode, prefix: string) => {
    const sorted = Array.from(node.children.values()).sort((a, b) => a.name.localeCompare(b.name));
    sorted.forEach((child, index) => {
      const isLast = index === sorted.length - 1;
      const connector = isLast ? "└──" : "├──";
      lines.push(`${prefix}${connector} ${child.name}`);
      const nextPrefix = prefix + (isLast ? "    " : "│   ");
      if (child.children.size > 0) {
        traverse(child, nextPrefix);
      }
    });
  };

  traverse(root, "");
  return lines;
}

function truncateContent(content: string, maxLength: number | undefined): string {
  if (!maxLength || content.length <= maxLength) {
    return content;
  }
  return `${content.slice(0, maxLength)}\n... (truncated)`;
}

function formatDuration(ms?: number): string {
  if (ms === undefined || Number.isNaN(ms)) {
    return "unknown";
  }

  const parts: string[] = [];
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1_000);
  const remainingMs = Math.round(ms % 1_000);

  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (seconds) parts.push(`${seconds}s`);
  if (remainingMs && parts.length === 0) parts.push(`${remainingMs}ms`);

  return parts.join(" ") || "0ms";
}
