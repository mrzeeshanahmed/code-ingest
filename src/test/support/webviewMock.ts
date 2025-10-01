import * as path from "node:path";
import * as fs from "node:fs";
import * as vscode from "vscode";
import { setWebviewHtml } from "../../providers/webviewHelpers";
import { createJestFn } from "./jestHelpers";

export interface MockWebviewResult {
  html: string;
  webview: vscode.Webview;
}

export function createMockWebview(): vscode.Webview {
  const asWebviewUri = createJestFn<(uri: vscode.Uri) => vscode.Uri>();
  asWebviewUri.mockImplementation((uri: vscode.Uri) => ({
    scheme: "vscode-resource",
    fsPath: uri.fsPath,
    toString: () => `vscode-resource:${uri.fsPath}`
  }) as unknown as vscode.Uri);

  const postMessage = createJestFn<(message: unknown) => Promise<boolean>>();
  postMessage.mockResolvedValue(true);

  const onDidReceiveMessage = createJestFn<(listener: (message: unknown) => void) => { dispose(): void }>();
  onDidReceiveMessage.mockReturnValue({ dispose: () => undefined });

  const dispose = createJestFn<() => void>();

  return {
    html: "",
    options: {},
    cspSource: "vscode-resource://mock",
    asWebviewUri,
    postMessage,
    onDidReceiveMessage,
    dispose
  } as unknown as vscode.Webview;
}

export function loadWebviewHtml(
  webview: vscode.Webview,
  htmlRelativePath: string,
  initialState?: object
): MockWebviewResult {
  const extensionPath = vscode.extensions.getExtension("code-ingest.code-ingest")?.extensionPath;
  if (!extensionPath) {
    throw new Error("Extension path is unavailable in test environment.");
  }

  const absoluteHtmlPath = path.join(extensionPath, htmlRelativePath);
  if (!fs.existsSync(absoluteHtmlPath)) {
    throw new Error(`HTML template is missing: ${absoluteHtmlPath}`);
  }

  const html = setWebviewHtml(webview, absoluteHtmlPath, initialState);
  return { html, webview };
}
