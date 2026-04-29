import { readFileSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import * as path from "node:path";
import * as vscode from "vscode";

const MAX_INITIAL_STATE_SIZE = 50 * 1024; // 50KB
const FALLBACK_META_NAME = "code-ingest:fallback";
const FALLBACK_BODY_ATTRIBUTE = "data-code-ingest-fallback";
const FALLBACK_META_PATTERN = new RegExp(`<meta[^>]+name=("|')${FALLBACK_META_NAME}\\1[^>]*>`, "i");
const FALLBACK_BODY_PATTERN = new RegExp(`<body[^>]*${FALLBACK_BODY_ATTRIBUTE}=("|')([^"']+)\\1`, "i");
const META_CONTENT_PATTERN = /content=("|')([^"']*)\\1/i;

export interface FallbackDetectionResult {
  readonly isFallback: boolean;
  readonly reason?: string | undefined;
}

type FallbackReason = "missing-assets" | "read-error" | "unexpected-error";

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
  const scriptSources = [webview.cspSource];
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
  ].join("; ");

  const cspMeta = `<meta http-equiv="Content-Security-Policy" content="${cspContent}">`;
  const cleanedHtml = html.replace(/<meta[^>]*Content-Security-Policy[^>]*>/gi, "");

  if (/<head[^>]*>/i.test(cleanedHtml)) {
    return cleanedHtml.replace(/<head([^>]*)>/i, (match) => `${match}\n    ${cspMeta}`);
  }

  return cleanedHtml.replace(/<html([^>]*)>/i, (match) => `${match}\n<head>\n    ${cspMeta}\n</head>`);
}

function toWebviewUri(
  webview: vscode.Webview,
  baseDirUri: vscode.Uri,
  resourcePath: string
): string | null {
  try {
    const suffixMatch = resourcePath.match(/([^?#]*)([?#].*)?/);
    const barePath = suffixMatch ? suffixMatch[1] : resourcePath;
    const suffix = suffixMatch?.[2] ?? "";

    const normalizedPath = barePath.replace(/^\.\//, "");
    const baseDir = baseDirUri.fsPath;
    const absoluteFsPath = path.resolve(baseDir, normalizedPath);
    const relative = path.relative(baseDir, absoluteFsPath);

    if (relative.startsWith("..") || relative.includes(`..${path.sep}`) || path.isAbsolute(relative)) {
      console.warn(`webviewHelpers: Skipping path outside bundle: ${resourcePath}`);
      return null;
    }

    const resourceUri = vscode.Uri.file(absoluteFsPath);
    const webviewUri = webview.asWebviewUri(resourceUri);
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

function transformResourceUris(html: string, webview: vscode.Webview, baseDirUri: vscode.Uri): string {
  const attributePattern = /(src|href)=("|')([^"']+)(\2)/gi;

  console.log("webviewHelpers: transformResourceUris", { baseDir: baseDirUri.fsPath });

  return html.replace(attributePattern, (match, attr, quote, value) => {
    if (/^(https?:|vscode-resource:|vscode-webview-resource:|data:|#|\{|\/\/)/i.test(value)) {
      return match;
    }

    const transformed = toWebviewUri(webview, baseDirUri, value);
    if (!transformed) {
      console.warn("webviewHelpers: Failed to transform", { attr, value });
      return match;
    }

    console.log("webviewHelpers: Transformed", { original: value, transformed });
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

function extractRequiredResources(html: string): string[] {
  const required = new Set<string>();

  const metaPattern = /<meta[^>]+name=("|')code-ingest:required-resources\1[^>]*>/gi;
  const contentPattern = /content=("|')([^"']*)(\1)/i;
  let metaMatch: RegExpExecArray | null;
  while ((metaMatch = metaPattern.exec(html))) {
    const tag = metaMatch[0];
    const contentMatch = contentPattern.exec(tag);
    if (!contentMatch) {
      continue;
    }
    const entries = contentMatch[2]
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    entries.forEach((entry) => required.add(entry));
  }

  if (required.size === 0) {
    const attributePattern = /(src|href)=("|')([^"']+)(\2)/gi;
    let attributeMatch: RegExpExecArray | null;
    while ((attributeMatch = attributePattern.exec(html))) {
      const value = attributeMatch[3];
      if (/^(https?:|vscode-resource:|vscode-webview-resource:|data:|#|\{|\/\/)/i.test(value)) {
        continue;
      }
      const cleanValue = value.split(/[?#]/)[0]?.trim();
      if (!cleanValue) {
        continue;
      }
      required.add(cleanValue);
    }
  }

  return Array.from(required);
}

function validateRequiredResources(baseDirUri: vscode.Uri, html: string): string[] {
  const baseDir = baseDirUri.fsPath;
  const missing: string[] = [];
  const requiredResources = extractRequiredResources(html);

  for (const candidate of requiredResources) {
    const relativePath = candidate.replace(/^\.\//, "");
    const absolutePath = path.resolve(baseDir, relativePath);
    const relative = path.relative(baseDir, absolutePath);

    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      console.warn("webviewHelpers: Skipping validation for out-of-bundle resource", candidate);
      continue;
    }

    try {
      const stats = statSync(absolutePath);
      if (!stats.isFile() || stats.size === 0) {
        missing.push(candidate);
      }
    } catch (error) {
      const errno = (error as NodeJS.ErrnoException)?.code;
      if (errno === "ENOENT") {
        missing.push(candidate);
      } else {
        console.error("webviewHelpers: Failed to stat resource", { candidate, error });
        missing.push(candidate);
      }
    }
  }

  return missing;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function unescapeHtml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function buildFallbackHtml(error: unknown, reason: FallbackReason = "unexpected-error", suggestion?: string): string {
  const message = error instanceof Error ? error.message : String(error);
  const escapedReason = escapeHtml(reason);
  const suggestionHtml = suggestion
    ? `<p class="code-ingest-fallback__suggestion">${escapeHtml(suggestion)}</p>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none';">
    <meta name="${FALLBACK_META_NAME}" content="${escapedReason}">
    <title>Code Ingest</title>
  </head>
  <body class="code-ingest-fallback" data-code-ingest-fallback="${escapedReason}">
    <h1>Unable to load webview</h1>
    <p>${escapeHtml(message)}</p>
    ${suggestionHtml}
    <style>
      body.code-ingest-fallback {
        font-family: var(--vscode-font-family, system-ui, sans-serif);
        color: var(--vscode-editor-foreground, #d4d4d4);
        background: var(--vscode-editor-background, #1e1e1e);
        margin: 0;
        padding: 24px;
        line-height: 1.5;
      }
      body.code-ingest-fallback h1 {
        margin: 0 0 12px;
        font-size: 1.5rem;
      }
      body.code-ingest-fallback p {
        margin: 8px 0;
      }
      .code-ingest-fallback__suggestion {
        font-weight: 600;
      }
    </style>
  </body>
</html>`;
}

export function detectFallbackHtml(html: string | undefined): FallbackDetectionResult {
  if (typeof html !== "string" || html.trim() === "") {
    return { isFallback: false };
  }

  const metaMatch = FALLBACK_META_PATTERN.exec(html);
  if (metaMatch) {
    const contentMatch = META_CONTENT_PATTERN.exec(metaMatch[0]);
    if (contentMatch?.[2]) {
      return { isFallback: true, reason: unescapeHtml(contentMatch[2]) };
    }
  }

  const bodyMatch = FALLBACK_BODY_PATTERN.exec(html);
  if (bodyMatch && bodyMatch[2]) {
    return { isFallback: true, reason: unescapeHtml(bodyMatch[2]) };
  }

  if (metaMatch) {
    return { isFallback: true, reason: undefined };
  }

  return { isFallback: false };
}

function notifyWebviewFallback(reason: FallbackReason, details?: string): void {
  const baseMessage = reason === "missing-assets"
    ? "Webview assets are missing."
    : reason === "read-error"
      ? "Webview resources could not be loaded."
      : "The webview failed to render.";

  const detailSuffix = details ? ` ${details}` : "";
  const guidance = ' Run "npm run build:webview" to regenerate the assets and reopen Code Ingest.';
  void vscode.window.showErrorMessage(`Code Ingest: ${baseMessage}${detailSuffix}${guidance}`.trim());
}

export function setWebviewHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  htmlRelativePath: string,
  initialState?: object
): string {
  let rawHtml: string;
  const htmlSegments = htmlRelativePath.split(/[\\/]+/).filter(Boolean);
  const htmlUri = vscode.Uri.joinPath(extensionUri, ...htmlSegments);
  const htmlFilePath = htmlUri.fsPath;
  const baseDirUri = vscode.Uri.file(path.dirname(htmlFilePath));

  try {
    rawHtml = readFileSync(htmlFilePath, "utf8");
  } catch (error) {
    console.error(`webviewHelpers: Failed to read HTML file at ${htmlFilePath}`, error);
    const fallback = buildFallbackHtml(error, "read-error");
    webview.html = fallback;
    notifyWebviewFallback("read-error");
    return fallback;
  }

  try {
    const missingResources = validateRequiredResources(baseDirUri, rawHtml);
    if (missingResources.length > 0) {
      const missingList = missingResources.join(", ");
      const message = `Missing webview asset(s): ${missingList}. Run \"npm run build:webview\" to regenerate resources.`;
      console.error("webviewHelpers: Missing required resources", { missing: missingResources });
      const fallback = buildFallbackHtml(new Error(message), "missing-assets", 'Run "npm run build:webview" to regenerate the webview bundle.');
      webview.html = fallback;
      notifyWebviewFallback("missing-assets", `(Missing: ${missingList})`);
      return fallback;
    }

    let html = ensureHtmlStructure(rawHtml);
    const serializedState = safeSerializeInitialState(initialState);
    const nonce = serializedState ? randomBytes(16).toString("base64") : undefined;
    html = injectCsp(html, webview, nonce);
    html = transformResourceUris(html, webview, baseDirUri);
    html = injectInitialState(html, serializedState, nonce);

    webview.html = html;
    return html;
  } catch (error) {
    console.error("webviewHelpers: Unexpected error while preparing webview HTML", error);
    const fallback = buildFallbackHtml(error, "unexpected-error");
    webview.html = fallback;
    notifyWebviewFallback("unexpected-error");
    return fallback;
  }
}