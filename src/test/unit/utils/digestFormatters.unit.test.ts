import { describe, expect, test } from "@jest/globals";
import { MarkdownFormatter } from "../../../formatters/markdownFormatter";
import { registerFormatter, unregisterFormatter } from "../../../formatters/factory";
import { formatDigest } from "../../../utils/digestFormatters";
import { createDigestResult } from "../formatters/formatterTestUtils";

describe("formatDigest", () => {
  test("formats digest as markdown by default", () => {
    const digest = createDigestResult();
    const output = formatDigest(digest);

    expect(output).toContain("# Digest Summary");
    expect(output).toContain("File Tree");
  });

  test("formats digest as JSON", () => {
    const digest = createDigestResult();
    const output = formatDigest(digest, { format: "json", formatterOptions: { json: { pretty: false } } });

    const parsed = JSON.parse(output);
    expect(parsed.metadata.workspaceRoot).toBe("/workspace");
  });

  test("supports custom formatter registrations", () => {
    class UpperMarkdownFormatter extends MarkdownFormatter {
      public override finalize(digestResult: ReturnType<typeof createDigestResult>): string {
        return super.finalize(digestResult).toUpperCase();
      }
    }

    registerFormatter("upper", (options, templates) => new UpperMarkdownFormatter(options, templates));

    const digest = createDigestResult();
    const output = formatDigest(digest, { format: "upper" });

    expect(output).toContain("# DIGEST SUMMARY");

    unregisterFormatter("upper");
  });
});
