import { describe, expect, test } from "@jest/globals";
import { MarkdownFormatter } from "../../../formatters/markdownFormatter";
import type { FormatterOptions } from "../../../formatters/types";
import { createDigestResult } from "./formatterTestUtils";

const baseOptions: Partial<FormatterOptions> = {
  markdown: {
    headerLevel: 2,
    includeMermaidDiagram: true,
    collapsibleThresholdLines: 3
  }
};

describe("MarkdownFormatter", () => {
  test("renders full digest with front matter and code fences", () => {
    const formatter = new MarkdownFormatter(baseOptions);
    const digest = createDigestResult({
      files: [
        {
          path: "/workspace/src/index.ts",
          relativePath: "src/index.ts",
          tokens: 256,
          content: "export const answer = 42;\nexport const meaning = 1337;\n",
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
          content: "line1\nline2\nline3\nline4\n",
          languageId: "typescript",
          encoding: "utf8",
          truncated: true,
          redacted: false,
          metadata: {
            size: 64,
            lines: 4,
            processingTime: 30
          },
          warnings: ["Truncated due to size"],
          errors: []
        }
      ]
    });

    const output = formatter.finalize(digest);

    expect(output).toContain("---\ngenerated_at:");
  expect(output).toContain("# Digest Summary");
  expect(output).toContain("```typescript\nexport const answer = 42;");
  expect(output).toContain("<details>\n  <summary>src/utils/helpers.ts (128 tokens, truncated)</summary>");
  });

  test("omits mermaid diagram when disabled", () => {
    const formatter = new MarkdownFormatter({
      markdown: {
        includeMermaidDiagram: false
      }
    });

    const digest = createDigestResult();
    const output = formatter.finalize(digest);

    expect(output).not.toContain("```mermaid");
    expect(output).toContain("- src");
  });

  test("honors templates when provided", () => {
    const formatter = new MarkdownFormatter(
      baseOptions,
      {
        header: "{{metadata.generatorVersion}}",
        finalize: "{{digest.statistics.totalTokens}} tokens"
      }
    );

    const digest = createDigestResult();
    const output = formatter.finalize(digest);

    expect(output.trim()).toBe("384 tokens");
  });
});