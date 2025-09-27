import { readFile } from "node:fs/promises";
import * as vscode from "vscode";

interface SetWebviewHtmlOptions {
  webview: vscode.Webview;
  extensionUri: vscode.Uri;
}

const RESOURCE_SEGMENTS = ["resources", "webview"];
const INDEX_HTML = "index.html";

/**
 * Loads the dashboard HTML into the given webview while enforcing a strict CSP and
 * transforming relative resource paths into VS Code webview URIs.
 */
export async function setWebviewHtml({ webview, extensionUri }: SetWebviewHtmlOptions): Promise<void> {
  const indexPath = vscode.Uri.joinPath(extensionUri, ...RESOURCE_SEGMENTS, INDEX_HTML);
  let html = await readFile(indexPath.fsPath, "utf8");

  const cspMeta = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src ${webview.cspSource};">`;
  const headRegex = /<head([^>]*)>/i;
  if (headRegex.test(html)) {
    html = html.replace(headRegex, (match, attrs) => `<head${attrs}>\n    ${cspMeta}`);
  } else {
    html = html.replace(/<html([^>]*)>/i, (match, attrs) => `<html${attrs}>\n<head>\n    ${cspMeta}\n</head>`);
  }

  html = html.replace(/(src|href)=("|')([^"']+)(\2)/gi, (match, attr, quote, value) => {
    if (/^(https?:|vscode-resource:|data:|#|\{|\/\/)/i.test(value)) {
      return match;
    }

    const normalized = value.replace(/^\.\//, "");
    const segments = normalized.split("/").filter(Boolean);
    const resourceUri = vscode.Uri.joinPath(extensionUri, ...RESOURCE_SEGMENTS, ...segments);
    const webviewUri = webview.asWebviewUri(resourceUri);
    return `${attr}=${quote}${webviewUri.toString()}${quote}`;
  });

  webview.html = html;
}
