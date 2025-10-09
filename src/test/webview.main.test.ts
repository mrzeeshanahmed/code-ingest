import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { COMMAND_MAP } from "../commands/commandMap";
import type { WebviewHarnessResult } from "./support/webviewTestHarness";
import { setupTestLifecycle } from "./support/webviewTestHarness";

describe("webview main UI", () => {
  let harness: WebviewHarnessResult | undefined;

  beforeEach(async () => {
    harness = await setupTestLifecycle();
  });

  afterEach(() => {
    if (harness) {
      harness.dispose();
      harness.vscodeApiMock.postMessage.mockClear();
      harness.acquireVsCodeApiMock.mockClear();
      harness = undefined;
    }
    jest.resetModules();
  });

  it("renders the file tree when receiving a state update", async () => {
    if (!harness) {
      throw new Error("Test harness failed to initialize");
    }
    const { window, document } = harness;

    const treeData = [
      {
        uri: "workspace/src",
        name: "src",
        expanded: true,
        children: [
          {
            uri: "workspace/src/index.ts",
            name: "index.ts",
            selected: true
          }
        ]
      }
    ];

    const sessionToken = (window as typeof window & { __INITIAL_STATE__?: { sessionToken?: string } }).__INITIAL_STATE__?.sessionToken ?? "test-session-token";
    const message = new window.MessageEvent("message", {
      data: {
        id: 1,
        type: "command",
        command: COMMAND_MAP.HOST_TO_WEBVIEW.UPDATE_TREE_DATA,
        payload: {
          tree: treeData
        },
        timestamp: Date.now(),
        token: sessionToken,
        expectsAck: false
      }
    });

    window.dispatchEvent(message);
    await nextTick();

  const folderNode = document.querySelector('div.file-node[data-path="workspace/src"]');
  const fileNode = document.querySelector('div.file-node[data-path="workspace/src/index.ts"]');

    expect(folderNode).not.toBeNull();
    expect(folderNode?.textContent).toContain("src");

    expect(fileNode).not.toBeNull();
    expect(fileNode?.textContent).toContain("index.ts");
  });

  it("dispatches generateDigest when the Generate Digest button is clicked", async () => {
    if (!harness) {
      throw new Error("Test harness failed to initialize");
    }
    const { document, window, vscodeApiMock } = harness;
    const sessionToken = (window as typeof window & { __INITIAL_STATE__?: { sessionToken?: string } }).__INITIAL_STATE__?.sessionToken ?? "test-session-token";

    const generateButton = document.querySelector('[data-action="generate"]');
    expect(generateButton).not.toBeNull();

    const initialCalls = vscodeApiMock.postMessage.mock.calls.length;

    generateButton?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

    await nextTick();

    expect(vscodeApiMock.postMessage.mock.calls.length).toBe(initialCalls + 1);
    const lastCall = vscodeApiMock.postMessage.mock.calls.at(-1);
    expect(lastCall).toBeDefined();
    const [payload] = lastCall ?? [];
    if (!payload || typeof payload !== "object") {
      throw new Error("Expected command envelope payload");
    }

    const envelope = payload as {
      type: string;
      command: string;
      payload: unknown;
      token: string;
      expectsAck: boolean;
      timestamp: number;
      id: number;
    };

    expect(envelope.type).toBe("command");
    expect(envelope.command).toBe(COMMAND_MAP.WEBVIEW_TO_HOST.GENERATE_DIGEST);
    expect(envelope.token).toBe(sessionToken);
    expect(envelope.expectsAck).toBe(true);
    expect(envelope.payload).toEqual({
      selectedFiles: [],
      outputFormat: "markdown",
      redactionOverride: false
    });
    expect(typeof envelope.timestamp).toBe("number");
    expect(typeof envelope.id).toBe("number");
  });
});

async function nextTick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
