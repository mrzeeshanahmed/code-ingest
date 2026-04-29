const fs = require("node:fs");
const path = require("node:path");

function loadSettings() {
  jest.resetModules();
  const htmlPath = path.resolve(__dirname, "../../settings/settings.html");
  const scriptPath = path.resolve(__dirname, "../../settings/settings.js");
  document.documentElement.innerHTML = fs.readFileSync(htmlPath, "utf8");
  require(scriptPath);
  const vscodeApi = global.acquireVsCodeApi();
  vscodeApi.postMessage.mockClear();
  return vscodeApi;
}

describe("settings webview", () => {
  test("hydrates fields from settings state", () => {
    loadSettings();

    window.dispatchEvent(
      new window.MessageEvent("message", {
        data: {
          type: "settings-state",
          payload: {
            hopDepth: 4,
            defaultNodeMode: "function",
            maxNodes: 600,
            enableVectorSearch: false,
            layout: "radial",
            maxFileSizeKB: 4096,
            maxFiles: 5000,
            watcherDebounceMs: 1200,
            excludePatterns: ["dist/**", "coverage/**"],
            rebuildOnActivation: true,
            tokenBudget: 4096,
            includeSourceContent: false,
            redactSecrets: true,
            semanticResultCount: 3,
            showCircularDepsWarning: false,
            focusModeOpacity: 0.22,
            autoFocusOnEditorChange: false
          }
        }
      })
    );

    expect(document.querySelector('[data-key="hopDepth"]').value).toBe("4");
    expect(document.querySelector('[data-key="defaultNodeMode"]').value).toBe("function");
    expect(document.querySelector('[data-key="enableVectorSearch"]').checked).toBe(false);
    expect(document.querySelector('[data-key="excludePatterns"]').value).toBe("dist/**\ncoverage/**");
    expect(document.querySelector('[data-key="rebuildOnActivation"]').checked).toBe(true);
    expect(document.querySelector('[data-key="focusModeOpacity"]').value).toBe("0.22");
  });

  test("posts normalized updates when fields change", () => {
    const vscodeApi = loadSettings();

    const hopDepth = document.querySelector('[data-key="hopDepth"]');
    hopDepth.value = "5";
    hopDepth.dispatchEvent(new window.Event("change", { bubbles: true }));

    const includeSource = document.querySelector('[data-key="includeSourceContent"]');
    includeSource.checked = false;
    includeSource.dispatchEvent(new window.Event("change", { bubbles: true }));

    const patterns = document.querySelector('[data-key="excludePatterns"]');
    patterns.value = "dist/**\n coverage/** \n";
    patterns.dispatchEvent(new window.Event("change", { bubbles: true }));

    expect(vscodeApi.postMessage.mock.calls).toEqual([
      [
        {
          type: "update-setting",
          payload: {
            section: "codeIngest.graph",
            key: "hopDepth",
            value: 5
          }
        }
      ],
      [
        {
          type: "update-setting",
          payload: {
            section: "codeIngest.copilot",
            key: "includeSourceContent",
            value: false
          }
        }
      ],
      [
        {
          type: "update-setting",
          payload: {
            section: "codeIngest.indexing",
            key: "excludePatterns",
            value: ["dist/**", "coverage/**"]
          }
        }
      ]
    ]);
  });
});
