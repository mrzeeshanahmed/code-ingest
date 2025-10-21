import { describe, expect, test } from "@jest/globals";
import { MarkdownFormatter } from "../../../formatters/markdownFormatter";
import { TextFormatter } from "../../../formatters/textFormatter";
import { JsonFormatter } from "../../../formatters/jsonFormatter";
import type { FormatterTemplateSet } from "../../../formatters/types";
import { createDigestResult } from "./formatterTestUtils";

describe("Formatter template contracts", () => {
  const digest = createDigestResult();
  const sectionTemplates: FormatterTemplateSet = {
    header: "HEADER:{{metadata.workspaceRoot}}",
    summary: "SUMMARY:{{summaryView.overview.0.label}}={{summaryView.overview.0.value}}",
    fileTree: "TREE:{{fileTreeView.nested.0}}",
    fileContent: "FILE:{{file.relativePath}}",
    footer: "FOOTER:{{statistics.totalTokens}}"
  };

  const factories: Array<[string, (templates?: FormatterTemplateSet) => string]> = [
    ["Markdown", (templates?: FormatterTemplateSet) => new MarkdownFormatter(undefined, templates).finalize(digest)],
    ["Text", (templates?: FormatterTemplateSet) => new TextFormatter(undefined, templates).finalize(digest)],
    ["JSON", (templates?: FormatterTemplateSet) => new JsonFormatter(undefined, templates).finalize(digest)]
  ];

  test.each(factories)("applies templates for all sections (%s)", (_name, build) => {
    const output = build(sectionTemplates);

    expect(output).toContain("HEADER:/workspace");
    expect(output).toContain("SUMMARY:Total files=2");
    expect(output).toMatch(/TREE:.*src/i);
    expect(output).toContain("FILE:src/index.ts");
    expect(output).toContain("FILE:src/utils/helpers.ts");
    expect(output).toContain("FOOTER:384");
  });

  test.each(factories)("applies finalize template overrides (%s)", (_name, build) => {
    const finalizeOnly: FormatterTemplateSet = {
      finalize: "FINALIZE:{{digest.content.files.length}}"
    };

    const output = build(finalizeOnly).trim();
    expect(output).toBe("FINALIZE:2");
  });
});
