const fs = require("node:fs");
const path = require("node:path");

function loadSidebar() {
  jest.resetModules();
  const htmlPath = path.resolve(__dirname, "../../sidebar/sidebar.html");
  const scriptPath = path.resolve(__dirname, "../../sidebar/sidebar.js");
  document.documentElement.innerHTML = fs.readFileSync(htmlPath, "utf8");
  require(scriptPath);
  const vscodeApi = global.acquireVsCodeApi();
  vscodeApi.postMessage.mockClear();
  return vscodeApi;
}

describe("sidebar webview", () => {
  test("posts command messages when action buttons are clicked", () => {
    const vscodeApi = loadSidebar();

    document.getElementById("rebuildButton").click();
    document.getElementById("openGraphButton").click();
    document.getElementById("sendToChatButton").click();

    expect(vscodeApi.postMessage.mock.calls).toEqual([
      [{ type: "rebuild-graph" }],
      [{ type: "open-graph-view" }],
      [{ type: "send-to-chat" }]
    ]);
  });

  test("renders sidebar state updates", () => {
    loadSidebar();

    window.dispatchEvent(
      new window.MessageEvent("message", {
        data: {
          type: "sidebar-state",
          payload: {
            status: "partial",
            nodeCount: 12,
            edgeCount: 34,
            lastIndexed: 1710000000000,
            databaseSizeBytes: 4096,
            activeFile: "src/index.ts",
            dependencyCount: 3,
            dependentCount: 5,
            settings: {
              hopDepth: 4,
              defaultNodeMode: "function",
              excludePatterns: ["dist/**", "coverage/**"]
            }
          }
        }
      })
    );

    expect(document.getElementById("statusText").textContent).toBe("Partial");
    expect(document.getElementById("nodeCount").textContent).toBe("12");
    expect(document.getElementById("edgeCount").textContent).toBe("34");
    expect(document.getElementById("dbSize").textContent).toBe("4 KB");
    expect(document.getElementById("activeFile").textContent).toBe("src/index.ts");
    expect(document.getElementById("hopDepthPill").textContent).toBe("Depth: 4");
    expect(document.getElementById("nodeModePill").textContent).toBe("Mode: function");
    expect(Array.from(document.querySelectorAll("#excludePatterns .pill")).map((item) => item.textContent)).toEqual([
      "dist/**",
      "coverage/**"
    ]);
  });
});
