import { Buffer } from "node:buffer";
import { jest } from "@jest/globals";
import type { ProcessedContent } from "../../../services/contentProcessor";
import type { TokenAnalysis, TokenBudgetOptions } from "../../../services/tokenAnalyzer";

export class MockContentProcessor {
  public readonly processFile = jest.fn<(filePath: string, options?: unknown) => Promise<ProcessedContent>>();
  public readonly processFileStream = jest.fn<
    (filePath: string, options?: unknown, stats?: unknown, startedAt?: number) => Promise<ProcessedContent>
  >();
  public readonly detectBinaryFile = jest.fn<(filePath: string) => Promise<boolean>>();
  public readonly detectLanguage = jest.fn<(filePath: string, content?: string) => string>();
  public readonly estimateLines = jest.fn<(content: string) => number>();
}

export class MockTokenAnalyzer {
  public readonly analyze = jest.fn<
    (content: string, options?: { budget?: TokenBudgetOptions; skipCache?: boolean }) => Promise<TokenAnalysis>
  >();
  public readonly analyzeBatch = jest.fn<
    (contents: string[], options?: { budget?: TokenBudgetOptions }) => Promise<TokenAnalysis[]>
  >();
  public readonly formatTokens = jest.fn<(tokens: number) => string>();
  public readonly warnIfExceedsLimit = jest.fn<(tokens: number, limit: number) => string | null>();
}

export class TestDataGenerator {
  public static generateNotebook(cellTypes: string[], hasOutputs: boolean): Record<string, unknown> {
    const cells = cellTypes.map((type, index) => {
      const lower = type.toLowerCase();
      const base: Record<string, unknown> = {
        cell_type: lower,
        source: lower === "markdown" ? [`# Heading ${index + 1}\n`, "Some *markdown* content\n"] : [`print("cell ${index + 1}")\n`],
        metadata: { name: `cell-${index + 1}` },
        execution_count: lower === "code" ? index + 1 : null
      };

      if (hasOutputs && lower === "code") {
        base.outputs = [
          {
            output_type: "stream",
            name: "stdout",
            text: ["result line 1\n", "result line 2\n"]
          },
          {
            output_type: "display_data",
            data: {
              "text/plain": "plain output",
              "image/png": Buffer.from("pngdata").toString("base64")
            }
          }
        ];
      }

      return base;
    });

    return {
      cells,
      metadata: {
        kernelspec: { name: "python3" }
      },
      nbformat: 4
    };
  }

  public static generateCodeFile(language: string, size: number): string {
    const header = `// language: ${language}\n`;
    const filler = "const value = 42;\n";
    const iterations = Math.max(1, Math.floor((size - header.length) / filler.length));
    return header + new Array(iterations).fill(filler).join("\n");
  }

  public static generateBinaryContent(type: string): Buffer {
    switch (type.toLowerCase()) {
      case "png":
        return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      case "zip":
        return Buffer.from([0x50, 0x4b, 0x03, 0x04]);
      default:
        return Buffer.from([0xff, 0xd8, 0xff, 0xdb]);
    }
  }
}
