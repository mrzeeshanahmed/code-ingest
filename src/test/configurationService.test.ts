import { afterEach, describe, expect, it, jest } from "@jest/globals";
import * as vscode from "vscode";
import { ConfigurationService } from "../services/configurationService";
import * as validateModule from "../utils/validateConfig";
import type { DigestConfig } from "../utils/validateConfig";
import { DEFAULT_CONFIG } from "../config/constants";

describe("ConfigurationService", () => {
  const diagnostics = {
    addError: jest.fn(),
    addWarning: jest.fn()
  };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("validates and returns the stored configuration", () => {
    jest.spyOn(validateModule, "validateConfig").mockImplementation(() => undefined);
    const initial = { include: ["src/**/*"], maxDepth: 3 };
    const service = new ConfigurationService(initial, diagnostics);

    const result = service.loadConfig();

    expect(validateModule.validateConfig).toHaveBeenCalledWith(expect.objectContaining(initial), diagnostics);
    expect(result).toMatchObject(initial);
    expect(result).not.toBe(initial);
  });

  it("merges workspace configuration with defaults and validates", () => {
    const workspaceOverrides = {
      include: ["lib"],
      respectGitIgnore: false,
      maxFiles: 10
    } as Record<string, unknown>;

    (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue(workspaceOverrides);

    const validateSpy = jest.spyOn(validateModule, "validateConfig").mockImplementation(() => undefined);

    const result = ConfigurationService.getWorkspaceConfig(undefined, diagnostics);

    expect(vscode.workspace.getConfiguration).toHaveBeenCalledWith("codeIngest", undefined);
    expect(validateSpy).toHaveBeenCalledWith(expect.any(Object), diagnostics);
    expect(result.include).toEqual(["lib"]);
    expect(result.exclude).toEqual(DEFAULT_CONFIG.exclude);
    expect(result.respectGitIgnore).toBe(false);
    expect(result.maxFiles).toBe(10);
  });

  describe("getFingerprint", () => {
    it("returns a stable fingerprint for sanitized configuration", () => {
      jest.spyOn(validateModule, "validateConfig").mockImplementation(() => undefined);
      const service = new ConfigurationService(
        {
          include: ["src/**/*", "test/**/*"],
          exclude: ["dist/**"],
          maxDepth: 3
        },
        diagnostics
      );

      const first = service.getFingerprint();
      const second = service.getFingerprint();

      expect(first).toEqual(second);
      expect(first).toHaveLength(40);
    });

    it("changes when relevant configuration values are updated", () => {
      jest.spyOn(validateModule, "validateConfig").mockImplementation(() => undefined);
      const service = new ConfigurationService({ include: ["src/**/*"] }, diagnostics);

      const baseline = service.getFingerprint();

      const updatedConfig: DigestConfig = {
        ...DEFAULT_CONFIG,
        include: ["src/**/*"],
        respectGitIgnore: false
      };
      service["config"] = updatedConfig;
      service.loadConfig();

      const updated = service.getFingerprint();
      expect(updated).not.toEqual(baseline);
    });

    it("normalizes include and exclude ordering for fingerprinting", () => {
      jest.spyOn(validateModule, "validateConfig").mockImplementation(() => undefined);
      const firstService = new ConfigurationService(
        { include: ["b", "a"], exclude: ["y", "x"] },
        diagnostics
      );
      const secondService = new ConfigurationService(
        { include: ["a", "b"], exclude: ["x", "y"] },
        diagnostics
      );

      const firstFingerprint = firstService.getFingerprint();
      const secondFingerprint = secondService.getFingerprint();

      expect(firstFingerprint).toEqual(secondFingerprint);
    });
  });
});