import { describe, expect, test } from "@jest/globals";
import { JsonFormatter } from "../../../formatters/jsonFormatter";
import { createDigestResult } from "./formatterTestUtils";

describe("JsonFormatter", () => {
  test("produces schema compliant JSON", () => {
    const formatter = new JsonFormatter({ json: { pretty: true } });
    const digest = createDigestResult();

    const output = formatter.finalize(digest);
    const parsed = JSON.parse(output);

    expect(parsed).toHaveProperty("metadata.generatedAt");
    expect(parsed).toHaveProperty("summary.tableOfContents");
    expect(parsed.files).toHaveLength(digest.content.files.length);
    expect(parsed.schema_version).toBeDefined();
  });

  test("streams NDJSON when enabled", () => {
    const formatter = new JsonFormatter({ json: { stream: true, pretty: false } });
    const digest = createDigestResult();

    const output = formatter.finalize(digest);
    const records = output.split("\n").map((line) => JSON.parse(line));

    expect(records[0].type).toBe("metadata");
    expect(records.at(-1)?.type).toBe("statistics");
    expect(records.filter((record) => record.type === "file")).toHaveLength(digest.content.files.length);
  });

  test("applies content truncation", () => {
    const formatter = new JsonFormatter({ maxFileContentLength: 10 });
    const digest = createDigestResult({
      files: [
        {
          path: "/workspace/long.txt",
          relativePath: "long.txt",
          tokens: 10,
          content: "abcdefghijklmnopqrstuvwxyz",
          encoding: "utf8",
          truncated: false,
          redacted: false,
          languageId: "plaintext",
          metadata: { size: 26, lines: 1, processingTime: 1 },
          warnings: [],
          errors: []
        }
      ]
    });

    const output = formatter.finalize(digest);
    const parsed = JSON.parse(output);

    expect(parsed.files[0].content).toContain("... (truncated)");
  });
});
