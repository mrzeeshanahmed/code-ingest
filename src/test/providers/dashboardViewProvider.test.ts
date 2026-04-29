import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import * as vscode from "vscode";
import { COMMAND_MAP } from "../../commands/commandMap";
import { DashboardViewProvider } from "../../providers/dashboardViewProvider";
import { WebviewMessageEnvelope } from "../../providers/messageEnvelope";
import { detectFallbackHtml, setWebviewHtml } from "../../providers/webviewHelpers";
import { loadCommandValidator } from "../../providers/commandValidator";
import type { WebviewPanelManager } from "../../webview/webviewPanelManager";
import type { ErrorReporter } from "../../services/errorReporter";

type MessageListener = (message: unknown) => unknown;

jest.mock("../../providers/webviewHelpers", () => ({
  setWebviewHtml: jest.fn(),
  detectFallbackHtml: jest.fn(() => ({ isFallback: false }))
}));

jest.mock("../../providers/commandValidator", () => ({
  loadCommandValidator: jest.fn()
}));

describe("DashboardViewProvider", () => {
  let tokenSpy: jest.SpiedFunction<typeof WebviewMessageEnvelope.generateToken>;
  const mockLoadCommandValidator = loadCommandValidator as jest.MockedFunction<typeof loadCommandValidator>;
  const executeCommandMock = vscode.commands.executeCommand as jest.MockedFunction<
    typeof vscode.commands.executeCommand
  >;
  const mockDetectFallback = detectFallbackHtml as jest.MockedFunction<typeof detectFallbackHtml>;

  beforeEach(() => {
    tokenSpy = jest.spyOn(WebviewMessageEnvelope, "generateToken").mockReturnValue("dashboard-token");
    mockLoadCommandValidator.mockResolvedValue((commandId, payload) => ({ ok: true, value: payload }));
    executeCommandMock.mockResolvedValue(undefined);
    (setWebviewHtml as jest.Mock).mockReturnValue("<!DOCTYPE html><html lang=\"en\"><body></body></html>");
    mockDetectFallback.mockReturnValue({ isFallback: false });
  });

  afterEach(() => {
    tokenSpy.mockRestore();
    mockLoadCommandValidator.mockReset();
    (setWebviewHtml as jest.Mock).mockReset();
    mockDetectFallback.mockReset();
    executeCommandMock.mockReset();
    jest.clearAllMocks();
  });

  it("rejects invalid payloads with SHOW_ERROR and ack", async () => {
    const harness = createViewHarness();
    const provider = new DashboardViewProvider(
      vscode.Uri.file("/tmp"),
      harness.panelManager,
      async () => {},
      harness.errorReporter
    );

    const validator = jest.fn((commandId: string, payload: unknown) => {
      if (commandId === COMMAND_MAP.WEBVIEW_TO_HOST.GENERATE_DIGEST) {
        return { ok: false as const, reason: "invalid_selection", errors: [] };
      }
      return { ok: true as const, value: payload };
    });
    mockLoadCommandValidator.mockResolvedValueOnce(validator);

    await provider.resolveWebviewView(harness.webviewView, {} as vscode.WebviewViewResolveContext, new vscode.CancellationTokenSource().token);

    expect(harness.messageListeners.length).toBeGreaterThan(0);

    const listener = harness.messageListeners[0];
    const envelope = new WebviewMessageEnvelope({ sessionToken: "dashboard-token", role: "webview" });
    const message = envelope.createMessage(
      "command",
      COMMAND_MAP.WEBVIEW_TO_HOST.GENERATE_DIGEST,
      { selectedFiles: [] },
      { expectsAck: true }
    );

    await listener(message);
    await new Promise((resolve) => setImmediate(resolve));

    expect(validator).toHaveBeenCalledWith(COMMAND_MAP.WEBVIEW_TO_HOST.GENERATE_DIGEST, { selectedFiles: [] });
    expect(harness.panelManagerMocks.sendCommand).toHaveBeenCalledWith(
      COMMAND_MAP.HOST_TO_WEBVIEW.SHOW_ERROR,
      expect.objectContaining({
        title: "Invalid request",
        message: expect.stringContaining("rejected")
      })
    );
    expect(vscode.commands.executeCommand).not.toHaveBeenCalled();

    expect(harness.webview.postMessage).toHaveBeenCalledTimes(1);
    const response = harness.webview.postMessage.mock.calls[0][0] as unknown as {
      payload: { ok?: boolean; reason?: string };
    };
    expect(response.payload).toEqual({ ok: false, reason: "invalid_selection" });
  });

  it("wraps command failures and reports them", async () => {
    const harness = createViewHarness();
    const provider = new DashboardViewProvider(
      vscode.Uri.file("/tmp"),
      harness.panelManager,
      async () => {},
      harness.errorReporter
    );

    await provider.resolveWebviewView(
      harness.webviewView,
      {} as vscode.WebviewViewResolveContext,
      new vscode.CancellationTokenSource().token
    );

    const listener = harness.messageListeners[0];
    const envelope = new WebviewMessageEnvelope({ sessionToken: "dashboard-token", role: "webview" });
    const message = envelope.createMessage(
      "command",
      COMMAND_MAP.WEBVIEW_TO_HOST.GENERATE_DIGEST,
      { selectedFiles: ["foo.ts"] },
      { expectsAck: true }
    );

    executeCommandMock.mockRejectedValueOnce(new Error("boom"));

    await listener(message);
    await new Promise((resolve) => setImmediate(resolve));

    expect(harness.panelManagerMocks.sendCommand).toHaveBeenCalledWith(
      COMMAND_MAP.HOST_TO_WEBVIEW.SHOW_ERROR,
      expect.objectContaining({
        title: "Command failed",
        message: expect.stringContaining("boom")
      })
    );

    expect(harness.webview.postMessage).toHaveBeenCalledTimes(1);
    const response = harness.webview.postMessage.mock.calls[0][0] as unknown as {
      payload: { ok?: boolean; reason?: string };
    };
    expect(response.payload).toEqual({ ok: false, reason: "boom" });

    expect(harness.errorReporter.report).toHaveBeenCalledTimes(1);
    const reportMock = harness.errorReporter.report as jest.Mock;
    const reportedError = reportMock.mock.calls[0][0] as {
      metadata?: Record<string, unknown>;
    };
    expect(reportedError).toBeInstanceOf(Error);
    expect(reportedError.metadata).toMatchObject({ command: COMMAND_MAP.WEBVIEW_TO_HOST.GENERATE_DIGEST });
    expect(reportMock.mock.calls[0][1]).toMatchObject({
      command: COMMAND_MAP.WEBVIEW_TO_HOST.GENERATE_DIGEST,
      source: "dashboard"
    });
  });

  it("reports fallback HTML via the error reporter once", async () => {
    (setWebviewHtml as jest.Mock).mockReturnValueOnce(
      '<!DOCTYPE html><html><body data-code-ingest-fallback="missing-assets"></body></html>'
    );
    mockDetectFallback
      .mockReturnValueOnce({ isFallback: true, reason: "missing-assets" })
      .mockReturnValue({ isFallback: false });

    const harness = createViewHarness();
    const provider = new DashboardViewProvider(
      vscode.Uri.file("/tmp"),
      harness.panelManager,
      async () => {},
      harness.errorReporter
    );

    await provider.resolveWebviewView(
      harness.webviewView,
      {} as vscode.WebviewViewResolveContext,
      new vscode.CancellationTokenSource().token
    );

    expect(harness.errorReporter.report).toHaveBeenCalledTimes(1);
    const [error, context] = (harness.errorReporter.report as jest.Mock).mock.calls[0];
    expect(error).toBeInstanceOf(Error);
    expect((context as { metadata?: Record<string, unknown> }).metadata).toMatchObject({ reason: "missing-assets" });

    await provider.resolveWebviewView(
      harness.webviewView,
      {} as vscode.WebviewViewResolveContext,
      new vscode.CancellationTokenSource().token
    );

    expect(harness.errorReporter.report).toHaveBeenCalledTimes(1);
  });
});

function createViewHarness() {
  const messageListeners: MessageListener[] = [];
  const webview = {
    html: "",
    options: {},
    postMessage: jest.fn(() => Promise.resolve(true)),
    asWebviewUri: jest.fn((uri) => uri),
    onDidReceiveMessage: jest.fn((listener: MessageListener) => {
      messageListeners.push(listener);
      return { dispose: jest.fn() };
    })
  } as unknown as vscode.Webview;

  const webviewView = {
    webview,
    visible: true,
    onDidDispose: jest.fn(() => ({ dispose: jest.fn() })),
    onDidChangeVisibility: jest.fn(() => ({ dispose: jest.fn() }))
  } as unknown as vscode.WebviewView;

  const panelManagerMocks = {
    getStateSnapshot: jest.fn(() => undefined),
    setStateSnapshot: jest.fn(),
    sendCommand: jest.fn(),
    createAndShowPanel: jest.fn(),
    tryRestoreState: jest.fn(() => false)
  };
  const panelManager = panelManagerMocks as unknown as WebviewPanelManager;

  const errorReporter = {
    report: jest.fn()
  } as unknown as ErrorReporter;

  return {
    webviewView,
    webview: webview as unknown as { postMessage: jest.Mock },
    messageListeners,
    panelManager,
    panelManagerMocks,
    errorReporter
  };
}