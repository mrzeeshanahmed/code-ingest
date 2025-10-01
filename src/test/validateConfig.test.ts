import { describe, expect, it } from "@jest/globals";
import { validateConfig, type DigestConfig } from "../utils/validateConfig";

function createDiagnostics() {
  const errors: string[] = [];
  const warnings: string[] = [];
  return {
    errors,
    warnings,
    collector: {
      addError: (message: string) => {
        errors.push(message);
      },
      addWarning: (message: string) => {
        warnings.push(message);
      }
    }
  };
}

describe("validateConfig", () => {
  it("normalizes invalid include/exclude arrays and records diagnostics", () => {
    const { collector, errors } = createDiagnostics();
    const config: DigestConfig = {
      include: ["src", 42 as unknown as string],
      exclude: []
    };

    validateConfig(config, collector);

    expect(config.include).toEqual(["src"]);
    expect(config.exclude).toEqual(["node_modules", "dist", "out"]);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("coerces numeric fields and enforces minimum concurrency", () => {
    const { collector, warnings } = createDiagnostics();
    const config: DigestConfig = {
      maxDepth: -1,
      maxFiles: 10.8,
      maxConcurrency: 0
    };

    validateConfig(config, collector);

    expect(config.maxDepth).toBe(5);
    expect(config.maxFiles).toBe(10);
    expect(config.maxConcurrency).toBe(1);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("applies defaults and removes invalid workspaceRoot", () => {
    const { collector } = createDiagnostics();
    const config: DigestConfig = {
      workspaceRoot: 123 as unknown as string,
      outputFormat: "pdf" as unknown as DigestConfig["outputFormat"],
      binaryFilePolicy: "unknown" as unknown as DigestConfig["binaryFilePolicy"]
    };

    validateConfig(config, collector);

    expect(config.workspaceRoot).toBeUndefined();
    expect(config.outputFormat).toBe("markdown");
    expect(config.binaryFilePolicy).toBe("skip");
  });

  it("throws when no configuration object is provided", () => {
    expect(() => validateConfig(undefined as unknown as DigestConfig, createDiagnostics().collector)).toThrow(
      /configuration object/
    );
  });
});