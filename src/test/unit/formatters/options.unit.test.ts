import { describe, expect, jest, test } from "@jest/globals";
import { cloneFormatterOptions, mergeFormatterOptions, type FormatterOptionsDiagnostics } from "../../../formatters/base/options";
import { DEFAULT_FORMATTER_OPTIONS, type FormatterOptions } from "../../../formatters/types";

function createDiagnosticsMock() {
  const warnings: Array<{ message: string; metadata?: Record<string, unknown> }> = [];
  const telemetry: Array<{ event: string; properties?: Record<string, unknown> }> = [];

  const diagnostics: FormatterOptionsDiagnostics = {
    addError: jest.fn(),
    addWarning: (message, metadata) => {
      warnings.push(metadata ? { message, metadata } : { message });
    },
    trackTelemetry: (event, properties) => {
      telemetry.push(properties ? { event, properties } : { event });
    }
  };

  return { diagnostics, warnings, telemetry };
}

describe("formatter options helpers", () => {
  test("cloneFormatterOptions returns deep clone without sharing nested references", () => {
    const cloned = cloneFormatterOptions(DEFAULT_FORMATTER_OPTIONS);

    expect(cloned).not.toBe(DEFAULT_FORMATTER_OPTIONS);
    expect(cloned.markdown).not.toBe(DEFAULT_FORMATTER_OPTIONS.markdown);
    expect(cloned.json).not.toBe(DEFAULT_FORMATTER_OPTIONS.json);
    expect(cloned.text).not.toBe(DEFAULT_FORMATTER_OPTIONS.text);
    expect(cloned.text?.columnWidths).not.toBe(DEFAULT_FORMATTER_OPTIONS.text?.columnWidths);

    cloned.includeMetadata = !cloned.includeMetadata;
    expect(DEFAULT_FORMATTER_OPTIONS.includeMetadata).toBe(true);
  });

  test("mergeFormatterOptions applies sanitized overrides and preserves defaults", () => {
    const overrides: Partial<FormatterOptions> = {
      includeMetadata: false,
      maxFileContentLength: 512,
      sectionSeparator: "\n--\n",
      markdown: {
        headerLevel: 4,
        tableOfContentsDepth: 2
      },
      text: {
        lineWidth: 100,
        columnWidths: {
          label: 24,
          value: 60
        }
      }
    };

    const { diagnostics } = createDiagnosticsMock();
    const merged = mergeFormatterOptions(DEFAULT_FORMATTER_OPTIONS, overrides, diagnostics);

    expect(merged.includeMetadata).toBe(false);
    expect(merged.maxFileContentLength).toBe(512);
    expect(merged.sectionSeparator).toBe("\n--\n");
    expect(merged.markdown?.headerLevel).toBe(4);
    expect(merged.markdown?.tableOfContentsDepth).toBe(2);
    expect(merged.text?.lineWidth).toBe(100);
    expect(merged.text?.columnWidths?.label).toBe(24);
    expect(merged.text?.columnWidths?.value).toBe(60);

    merged.text!.columnWidths!.label = 10;
    expect(DEFAULT_FORMATTER_OPTIONS.text?.columnWidths?.label).toBe(18);
  });

  test("mergeFormatterOptions reports invalid overrides via diagnostics and telemetry", () => {
    const overrides: Partial<FormatterOptions> = {
      includeFiles: "yes" as unknown as boolean,
      maxFileContentLength: -5,
      sectionSeparator: "",
      markdown: {
        headerLevel: "three" as unknown as number
      },
      text: {
        columnWidths: {
          value: "wide" as unknown as number
        }
      }
    };

    const { diagnostics, warnings, telemetry } = createDiagnosticsMock();
    const merged = mergeFormatterOptions(DEFAULT_FORMATTER_OPTIONS, overrides, diagnostics);

    expect(merged.includeFiles).toBe(DEFAULT_FORMATTER_OPTIONS.includeFiles);
    expect(merged.maxFileContentLength).toBeUndefined();
    expect(merged.sectionSeparator).toBe(DEFAULT_FORMATTER_OPTIONS.sectionSeparator);
    expect(merged.markdown?.headerLevel).toBe(
      DEFAULT_FORMATTER_OPTIONS.markdown?.headerLevel
    );
    expect(merged.text?.columnWidths).toEqual(
      DEFAULT_FORMATTER_OPTIONS.text?.columnWidths
    );

    expect(warnings.length).toBeGreaterThan(0);
    expect(telemetry.some((entry) => entry.event === "formatter.options.invalid")).toBe(true);
  });
});
