import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { detectFallbackHtml, setWebviewHtml } from "../../../providers/webviewHelpers";

describe("setWebviewHtml fallback handling", () => {
  const showErrorMessageMock = vscode.window.showErrorMessage as jest.MockedFunction<typeof vscode.window.showErrorMessage>;
  let tempDir: string | undefined;

  beforeEach(() => {
    showErrorMessageMock.mockClear();
    tempDir = undefined;
  });

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it("shows a rebuild toast when the HTML file is missing", () => {
    const webview = createWebviewMock();
    const extensionUri = vscode.Uri.file(process.cwd());

    const html = setWebviewHtml(webview, extensionUri, "non-existent/webview.html");

    expect(html).toContain("data-code-ingest-fallback=\"read-error\"");
    expect(showErrorMessageMock).toHaveBeenCalledWith(expect.stringContaining("npm run build:webview"));
  });

  it("shows a rebuild toast when required assets are missing", () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "code-ingest-webview-"));
    const htmlPath = path.join(tempDir, "index.html");
    writeFileSync(
      htmlPath,
      "<!DOCTYPE html><html><body><script src=\"./missing-bundle.js\"></script></body></html>",
      "utf8"
    );

    const webview = createWebviewMock();
    const extensionUri = vscode.Uri.file(tempDir);

    const html = setWebviewHtml(webview, extensionUri, "index.html");

    expect(html).toContain("data-code-ingest-fallback=\"missing-assets\"");
    expect(showErrorMessageMock).toHaveBeenCalledWith(expect.stringContaining("npm run build:webview"));
  });

  it("detects fallback metadata from generated HTML", () => {
    const fallbackHtml = '<!DOCTYPE html><html><head><meta name="code-ingest:fallback" content="missing-assets"></head><body data-code-ingest-fallback="missing-assets"></body></html>';
    const result = detectFallbackHtml(fallbackHtml);

    expect(result).toEqual({ isFallback: true, reason: "missing-assets" });
  });

  it("returns non-fallback result for normal HTML", () => {
    const result = detectFallbackHtml("<!DOCTYPE html><html><body><h1>Ready</h1></body></html>");
    expect(result).toEqual({ isFallback: false });
  });
});

function createWebviewMock(): vscode.Webview {
  return {
    html: "",
    cspSource: "vscode-resource://mock",
    asWebviewUri: jest.fn((uri: vscode.Uri) => uri)
  } as unknown as vscode.Webview;
}
