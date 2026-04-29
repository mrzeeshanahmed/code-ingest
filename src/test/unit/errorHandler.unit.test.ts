import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import * as vscode from "vscode";

import {
  ErrorCategory,
  ErrorHandler,
  ErrorSeverity,
  type ErrorContext,
  type RecoveryStrategy
} from "../../utils/errorHandler";
import type { ErrorReporter } from "../../services/errorReporter";
import type { Logger } from "../../utils/gitProcessManager";

type VSCodeMock = typeof vscode & {
  __reset(): void;
  window: typeof vscode.window & {
    showErrorMessage: jest.Mock;
    showInformationMessage: jest.Mock;
    showWarningMessage: jest.Mock;
    createOutputChannel: jest.Mock;
  };
};

describe("ErrorHandler", () => {
  const vsMock = vscode as unknown as VSCodeMock;
  let errorReporter: jest.Mocked<Pick<ErrorReporter, "reportError">>;
  let logger: Logger;
  let handler: ErrorHandler;

  beforeEach(() => {
    vsMock.__reset();
    errorReporter = {
      reportError: jest.fn().mockImplementation(async () => undefined)
    } as unknown as jest.Mocked<Pick<ErrorReporter, "reportError">>;

    logger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn()
    };

  vsMock.window.showErrorMessage.mockImplementation(async () => undefined);
  vsMock.window.showInformationMessage.mockImplementation(async () => undefined);
  vsMock.window.showWarningMessage.mockImplementation(async () => undefined);

    handler = new ErrorHandler(errorReporter as unknown as ErrorReporter, logger);
  });

  it("classifies network errors and exposes recovery action", async () => {
    const error = new Error("Network timeout occurred");
    const context: ErrorContext = {
      operation: "cloneRemote",
      component: "gitService",
      metadata: {},
      userFacing: true
    };

    const strategies = (handler as unknown as { recoveryStrategies: Map<ErrorCategory, RecoveryStrategy> }).recoveryStrategies;
    const networkStrategy = strategies.get(ErrorCategory.NETWORK)!;
    const recoverSpy = jest.spyOn(networkStrategy, "recover").mockResolvedValue(undefined);

    const result = await handler.handleError(error, context);

    expect(result.handled).toBe(true);
    expect(result.shouldRetry).toBe(true);
    expect(result.reportError).toBe(false);
    expect(result.userMessage).toContain("Network");
    expect(result.recoveryAction).toBeDefined();

    await result.recoveryAction?.();
    expect(recoverSpy).toHaveBeenCalledWith(error, context);
    expect(vsMock.window.showErrorMessage).toHaveBeenCalled();
  });

  it("reports high severity errors to the reporter", async () => {
    const error = new Error("Authentication failed: forbidden");
    const context: ErrorContext = {
      operation: "cloneRemote",
      component: "gitService",
      userFacing: true
    };

    await handler.handleError(error, context);

    expect(errorReporter.reportError).toHaveBeenCalledTimes(1);
    const payload = errorReporter.reportError.mock.calls[0][1];
    expect(payload.classification.severity).toBe(ErrorSeverity.HIGH);
    expect(payload.errorId).toMatch(/^ERR-/);
  });

  it("avoids user notification when context is not user-facing", async () => {
    const error = new Error("Validation failed due to malformed input");
    const context: ErrorContext = {
      operation: "parseConfig",
      component: "configuration",
      userFacing: false
    };

    vsMock.window.showErrorMessage.mockClear();

    const result = await handler.handleError(error, context);

    expect(result.shouldRetry).toBe(false);
    expect(vsMock.window.showErrorMessage).not.toHaveBeenCalled();
  });
});