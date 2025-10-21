import { describe, expect, test } from "@jest/globals";
import type { Formatter } from "../../../formatters/base/formatter.interface";
import type { DigestMetadata, DigestResult, DigestSummary, ProcessedFileContent } from "../../../services/digestGenerator";
import { createFormatter, listFormatters, registerFormatter, unregisterFormatter } from "../../../formatters/factory";

class StubFormatter implements Formatter {
  public readonly format = "stub" as const;
  public readonly mimeType = "text/plain";
  public readonly fileExtension = "stub";

  public buildHeader(_metadata: DigestMetadata): string {
    void _metadata;
    return "stub";
  }

  public buildSummary(_summary: DigestSummary): string {
    void _summary;
    return "stub";
  }

  public buildFileTree(_files: ProcessedFileContent[]): string {
    void _files;
    return "stub";
  }

  public buildFileContent(_file: ProcessedFileContent): string {
    void _file;
    return "stub";
  }

  public buildFooter(_statistics: DigestResult["statistics"]): string {
    void _statistics;
    return "stub";
  }

  public finalize(_digest: DigestResult): string {
    void _digest;
    return "stub";
  }

  public streamSectionsAsync(_digest: DigestResult): AsyncIterable<string> {
    void _digest;
    return (async function* stream() {
      yield "stub";
    })();
  }

  public supportsStreaming(): boolean {
    return false;
  }
}

describe("Formatter factory", () => {
  test("creates built-in formatters", () => {
    const formatter = createFormatter("markdown");
    expect(formatter.format).toBe("markdown");
  });

  test("registers and unregisters custom formatter", () => {
    registerFormatter("stub", () => new StubFormatter());

    const formatter = createFormatter("stub");
    expect(formatter.format).toBe("stub");

    unregisterFormatter("stub");
    expect(listFormatters()).not.toContain("stub");
  });

  test("throws for unknown formatter", () => {
    expect(() => createFormatter("unknown"))
      .toThrow("Unknown formatter");
  });
});
