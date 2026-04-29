import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import * as vscode from "vscode";
import { COMMAND_MAP } from "../../commands/commandMap";
import type { CommandServices } from "../../commands/types";
import type { ErrorReporter } from "../../services/errorReporter";

jest.mock("../../providers/commandValidator", () => ({
  loadCommandValidator: jest.fn()
}));

import { loadCommandValidator } from "../../providers/commandValidator";
import { __testing } from "../../extension";

describe("createCommandWrapper", () => {
  const registerCommandMock = vscode.commands.registerCommand as jest.MockedFunction<
    typeof vscode.commands.registerCommand
  >;
  const showErrorMessageMock = vscode.window.showErrorMessage as jest.MockedFunction<
    typeof vscode.window.showErrorMessage
  >;

  let context: vscode.ExtensionContext;
  let reportMock: jest.Mock;
  let errorReporter: ErrorReporter;
  let clipboardWriteMock: jest.Mock;
  const loadValidatorMock = loadCommandValidator as jest.MockedFunction<typeof loadCommandValidator>;

  beforeEach(() => {
    registerCommandMock.mockClear();
    showErrorMessageMock.mockClear();
    (vscode.window.showInformationMessage as jest.Mock).mockClear();

  const env = vscode.env as unknown as { clipboard?: { writeText: jest.Mock } };
    if (!env.clipboard) {
      env.clipboard = { writeText: jest.fn() as jest.Mock };
    }
    env.clipboard.writeText.mockClear?.();
    env.clipboard.writeText = jest.fn();
    clipboardWriteMock = env.clipboard.writeText;

    context = { subscriptions: [] } as unknown as vscode.ExtensionContext;
    reportMock = jest.fn();
    errorReporter = { report: reportMock } as unknown as ErrorReporter;
    showErrorMessageMock.mockResolvedValue(undefined);
    loadValidatorMock.mockReset();
  });

  afterEach(() => {
    if (context?.subscriptions) {
      context.subscriptions.length = 0;
    }
  });

  it("wraps thrown errors with metadata and reports them", async () => {
    const commandId = "codeIngest.test";
    const failure = new Error("boom");

    let registeredHandler: ((...args: unknown[]) => Promise<unknown>) | undefined;
    registerCommandMock.mockImplementation((_id, handler) => {
      registeredHandler = handler as unknown as (...args: unknown[]) => Promise<unknown>;
      return { dispose: jest.fn() } as unknown as vscode.Disposable;
    });

    __testing.createCommandWrapper(
      context,
      commandId,
      async () => {
        throw failure;
      },
      errorReporter
    );

    expect(registerCommandMock).toHaveBeenCalledWith(commandId, expect.any(Function));
    expect(context.subscriptions).toHaveLength(1);

    expect(registeredHandler).toBeDefined();
    let thrown: unknown;
    await registeredHandler?.().catch((error) => {
      thrown = error;
      return undefined;
    });

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).toBe(failure);
    expect((thrown as { metadata?: Record<string, unknown> }).metadata).toMatchObject({ commandId, stage: "command" });

    expect(reportMock).toHaveBeenCalledWith(failure, {
      command: commandId,
      source: "commandWrapper",
      metadata: expect.objectContaining({ commandId, stage: "command" })
    });
    expect(showErrorMessageMock).toHaveBeenCalledWith(
      expect.stringContaining(`Command failed (${commandId})`),
      "Details",
      "Report"
    );
    expect(clipboardWriteMock).not.toHaveBeenCalled();
  });

  it("still reports handler-managed errors but suppresses UI prompts", async () => {
    const commandId = "codeIngest.handled";
    const handledError = new Error("handled");
    (handledError as { handledByHost?: boolean }).handledByHost = true;

    let registeredHandler: ((...args: unknown[]) => Promise<unknown>) | undefined;
    registerCommandMock.mockImplementation((_id, handler) => {
      registeredHandler = handler as unknown as (...args: unknown[]) => Promise<unknown>;
      return { dispose: jest.fn() } as unknown as vscode.Disposable;
    });

    __testing.createCommandWrapper(
      context,
      commandId,
      async () => {
        throw handledError;
      },
      errorReporter
    );

    await registeredHandler?.().catch(() => undefined);

    expect(reportMock).toHaveBeenCalledWith(handledError, expect.objectContaining({ command: commandId }));
    expect(showErrorMessageMock).not.toHaveBeenCalled();
    expect((handledError as { metadata?: Record<string, unknown> }).metadata).toMatchObject({ commandId });
    expect(clipboardWriteMock).not.toHaveBeenCalled();
  });

  it("rejects invalid payloads using shared validator", async () => {
    const commandId = COMMAND_MAP.WEBVIEW_TO_HOST.UPDATE_SELECTION;
    loadValidatorMock.mockResolvedValue(() => ({ ok: false, reason: "invalid_payload" }));

    const diagnosticsAdd = jest.fn();
    const sendCommand = jest.fn();
    const services = {
      diagnostics: { add: diagnosticsAdd },
      gitignoreService: {},
      workspaceManager: {},
      webviewPanelManager: { sendCommand },
      performanceMonitor: {},
      diagnosticService: {},
      configurationService: {},
      errorReporter,
      extensionUri: vscode.Uri.parse("file:///tmp"),
      outputWriter: {}
    } as unknown as CommandServices;

    let registeredHandler: ((...invokeArgs: unknown[]) => Promise<unknown>) | undefined;
    registerCommandMock.mockImplementation((_id, handler) => {
      registeredHandler = handler as unknown as (...invokeArgs: unknown[]) => Promise<unknown>;
      return { dispose: jest.fn() } as unknown as vscode.Disposable;
    });

    __testing.createCommandWrapper(context, commandId, jest.fn(), errorReporter, services);

    const result = await registeredHandler?.({ bogus: true });

    expect(result).toEqual({ ok: false, reason: "invalid_payload" });
    expect(loadValidatorMock).toHaveBeenCalledWith();
    expect(diagnosticsAdd).toHaveBeenCalledWith(expect.stringContaining("rejected"));
    expect(sendCommand).toHaveBeenCalledWith(COMMAND_MAP.HOST_TO_WEBVIEW.SHOW_ERROR, {
      title: "Invalid request",
      message: expect.stringContaining("invalid_payload")
    });
  });

  it("passes validated payload value to the handler", async () => {
    const commandId = COMMAND_MAP.WEBVIEW_TO_HOST.UPDATE_SELECTION;
    const sanitizedPayload = { filePath: "src/index.ts", selected: false };
    loadValidatorMock.mockResolvedValue(() => ({ ok: true, value: sanitizedPayload }));

    const handler = jest.fn();

    let registeredHandler: ((...invokeArgs: unknown[]) => Promise<unknown>) | undefined;
    registerCommandMock.mockImplementation((_id, commandHandler) => {
      registeredHandler = commandHandler as unknown as (...invokeArgs: unknown[]) => Promise<unknown>;
      return { dispose: jest.fn() } as unknown as vscode.Disposable;
    });

    const services = {
      diagnostics: { add: jest.fn() },
      gitignoreService: {},
      workspaceManager: {},
      webviewPanelManager: { sendCommand: jest.fn() },
      performanceMonitor: {},
      diagnosticService: {},
      configurationService: {},
      errorReporter,
      extensionUri: vscode.Uri.parse("file:///tmp"),
      outputWriter: {}
    } as unknown as CommandServices;

    __testing.createCommandWrapper(context, commandId, handler, errorReporter, services);

    await registeredHandler?.({ filePath: "ignored", selected: true });

    expect(handler).toHaveBeenCalledWith(sanitizedPayload);
  });

  it("emits SHOW_ERROR to the webview when handler throws", async () => {
    const commandId = COMMAND_MAP.WEBVIEW_TO_HOST.GENERATE_DIGEST;
    const failure = Object.assign(new Error("digest failed"), {
      showError: { title: "Digest failed", message: "Details", runId: "run-1" }
    });

    const sendCommand = jest.fn();
    const services = {
      diagnostics: { add: jest.fn(), getAll: jest.fn(() => []) },
      gitignoreService: {},
      workspaceManager: {},
      webviewPanelManager: { sendCommand },
      performanceMonitor: {},
      diagnosticService: {},
      configurationService: {},
      errorReporter,
      extensionUri: vscode.Uri.file("/extension"),
      outputWriter: {}
    } as unknown as CommandServices;

    let registeredHandler: ((...args: unknown[]) => Promise<unknown>) | undefined;
    registerCommandMock.mockImplementation((_id, handler) => {
      registeredHandler = handler as unknown as (...args: unknown[]) => Promise<unknown>;
      return { dispose: jest.fn() } as unknown as vscode.Disposable;
    });

    __testing.createCommandWrapper(
      context,
      commandId,
      async () => {
        throw failure;
      },
      errorReporter,
      services
    );

    await registeredHandler?.().catch(() => undefined);

    expect(sendCommand).toHaveBeenCalledWith(COMMAND_MAP.HOST_TO_WEBVIEW.SHOW_ERROR, {
      title: "Digest failed",
      message: "Details",
      runId: "run-1"
    });
    expect((failure as { handledByHost?: boolean }).handledByHost).toBe(true);
    expect(reportMock).toHaveBeenCalledWith(failure, {
      command: commandId,
      source: "commandWrapper",
      metadata: expect.objectContaining({ commandId, runId: "run-1" })
    });
    expect(showErrorMessageMock).not.toHaveBeenCalled();
  });
});