/*
 * Follow instructions in copilot-instructions.md exactly.
 */

const { jest: jestInstance, beforeEach, afterEach } = require("@jest/globals");

const mockVSCodeAPI = {
  postMessage: jestInstance.fn(),
  getState: jestInstance.fn(),
  setState: jestInstance.fn()
};

global.acquireVsCodeApi = jestInstance.fn(() => mockVSCodeAPI);

globalThis.__CODE_INGEST_TEST__ = true;

let consoleDebugSpy;

beforeEach(() => {
  if (typeof window !== "undefined" && window.localStorage) {
    window.localStorage.clear();
  }
  consoleDebugSpy = jestInstance.spyOn(console, "debug").mockImplementation(() => {});
});

afterEach(() => {
  if (consoleDebugSpy?.mockRestore) {
    consoleDebugSpy.mockRestore();
  }
  consoleDebugSpy = undefined;
});

if (typeof window !== "undefined") {
  if (!window.requestAnimationFrame) {
    window.requestAnimationFrame = (callback) => setTimeout(callback, 0);
    window.cancelAnimationFrame = (id) => clearTimeout(id);
  }
  window.performance = window.performance || {
    now: () => Date.now(),
    memory: {
      usedJSHeapSize: 1_000_000,
      totalJSHeapSize: 2_000_000
    }
  };
  window.innerWidth = window.innerWidth || 1024;
  window.innerHeight = window.innerHeight || 768;
}

if (typeof ResizeObserver === "undefined") {
  global.ResizeObserver = class {
    constructor(callback) {
      this.callback = callback;
    }
    observe(target) {
      this.target = target;
    }
    unobserve() {}
    disconnect() {}
  };
}

if (typeof DOMRect === "undefined") {
  global.DOMRect = class {
    constructor(x = 0, y = 0, width = 0, height = 0) {
      this.x = x;
      this.y = y;
      this.width = width;
      this.height = height;
      this.top = y;
      this.left = x;
      this.right = x + width;
      this.bottom = y + height;
    }
  };
}

if (typeof ErrorEvent === "undefined") {
  global.ErrorEvent = class extends Event {
    constructor(type, options = {}) {
      super(type, options);
      this.message = options.message ?? "";
      this.filename = options.filename ?? "";
      this.lineno = options.lineno ?? 0;
      this.colno = options.colno ?? 0;
      this.error = options.error;
    }
  };
}

const ensureDocumentHelpers = () => {
  if (typeof document === "undefined") {
    return;
  }
  if (!document.createDocumentFragment) {
    document.createDocumentFragment = () => document.createElement("div");
  }
  document.body.className = document.body.className || "vscode-dark";
};

ensureDocumentHelpers();

class TestUtils {
  static createMockStore(initialState = {}) {
    return {
      getState: jestInstance.fn(() => initialState),
      setState: jestInstance.fn(),
      subscribe: jestInstance.fn(),
      destroy: jestInstance.fn(),
      getActions: jestInstance.fn(() => ({}))
    };
  }

  static createMockUIRenderer() {
    return {
      updatePreview: jestInstance.fn(),
      setTokenCount: jestInstance.fn(),
      updateConfig: jestInstance.fn(),
      updateProgress: jestInstance.fn(),
      toggleLoadingOverlay: jestInstance.fn()
    };
  }

  static createMockMessage(type, payload = {}, overrides = {}) {
    return {
      id: `msg-${Math.random().toString(36).slice(2)}`,
      type,
      payload,
      timestamp: Date.now(),
      token: "test-token",
      ...overrides
    };
  }

  static waitFor(condition, timeout = 1000) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      function check() {
        try {
          if (condition()) {
            resolve();
            return;
          }
          if (Date.now() - start >= timeout) {
            reject(new Error("Timeout waiting for condition"));
            return;
          }
          setTimeout(check, 15);
        } catch (error) {
          reject(error);
        }
      }
      check();
    });
  }
}

module.exports = {
  TestUtils,
  mockVSCodeAPI
};
