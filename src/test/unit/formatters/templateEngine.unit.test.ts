import { describe, expect, test } from "@jest/globals";
import { TemplateEngine } from "../../../formatters/templateEngine";
import type { TemplateVariables } from "../../../formatters/types";

describe("TemplateEngine", () => {
  test("replaces nested variables", () => {
    const engine = new TemplateEngine({
      header: "{{metadata.generatorVersion}}-{{summary.overview.totalFiles}}"
    });

    const output = engine.apply(
      "header",
      "fallback",
      {
        metadata: { generatorVersion: "1.2.3" },
        summary: { overview: { totalFiles: 42 } }
      } as TemplateVariables
    );

    expect(output).toBe("1.2.3-42");
  });

  test("omits missing variables instead of throwing", () => {
    const engine = new TemplateEngine({
      header: "A={{metadata.missing}};B={{summary.overview.totalFiles}}"
    });

    const output = engine.apply(
      "header",
      "fallback",
      {
        summary: { overview: { totalFiles: 7 } }
      } as TemplateVariables
    );

    expect(output).toBe("A=;B=7");
  });

  test("stringifies objects when interpolated", () => {
    const engine = new TemplateEngine({
      summary: "{{digest.statistics}}"
    });

    const output = engine.apply(
      "summary",
      "fallback",
      {
        digest: {
          statistics: {
            filesProcessed: 2,
            totalTokens: 384
          }
        }
      } as TemplateVariables
    );

    expect(output).toBe("{\n  \"filesProcessed\": 2,\n  \"totalTokens\": 384\n}");
  });
});