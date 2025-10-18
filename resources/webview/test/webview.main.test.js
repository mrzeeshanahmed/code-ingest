import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";

const getGlobalWithApi = () => /** @type {{ acquireVsCodeApi?: () => unknown }} */ (globalThis);
const getWindowWithApplication = () => /** @type {{ WebviewApplication?: new () => unknown }} */ (window);

describe("WebviewApplication bootstrap", () => {
  let originalAcquire;
  let WebviewApplicationCtor;

  beforeEach(async () => {
    document.body.innerHTML = "<div id=\"root\"></div>";
    const globalWithApi = getGlobalWithApi();
    originalAcquire = globalWithApi.acquireVsCodeApi;

    const windowWithApplication = getWindowWithApplication();
    if (!windowWithApplication.WebviewApplication) {
      await import("../main.js");
    }
    WebviewApplicationCtor = windowWithApplication.WebviewApplication;
  });

  afterEach(() => {
    const globalWithApi = getGlobalWithApi();
    if (originalAcquire) {
      globalWithApi.acquireVsCodeApi = originalAcquire;
    } else {
      delete globalWithApi.acquireVsCodeApi;
    }
    WebviewApplicationCtor = undefined;
    document.body.innerHTML = "";
  });

  it("renders an inline error banner when the VS Code API is unavailable", () => {
    const failingAcquire = () => {
      throw new Error("VS Code API missing");
    };

    const globalWithApi = getGlobalWithApi();
    const windowWithApplication = getWindowWithApplication();

    globalWithApi.acquireVsCodeApi = failingAcquire;

    const Application = WebviewApplicationCtor ?? windowWithApplication.WebviewApplication;
    expect(Application).toBeDefined();
    expect(() => new Application()).toThrow("VS Code API missing");
    expect(document.body.textContent ?? "").toContain("VS Code API");
    expect(document.body.textContent ?? "").toContain("npm run build:webview");
  });
});
