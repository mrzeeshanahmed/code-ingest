import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import * as path from "node:path";
import * as vscode from "vscode";
import { COMMAND_MAP } from "../../commands/commandMap";
import { CodeIngestPanel } from "../../providers/codeIngestPanel";
import { WebviewMessageEnvelope } from "../../providers/messageEnvelope";
import { setWebviewHtml } from "../../providers/webviewHelpers";

jest.mock("../../providers/webviewHelpers", () => ({
  setWebviewHtml: jest.fn()
}));

type MessageListener = (message: unknown) => unknown;

describe("CodeIngestPanel", () => {
  let tokenSpy: jest.SpiedFunction<() => string>;

  beforeEach(() => {
    tokenSpy = jest.spyOn(WebviewMessageEnvelope, "generateToken").mockReturnValue("test-token");
  });

  afterEach(() => {
    tokenSpy.mockRestore();
    (vscode.window.createWebviewPanel as jest.Mock).mockReset();
    (setWebviewHtml as jest.Mock).mockReset();
    Reflect.set(CodeIngestPanel as unknown as Record<string, unknown>, "instance", undefined);
    jest.clearAllMocks();
  });

  it("executes inbound commands and acknowledges", async () => {
    const harness = createPanelHarness();
    await CodeIngestPanel.createOrShow(vscode.Uri.file(path.resolve("./")));

    expect(setWebviewHtml).toHaveBeenCalledWith(harness.webview, expect.any(String), { sessionToken: "test-token" });
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

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      COMMAND_MAP.WEBVIEW_TO_HOST.GENERATE_DIGEST,
      { selectedFiles: [] }
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

  it("sends restore state commands via the envelope", async () => {
    const harness = createPanelHarness();
    await CodeIngestPanel.createOrShow(vscode.Uri.file(path.resolve("./")));

    const instance = Reflect.get(CodeIngestPanel as unknown as Record<string, unknown>, "instance") as CodeIngestPanel;
    expect(instance).toBeDefined();

    harness.webview.postMessage.mockClear();
    instance.updateState({ tree: [] });

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
