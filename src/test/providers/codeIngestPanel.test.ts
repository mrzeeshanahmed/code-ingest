import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import * as path from "node:path";
import * as vscode from "vscode";
import { COMMAND_MAP } from "../../commands/commandMap";
import { CodeIngestPanel } from "../../providers/codeIngestPanel";
import { WebviewMessageEnvelope } from "../../providers/messageEnvelope";
import { detectFallbackHtml, setWebviewHtml } from "../../providers/webviewHelpers";
import { loadCommandValidator } from "../../providers/commandValidator";

jest.mock("../../providers/webviewHelpers", () => ({
  setWebviewHtml: jest.fn(),
  detectFallbackHtml: jest.fn(() => ({ isFallback: false }))
}));

jest.mock("../../providers/commandValidator", () => {
  const validator = (_commandId: string, payload: unknown) => ({ ok: true as const, value: payload });
  return {
    loadCommandValidator: jest.fn(() => Promise.resolve(validator))
  };
});

const mockLoadCommandValidator = loadCommandValidator as jest.MockedFunction<typeof loadCommandValidator>;

type MessageListener = (message: unknown) => unknown;

describe("CodeIngestPanel", () => {
  let tokenSpy: jest.SpiedFunction<() => string>;
  let handlerChannel: { appendLine: jest.Mock };
  const mockDetectFallback = detectFallbackHtml as jest.MockedFunction<typeof detectFallbackHtml>;

  beforeEach(() => {
    tokenSpy = jest.spyOn(WebviewMessageEnvelope, "generateToken").mockReturnValue("test-token");
    handlerChannel = { appendLine: jest.fn() };
    CodeIngestPanel.registerHandlerErrorChannel(handlerChannel as unknown as vscode.OutputChannel);
    (setWebviewHtml as jest.Mock).mockReturnValue("<!DOCTYPE html><html lang=\"en\"><body></body></html>");
    mockDetectFallback.mockReturnValue({ isFallback: false });
  });

  afterEach(() => {
    tokenSpy.mockRestore();
    (vscode.window.createWebviewPanel as jest.Mock).mockReset();
    (setWebviewHtml as jest.Mock).mockReset();
    mockDetectFallback.mockReset();
    mockLoadCommandValidator.mockClear();
    CodeIngestPanel.registerHandlerErrorChannel(undefined);
    Reflect.set(CodeIngestPanel as unknown as Record<string, unknown>, "instance", undefined);
    jest.clearAllMocks();
  });

  it("executes inbound commands and acknowledges", async () => {
    const harness = createPanelHarness();
    const extensionUri = vscode.Uri.file(path.resolve("./"));
    await CodeIngestPanel.createOrShow(extensionUri);

    expect(setWebviewHtml).toHaveBeenCalledWith(
      harness.webview,
      extensionUri,
      expect.stringMatching(/out\/resources\/webview\/index\.html$/),
      { sessionToken: "test-token" }
    );
    expect(harness.messageListeners.length).toBeGreaterThan(0);

    const listener = harness.messageListeners[0];
    const webviewEnvelope = new WebviewMessageEnvelope({ sessionToken: "test-token", role: "webview" });
    const message = webviewEnvelope.createMessage(
      "command",
      COMMAND_MAP.WEBVIEW_TO_HOST.GENERATE_DIGEST,
      { selectedFiles: [] },
      { expectsAck: true }
    );

    await listener(message);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      COMMAND_MAP.WEBVIEW_TO_HOST.GENERATE_DIGEST,
      expect.objectContaining({ selectedFiles: [] })
    );

    expect(harness.webview.postMessage).toHaveBeenCalledTimes(1);
    const response = harness.webview.postMessage.mock.calls[0][0] as {
      type: string;
      command: string;
      token: string;
      payload: unknown;
    };

    expect(response).toMatchObject({
      type: "response",
      command: COMMAND_MAP.WEBVIEW_TO_HOST.GENERATE_DIGEST,
      token: "test-token"
    });
    expect(response.payload).toMatchObject({ ok: true });
  });

  it("rejects messages with invalid session tokens", async () => {
    const harness = createPanelHarness();
  await CodeIngestPanel.createOrShow(vscode.Uri.file(path.resolve("./")));

    const listener = harness.messageListeners[0];
    const message = {
      id: 1,
      type: "command" as const,
      command: COMMAND_MAP.WEBVIEW_TO_HOST.GENERATE_DIGEST,
      payload: { selectedFiles: [] },
      expectsAck: true,
      timestamp: Date.now(),
      token: "invalid"
    };

    await listener(message);

    expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith(COMMAND_MAP.WEBVIEW_TO_HOST.GENERATE_DIGEST, expect.anything());
    expect(harness.webview.postMessage).not.toHaveBeenCalled();
  });

  it("queues restore state messages until the webview is ready", async () => {
    const harness = createPanelHarness();
    await CodeIngestPanel.createOrShow(vscode.Uri.file(path.resolve("./")));

    const instance = Reflect.get(CodeIngestPanel as unknown as Record<string, unknown>, "instance") as CodeIngestPanel;
    expect(instance).toBeDefined();

    harness.webview.postMessage.mockClear();
    instance.updateState({ tree: [] });

    expect(harness.webview.postMessage).not.toHaveBeenCalled();

    CodeIngestPanel.notifyWebviewReady();

    expect(harness.webview.postMessage).toHaveBeenCalledTimes(1);
    const message = harness.webview.postMessage.mock.calls[0][0] as {
      type: string;
      command: string;
      token: string;
      payload: unknown;
    };
    expect(message.type).toBe("command");
    expect(message.command).toBe(COMMAND_MAP.HOST_TO_WEBVIEW.RESTORE_STATE);
    expect(message.token).toBe("test-token");
    expect(message.payload).toEqual({ state: { tree: [] } });
  });

  it("queues arbitrary host commands until the webview signals readiness", async () => {
    const harness = createPanelHarness();
    await CodeIngestPanel.createOrShow(vscode.Uri.file(path.resolve("./")));

    harness.webview.postMessage.mockClear();
    const result = CodeIngestPanel.postCommand(COMMAND_MAP.HOST_TO_WEBVIEW.UPDATE_PROGRESS, { phase: "scan" });

    expect(result).toBe(true);
    expect(harness.webview.postMessage).not.toHaveBeenCalled();

    CodeIngestPanel.notifyWebviewReady();

    expect(harness.webview.postMessage).toHaveBeenCalledTimes(1);
    const message = harness.webview.postMessage.mock.calls[0][0] as {
      type: string;
      command: string;
      token: string;
      payload: unknown;
    };
    expect(message.command).toBe(COMMAND_MAP.HOST_TO_WEBVIEW.UPDATE_PROGRESS);
    expect(message.payload).toEqual({ phase: "scan" });
  });

  it("logs handler registration failures to the error channel", async () => {
    const harness = createPanelHarness();
    await CodeIngestPanel.createOrShow(vscode.Uri.file(path.resolve("./")));

    const listener = harness.messageListeners[0];
    listener({
      type: "handler:registrationFailed",
      payload: { type: "restoredState", reason: "missing handle" }
    });

    expect(handlerChannel.appendLine).toHaveBeenCalledWith(
      expect.stringContaining("restoredState")
    );
  });

  it("records fallback renders to the error channel once", async () => {
    (setWebviewHtml as jest.Mock).mockReturnValueOnce(
      '<!DOCTYPE html><html><body data-code-ingest-fallback="missing-assets"></body></html>'
    );
    mockDetectFallback.mockReturnValueOnce({ isFallback: true, reason: "missing-assets" }).mockReturnValue({ isFallback: false });

    const harness = createPanelHarness();
    await CodeIngestPanel.createOrShow(vscode.Uri.file(path.resolve("./")));

    expect(handlerChannel.appendLine).toHaveBeenCalledWith(
      expect.stringContaining("missing-assets")
    );

    handlerChannel.appendLine.mockClear();
    CodeIngestPanel.notifyWebviewReady();

    expect(handlerChannel.appendLine).not.toHaveBeenCalled();
    expect(harness.webview.postMessage).not.toHaveBeenCalled();
  });
});

function createPanelHarness() {
  const messageListeners: MessageListener[] = [];
  const webview = {
    html: "",
    cspSource: "vscode-resource://test",
    postMessage: jest.fn(() => Promise.resolve(true)),
    asWebviewUri: jest.fn((uri) => uri),
    onDidReceiveMessage: jest.fn((listener: MessageListener) => {
      messageListeners.push(listener);
      return {
        dispose: jest.fn(() => {
          const index = messageListeners.indexOf(listener);
          if (index >= 0) {
            messageListeners.splice(index, 1);
          }
        })
      };
    })
  } as unknown as vscode.Webview;

  const panel = {
    webview,
    onDidDispose: jest.fn(() => ({ dispose: jest.fn() })),
    dispose: jest.fn(),
    reveal: jest.fn()
  } as unknown as vscode.WebviewPanel;

  (vscode.window.createWebviewPanel as jest.Mock).mockReturnValue(panel);

  return { panel, webview: webview as unknown as { postMessage: jest.Mock; onDidReceiveMessage: jest.Mock }, messageListeners };
}
