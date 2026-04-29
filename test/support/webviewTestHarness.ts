import { jest } from "@jest/globals";
import { JSDOM } from "jsdom";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

type GlobalKey = keyof typeof globalThis;

export interface WebviewHarnessResult {
  dom: JSDOM;
  window: Window & typeof globalThis;
  document: Document;
  acquireVsCodeApiMock: jest.Mock;
  vscodeApiMock: {
    postMessage: jest.Mock;
  };
  dispose: () => void;
}

export interface WebviewHarnessOptions {
  htmlPath?: string;
}

const DEFAULT_HTML_PATH = path.resolve(__dirname, "../../resources/webview/index.html");

export async function setupTestLifecycle(
  options: WebviewHarnessOptions = {}
): Promise<WebviewHarnessResult> {
  const htmlFilePath = options.htmlPath ?? DEFAULT_HTML_PATH;
  const htmlContent = await readFile(htmlFilePath, "utf8");

  const postMessage = jest.fn();
  const vscodeApi = { postMessage };
  const acquireVsCodeApi = jest.fn(() => vscodeApi);

  const dom = new JSDOM(htmlContent, {
    url: pathToFileURL(htmlFilePath).href,
    contentType: "text/html",
    runScripts: "dangerously",
    resources: "usable",
    pretendToBeVisual: true,
    beforeParse(window) {
      (window as typeof window & { acquireVsCodeApi: typeof acquireVsCodeApi }).acquireVsCodeApi = acquireVsCodeApi;
    }
  });

  const window = dom.window as unknown as Window & typeof globalThis;
  const { document } = window;

  const previousGlobals = mapWindowOntoGlobal(window);
  const restoreAcquire = setAcquireVsCodeApiOnGlobal(acquireVsCodeApi);
  const cleanup = () => {
    restoreAcquire();
    restoreGlobals(previousGlobals);
    window.close();
  };

  const pendingLoad = waitForWindowLoad(window);

  try {
    await importModuleScripts(document, htmlFilePath);
    dispatchLifecycleEvents(window);
    await pendingLoad;
  } catch (error) {
    cleanup();
    throw error;
  }

  const dispose = () => {
    cleanup();
  };

  return {
    dom,
    window,
    document,
    acquireVsCodeApiMock: acquireVsCodeApi,
    vscodeApiMock: vscodeApi,
    dispose
  };
}

export async function createWebviewTestHarness(
  options: WebviewHarnessOptions = {}
): Promise<WebviewHarnessResult> {
  return setupTestLifecycle(options);
}

async function importModuleScripts(document: Document, htmlFilePath: string): Promise<void> {
  const scripts = Array.from(document.querySelectorAll<HTMLScriptElement>("script[src]"));
  if (scripts.length === 0) {
    return;
  }

  const baseDir = path.dirname(htmlFilePath);

  for (const script of scripts) {
    const src = script.getAttribute("src");
    if (!src) {
      continue;
    }

    const type = script.getAttribute("type") ?? "";
    if (type !== "module") {
      continue;
    }

    const absolutePath = path.resolve(baseDir, src);
    const cacheBuster = `?t=${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const moduleUrl = `${pathToFileURL(absolutePath).href}${cacheBuster}`;
    await import(moduleUrl);
  }
}

function dispatchLifecycleEvents(window: Window): void {
  const document = window.document;

  const domContentLoadedOnDocument = document.createEvent("Event");
  domContentLoadedOnDocument.initEvent("DOMContentLoaded", true, true);
  document.dispatchEvent(domContentLoadedOnDocument);

  const domContentLoadedOnWindow = document.createEvent("Event");
  domContentLoadedOnWindow.initEvent("DOMContentLoaded", true, true);
  window.dispatchEvent(domContentLoadedOnWindow);

  const loadEvent = document.createEvent("Event");
  loadEvent.initEvent("load", false, false);
  window.dispatchEvent(loadEvent);
}

function waitForWindowLoad(window: Window): Promise<void> {
  if (window.document.readyState === "complete") {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const onLoad = () => {
      cleanup();
      resolve();
    };

    const onError = (event: Event) => {
      cleanup();
      const error = (event as ErrorEvent).error ?? new Error("Window emitted an error event while loading");
      reject(error);
    };

    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for window load event"));
    }, 5000);

    const cleanup = () => {
      clearTimeout(timeout);
      window.removeEventListener("load", onLoad);
      window.removeEventListener("error", onError);
    };

    window.addEventListener("load", onLoad, { once: true });
    window.addEventListener("error", onError, { once: true });
  });
}

function setAcquireVsCodeApiOnGlobal(acquireVsCodeApi: jest.Mock): () => void {
  const globalWithAcquire = globalThis as typeof globalThis & {
    acquireVsCodeApi?: jest.Mock;
  };

  const hadExisting = Object.prototype.hasOwnProperty.call(globalWithAcquire, "acquireVsCodeApi");
  const previousValue = globalWithAcquire.acquireVsCodeApi;

  globalWithAcquire.acquireVsCodeApi = acquireVsCodeApi;

  return () => {
    if (hadExisting) {
      globalWithAcquire.acquireVsCodeApi = previousValue;
      return;
    }

    delete (globalWithAcquire as Record<string, unknown>).acquireVsCodeApi;
  };
}

function mapWindowOntoGlobal(window: Window): Map<GlobalKey, unknown> {
  const keys: GlobalKey[] = [
    "window",
    "document",
    "navigator",
    "Node",
    "Text",
    "HTMLElement",
    "SVGElement",
    "Event",
    "CustomEvent",
    "KeyboardEvent",
    "MouseEvent",
    "EventTarget"
  ];

  const previous = new Map<GlobalKey, unknown>();

  for (const key of keys) {
    previous.set(key, globalThis[key]);
    // @ts-expect-error Assign DOM globals to Node globalThis for test execution
    globalThis[key] = (window as Record<string, unknown>)[key] ?? window[key];
  }

  return previous;
}

function restoreGlobals(previous: Map<GlobalKey, unknown>): void {
  for (const [key, value] of previous.entries()) {
    // @ts-expect-error restore previous global binding
    globalThis[key] = value;
  }
}