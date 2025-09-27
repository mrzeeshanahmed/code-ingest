import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import type { WebviewHarnessResult } from "../../test/support/webviewTestHarness";
import { setupTestLifecycle } from "../../test/support/webviewTestHarness";

describe("webview main UI", () => {
  let harness: WebviewHarnessResult;

  beforeEach(async () => {
    harness = await setupTestLifecycle();
  });

  afterEach(() => {
    harness.dispose();
    harness.vscodeApiMock.postMessage.mockClear();
    harness.acquireVsCodeApiMock.mockClear();
  });

  it("renders the file tree when receiving a state update", async () => {
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

    const message = new window.MessageEvent("message", {
      data: {
        type: "state:update",
        payload: {
          tree: treeData
        }
      }
    });

    window.dispatchEvent(message);
    await nextTick();

    expect(document.querySelector(".empty-state")).toBeNull();

    const folderNode = document.querySelector('li.tree-item[data-uri="workspace/src"]');
    const fileNode = document.querySelector('li.tree-item[data-uri="workspace/src/index.ts"]');

    expect(folderNode).not.toBeNull();
    expect(folderNode?.textContent).toContain("src");

    expect(fileNode).not.toBeNull();
    expect(fileNode?.textContent).toContain("index.ts");
  });

  it("dispatches generateDigest when the Generate Digest button is clicked", () => {
    const { document, window, vscodeApiMock } = harness;

    const generateButton = document.querySelector('[data-action="generate"]');
    expect(generateButton).not.toBeNull();

    generateButton?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

    expect(vscodeApiMock.postMessage).toHaveBeenCalledTimes(1);
    expect(vscodeApiMock.postMessage).toHaveBeenCalledWith({
      type: "command",
      command: "generateDigest"
    });
  });
});

async function nextTick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
