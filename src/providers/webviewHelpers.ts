import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import * as path from "node:path";
import * as vscode from "vscode";

const MAX_INITIAL_STATE_SIZE = 50 * 1024; // 50KB

function ensureHtmlStructure(html: string): string {
  let output = html.trim();

  if (!/<html[^>]*>/i.test(output)) {
    output = `<html lang="en">${output}</html>`;
  }

  if (!/<head[^>]*>/i.test(output)) {
    output = output.replace(/<html[^>]*>/i, (match) => `${match}\n<head></head>`);
  }

  if (!/<body[^>]*>/i.test(output)) {
    output = output.replace(/<\/head>/i, (match) => `${match}\n<body>`);
    if (!/<body[^>]*>/i.test(output)) {
      output = output.replace(/<html[^>]*>/i, (match) => `${match}\n<body>`);
    }
    if (!/<\/body>/i.test(output)) {
      output = output.replace(/<\/html>/i, (match) => `</body>\n${match}`);
    }
  } else if (!/<\/body>/i.test(output)) {
    output = output.replace(/<\/html>/i, (match) => `</body>\n${match}`);
  }

  return output;
}

function injectCsp(html: string, webview: vscode.Webview, nonce?: string): string {
  const scriptSources = [`${webview.cspSource}`];
  if (nonce) {
    scriptSources.unshift(`'nonce-${nonce}'`);
  }

  const cspContent = [
    "default-src 'none'",
    `img-src ${webview.cspSource} https: data:`,
    `script-src ${scriptSources.join(' ')}`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `font-src ${webview.cspSource}`,
    `connect-src ${webview.cspSource}`
  ].join('; ');

  const cspMeta = `<meta http-equiv="Content-Security-Policy" content="${cspContent}">`;
  
  // Remove existing CSP if present
  let cleanedHtml = html.replace(/<meta[^>]*Content-Security-Policy[^>]*>/gi, '');
  
  if (/<head[^>]*>/i.test(cleanedHtml)) {
    return cleanedHtml.replace(/<head([^>]*)>/i, (match) => `${match}\n    ${cspMeta}`);
  }

  return cleanedHtml.replace(/<html([^>]*)>/i, (match) => `${match}\n<head>\n    ${cspMeta}\n</head>`);
}

function toWebviewUri(
  webview: vscode.Webview,
  baseDir: string,
  resourcePath: string
): string | null {
  try {
    const suffixMatch = resourcePath.match(/([^?#]*)([?#].*)?/);
    const barePath = suffixMatch ? suffixMatch[1] : resourcePath;
    const suffix = suffixMatch && suffixMatch[2] ? suffixMatch[2] : "";

    const isAbsoluteWithinBundle = barePath.startsWith("/");
    const normalizedPath = barePath.replace(/^\.\//, "");
    const absoluteFsPath = isAbsoluteWithinBundle
      ? path.resolve(baseDir, normalizedPath.replace(/^\/+/, ""))
      : path.resolve(baseDir, normalizedPath);

    const relative = path.relative(baseDir, absoluteFsPath);
    if (relative.startsWith("..") || relative.includes(`..${path.sep}`) || path.isAbsolute(relative)) {
      console.warn(`webviewHelpers: Skipping path outside bundle: ${resourcePath}`);
      return null;
    }

    const uri = vscode.Uri.file(absoluteFsPath);
    const webviewUri = webview.asWebviewUri(uri);
    if (!webviewUri || !webviewUri.scheme) {
      console.warn(`webviewHelpers: Invalid webview URI generated for ${resourcePath}`);
      return null;
    }

    return `${webviewUri.toString()}${suffix}`;
  } catch (error) {
    console.error(`webviewHelpers: Failed to transform resource ${resourcePath}:`, error);
    return null;
  }
}

function transformResourceUris(html: string, webview: vscode.Webview, htmlFilePath: string): string {
  const baseDir = path.dirname(htmlFilePath);
  const attributePattern = /(src|href)=("|')([^"']+)(\2)/gi;

  console.log('webviewHelpers: transformResourceUris', { baseDir, htmlFilePath });

  return html.replace(attributePattern, (match, attr, quote, value) => {
    if (/^(https?:|vscode-resource:|vscode-webview-resource:|data:|#|\{|\/\/)/i.test(value)) {
      return match;
    }

    const transformed = toWebviewUri(webview, baseDir, value);
    if (!transformed) {
      console.warn('webviewHelpers: Failed to transform', { attr, value });
      return match;
    }

    console.log('webviewHelpers: Transformed', { original: value, transformed });
    return `${attr}=${quote}${transformed}${quote}`;
  });
}

function safeSerializeInitialState(initialState: object | undefined): string | null {
  if (initialState == null) {
    return null;
  }

  try {
    const seen = new WeakSet();
    const json = JSON.stringify(
      initialState,
      (key, value) => {
        if (typeof value === "object" && value !== null) {
          if (seen.has(value)) {
            return "[Circular]";
          }
          seen.add(value);
        }
        if (typeof value === "function") {
          return undefined;
        }
        return value;
      }
    );

    if (!json) {
      return null;
    }

    const byteLength = Buffer.byteLength(json, "utf8");
    if (byteLength > MAX_INITIAL_STATE_SIZE) {
      console.warn(`webviewHelpers: initial state exceeds ${MAX_INITIAL_STATE_SIZE} bytes; skipping injection.`);
      return null;
    }

    return json.replace(/</g, "\\u003C").replace(/>/g, "\\u003E").replace(/\u2028|\u2029/g, (match) => {
      const codePoint = match.charCodeAt(0).toString(16);
      return `\\u${codePoint.padStart(4, "0")}`;
    });
  } catch (error) {
    console.error("webviewHelpers: Failed to serialize initial state", error);
    return null;
  }
}

function injectInitialState(html: string, serializedState: string | null, nonce?: string): string {
  if (!serializedState) {
    return html;
  }

  const nonceAttribute = nonce ? ` nonce="${nonce}"` : "";
  const scriptTag = `<script${nonceAttribute}>window.__INITIAL_STATE__ = JSON.parse(${JSON.stringify(serializedState)});</script>`;
  if (/<\/body>/i.test(html)) {
    return html.replace(/<\/body>/i, `${scriptTag}\n</body>`);
  }

  return `${html}\n<body>${scriptTag}</body>`;
}

function buildFallbackHtml(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none';">
    <title>Code Ingest</title>
  </head>
  <body>
    <h1>Unable to load webview</h1>
    <p>${message.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</p>
  </body>
</html>`;
}

export function setWebviewHtml(
  webview: vscode.Webview,
  htmlFilePath: string,
  initialState?: object
): string {
  let rawHtml: string;

  try {
    rawHtml = readFileSync(htmlFilePath, "utf8");
  } catch (error) {
    console.error(`webviewHelpers: Failed to read HTML file at ${htmlFilePath}`, error);
    const fallback = buildFallbackHtml(error);
    webview.html = fallback;
    return fallback;
  }

  try {
    let html = ensureHtmlStructure(rawHtml);
    const serializedState = safeSerializeInitialState(initialState);
    const nonce = serializedState ? randomBytes(16).toString("base64") : undefined;
    html = injectCsp(html, webview, nonce);
    html = transformResourceUris(html, webview, htmlFilePath);
    html = injectInitialState(html, serializedState, nonce);

    webview.html = html;
    return html;
  } catch (error) {
    console.error("webviewHelpers: Unexpected error while preparing webview HTML", error);
    const fallback = buildFallbackHtml(error);
    webview.html = fallback;
    return fallback;
  }
}
