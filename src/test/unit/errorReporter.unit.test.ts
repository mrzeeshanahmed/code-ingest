import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import * as vscode from "vscode";

import { ErrorCategory, ErrorSeverity, type ErrorContext } from "../../utils/errorHandler";
import { ErrorReporter } from "../../services/errorReporter";
import type { Logger } from "../../utils/gitProcessManager";
import type { ConfigurationService } from "../../services/configurationService";

jest.mock("node:fs/promises", () => ({
  appendFile: jest.fn(() => Promise.resolve()),
  mkdir: jest.fn(() => Promise.resolve())
}));

const fs = jest.requireMock("node:fs/promises") as {
  appendFile: jest.Mock;
  mkdir: jest.Mock;
};

type VSCodeMock = typeof vscode & {
  __reset(): void;
  workspace: typeof vscode.workspace & {
    getConfiguration: jest.Mock;
  };
};

describe("ErrorReporter", () => {
  const vsMock = vscode as unknown as VSCodeMock;
  let logger: Logger;
  let configService: Pick<ConfigurationService, "loadConfig"> & { loadConfig: jest.Mock };
  let reporter: ErrorReporter;

  beforeEach(() => {
    jest.useFakeTimers();
    vsMock.__reset();

    logger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn()
    };

    configService = {
      loadConfig: jest.fn(() => ({ maxFiles: 1000 }))
    };

    const configMock = {
      get: jest.fn((key: string, fallback?: unknown) => {
        switch (key) {
          case "enableCrashLog":
            return false;
          case "enableTelemetry":
            return false;
          default:
            return fallback;
        }
      })
    };

    vsMock.workspace.getConfiguration.mockReturnValue(configMock);

  reporter = new ErrorReporter(configService as unknown as ConfigurationService, logger);
  });

  afterEach(() => {
    reporter.dispose();
    jest.clearAllTimers();
    jest.useRealTimers();
    fs.appendFile.mockClear();
    fs.mkdir.mockClear();
  });

  it("buffers reported errors and logs metadata", async () => {
    const error = new Error("Network unreachable");
    const context: ErrorContext & { errorId: string; classification: Parameters<ErrorReporter["reportError"]>[1]["classification"] } = {
      operation: "clone",
      component: "git",
      userFacing: true,
      errorId: "ERR-test",
      classification: {
        category: ErrorCategory.NETWORK,
        severity: ErrorSeverity.MEDIUM,
        userFriendlyMessage: "Network connection error",
        technicalDetails: "details",
        suggestedActions: [],
        isRecoverable: true,
        isRetryable: true
      }
    };

    await reporter.reportError(error, context);

    expect(reporter.getErrorBuffer()).toHaveLength(1);
    expect(logger.error).toHaveBeenCalledWith("Error reported: ERR-test", {
      category: ErrorCategory.NETWORK,
      severity: ErrorSeverity.MEDIUM
    });
  });

  it("flushes buffered errors to the configured crash log", async () => {
    const logPath = path.join(process.cwd(), "tmp", "crash.log");

    vsMock.workspace.getConfiguration.mockReturnValue({
      get: jest.fn((key: string) => {
        if (key === "enableCrashLog") {
          return true;
        }
        if (key === "crashLogPath") {
          return logPath;
        }
        if (key === "enableTelemetry") {
          return false;
        }
        return undefined;
      })
    });

    const context = {
      operation: "clone",
      component: "git",
      errorId: "ERR-write",
      classification: {
        category: ErrorCategory.NETWORK,
        severity: ErrorSeverity.MEDIUM,
        userFriendlyMessage: "Network connection error",
        technicalDetails: "details",
        suggestedActions: [],
        isRecoverable: true,
        isRetryable: true
      }
    } satisfies ErrorContext & { errorId: string; classification: Parameters<ErrorReporter["reportError"]>[1]["classification"] };

    await reporter.reportError(new Error("Network unreachable"), context);
    await reporter.flushErrors();

    expect(fs.mkdir).toHaveBeenCalledWith(path.dirname(logPath), { recursive: true });
    expect(fs.appendFile).toHaveBeenCalled();
    expect(reporter.getErrorBuffer()).toHaveLength(0);
  });

  it("immediately flushes critical errors", async () => {
    const logPath = path.join(process.cwd(), "tmp", "critical.log");

    vsMock.workspace.getConfiguration.mockReturnValue({
      get: jest.fn((key: string) => {
        if (key === "enableCrashLog") {
          return true;
        }
        if (key === "crashLogPath") {
          return logPath;
        }
        if (key === "enableTelemetry") {
          return false;
        }
        return undefined;
      })
    });

    const context = {
      operation: "generate",
      component: "pipeline",
      errorId: "ERR-critical",
      classification: {
        category: ErrorCategory.RESOURCE,
        severity: ErrorSeverity.CRITICAL,
        userFriendlyMessage: "System resources exhausted",
        technicalDetails: "details",
        suggestedActions: [],
        isRecoverable: true,
        isRetryable: true
      }
    } satisfies ErrorContext & { errorId: string; classification: Parameters<ErrorReporter["reportError"]>[1]["classification"] };

    await reporter.reportError(new Error("Out of memory"), context);

    expect(fs.appendFile).toHaveBeenCalled();
    expect(reporter.getErrorBuffer()).toHaveLength(0);
  });

  it("supports legacy report API", () => {
    const spy = jest.spyOn(reporter, "reportError");

    reporter.report(new Error("Legacy error"), { source: "legacy", command: "run" });

    expect(spy).toHaveBeenCalledTimes(1);
  });
});
