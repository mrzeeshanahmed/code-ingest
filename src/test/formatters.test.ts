import { describe, expect, it } from "@jest/globals";
import { formatDigest } from "../utils/digestFormatters";
import { createDigestResult } from "./unit/formatters/formatterTestUtils";

describe("formatDigest integration", () => {
  it("returns markdown output by default", () => {
    const digest = createDigestResult();
    const output = formatDigest(digest);

    expect(output).toContain("# Digest Summary");
    expect(output).toContain("File Tree");
  });

  it("respects formatter options", () => {
    const digest = createDigestResult();
    const output = formatDigest(digest, {
      format: "text",
      formatterOptions: {
        text: {
          useAsciiBoxes: false
        }
      }
    });

    expect(output).toContain("Digest Metadata");
    expect(output).not.toContain("┌");
  });
});