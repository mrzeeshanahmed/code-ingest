import { describe, expect, test } from "@jest/globals";
import { TextFormatter } from "../../../formatters/textFormatter";
import { createDigestResult } from "./formatterTestUtils";

describe("TextFormatter", () => {
  test("renders sections within ASCII boxes", () => {
    const formatter = new TextFormatter({
      text: {
        lineWidth: 60,
        useAsciiBoxes: true
      }
    });
    const digest = createDigestResult();

    const output = formatter.finalize(digest);

    expect(output).toContain("┌");
    expect(output).toContain("Digest Metadata");
    expect(output).toContain("File Tree");
  });

  test("renders without boxes when disabled", () => {
    const formatter = new TextFormatter({
      text: {
        lineWidth: 60,
        useAsciiBoxes: false
      }
    });
    const digest = createDigestResult();

    const output = formatter.finalize(digest);

    expect(output).toContain("Digest Metadata");
    expect(output).toContain("Summary");
    expect(output).not.toContain("┌");
  });

  test("applies ANSI coloring when enabled", () => {
    const formatter = new TextFormatter({
      text: {
        useAsciiBoxes: false,
        showColorCodes: true
      }
    });
    const digest = createDigestResult();

    const output = formatter.finalize(digest);

    expect(output).toContain("\u001b[36mDigest Metadata");
  });
});