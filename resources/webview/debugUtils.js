/*
 * Follow instructions in copilot-instructions.md exactly.
 */

/**
 * Debug utilities exposed for local development when running the webview.
 */
export class WebviewDebugUtils {
  constructor(logger, errorReporter) {
    this.logger = logger;
    this.errorReporter = errorReporter;
    this.setupDebugCommands();
  }

  setupDebugCommands() {
    const isLocalhost = window.location.hostname === "localhost";
    const isWebviewProtocol = window.location.protocol === "vscode-webview:";

    if (!isLocalhost && !isWebviewProtocol) {
      return;
    }

    window.debugCodeIngest = {
      getState: () => window.store?.getState?.(),
      getLogs: () => [...(this.logger?.buffer ?? [])],
      getErrors: () => this.errorReporter?.getErrorBuffer?.() ?? [],
      clearErrors: () => this.errorReporter?.clearErrorBuffer?.(),
      testError: () => {
        throw new Error("Test error from debug utils");
      },
      performanceReport: () => window.performanceMonitor?.getPerformanceReport?.(),
      inspectDOM: () => this.inspectDOMStructure(),
      memoryUsage: () => (performance?.memory ? { ...performance.memory } : null)
    };
  }

  inspectDOMStructure() {
    const structure = {
      totalElements: 0,
      byTag: {},
      byClass: {},
      deepestNesting: 0
    };

    const elements = document.querySelectorAll("*");
    structure.totalElements = elements.length;

    elements.forEach((element) => {
      const tag = element.tagName.toLowerCase();
      structure.byTag[tag] = (structure.byTag[tag] ?? 0) + 1;

      if (typeof element.className === "string" && element.className.trim().length > 0) {
        for (const className of element.className.split(" ").filter(Boolean)) {
          structure.byClass[className] = (structure.byClass[className] ?? 0) + 1;
        }
      }

      let depth = 0;
      let current = element;
      while (current.parentElement) {
        depth += 1;
        current = current.parentElement;
      }
      structure.deepestNesting = Math.max(structure.deepestNesting, depth);
    });

    return structure;
  }
}

export function createWebviewDebugUtils(logger, errorReporter) {
  return new WebviewDebugUtils(logger, errorReporter);
}