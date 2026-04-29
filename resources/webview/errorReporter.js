/*
 * Follow instructions in copilot-instructions.md exactly.
 */

import { WebviewLogger } from "./logger.js";

/**
 * Error reporter for the webview that captures uncaught errors and forwards structured reports to the host.
 */
export class WebviewErrorReporter {
  /**
   * @param {WebviewLogger} logger
   */
  constructor(logger) {
    this.logger = logger;
    try {
      this.vscode = acquireVsCodeApi();
    } catch (error) {
      this.vscode = undefined;
      logger?.warn?.("acquireVsCodeApi unavailable for error reporter", error);
    }

    this.errorBuffer = [];
    this.maxErrors = 100;
    this.reportedErrors = new Set();
    this.recentActions = [];

    this.setupGlobalErrorHandlers();
  }

  setupGlobalErrorHandlers() {
    window.addEventListener("error", (event) => {
      const nativeError = event.error instanceof Error ? event.error : new Error(event.message ?? "Unknown error");
      const context = {
        type: "unhandled_error",
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
        stack: event.error?.stack
      };
      this.reportError(nativeError, context);
    });

    window.addEventListener("unhandledrejection", (event) => {
      const reason = event.reason instanceof Error ? event.reason : new Error(String(event.reason ?? "Unhandled rejection"));
      this.reportError(reason, {
        type: "unhandled_promise_rejection",
        promise: "Promise rejection"
      });
    });

    const originalConsoleError = console.error.bind(console);
    console.error = (...args) => {
      const error = args.find((value) => value instanceof Error) ?? new Error(args.map((value) => this._safeToString(value)).join(" "));
      this.reportError(error, { type: "console_error" });
      originalConsoleError(...args);
    };
  }

  /**
   * @param {unknown} error
   * @param {Record<string, unknown>} [context]
   */
  reportError(error, context = {}) {
    const normalizedError = error instanceof Error ? error : new Error(this._safeToString(error));
    const errorKey = this.getErrorKey(normalizedError);
    if (this.reportedErrors.has(errorKey)) {
      return;
    }
    this.reportedErrors.add(errorKey);

    const errorReport = {
      id: this.generateErrorId(),
      timestamp: new Date().toISOString(),
      error: {
        name: normalizedError.name || "Unknown Error",
        message: normalizedError.message || "No message",
        stack: normalizedError.stack || "No stack trace"
      },
      context: {
        ...context,
        url: window.location?.href ?? "",
        userAgent: navigator.userAgent,
        webviewState: this.captureWebviewState()
      },
      userActions: this.getUserActions(),
      browserInfo: this.getBrowserInfo()
    };

    this.errorBuffer.push(errorReport);
    if (this.errorBuffer.length > this.maxErrors) {
      this.errorBuffer.shift();
    }

    try {
      this.logger?.error("WebView Error Reported", errorReport);
    } catch (logError) {
      console.warn("Failed to log error report", logError);
    }

    this.sendErrorReport(errorReport);
  }

  /**
   * @param {string} message
   * @param {string|number} code
   * @param {Record<string, unknown>} [context]
   */
  reportUserError(message, code, context = {}) {
    const error = new Error(message);
    if (code !== undefined) {
      // @ts-ignore - annotate code for diagnostics
      error.code = code;
    }
    this.reportError(error, { type: "user_error", ...context });
  }

  /**
   * @param {string} operation
   * @param {number} duration
   * @param {number} threshold
   */
  reportPerformanceIssue(operation, duration, threshold) {
    if (duration > threshold) {
      const error = new Error(`Performance issue: ${operation} took ${duration}ms`);
      this.reportError(error, { type: "performance_issue", operation, duration, threshold });
    }
  }

  /**
   * @param {Error} error
   */
  getErrorKey(error) {
    const frame = typeof error.stack === "string" ? error.stack.split("\n")[1] ?? "" : "";
    return `${error.name}-${error.message}-${frame}`;
  }

  generateErrorId() {
    return `webview-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
  }

  captureWebviewState() {
    try {
      const state = typeof window.store?.getState === "function" ? window.store.getState() : null;
      return {
        storeState: state ? this.sanitizeState(state) : null,
        domElementCount: document.querySelectorAll("*").length,
        memoryUsage: this._getMemoryUsage()
      };
    } catch (error) {
      return { captureError: `Failed to capture webview state: ${this._safeToString(error)}` };
    }
  }

  sanitizeState(state) {
    try {
      const sanitized = JSON.parse(JSON.stringify(state));
      if (sanitized?.generation?.preview?.content) {
        sanitized.generation.preview.content = "[REDACTED]";
      }
      if (sanitized?.remoteRepo?.url) {
        sanitized.remoteRepo.url = sanitized.remoteRepo.url.replace(/\/\/.*@/, "//[REDACTED]@");
      }
      return sanitized;
    } catch (error) {
      return { redactionError: this._safeToString(error) };
    }
  }

  getUserActions() {
    return [...(this.recentActions ?? [])];
  }

  getBrowserInfo() {
    return {
      userAgent: navigator.userAgent,
      language: navigator.language,
      platform: navigator.platform,
      cookieEnabled: navigator.cookieEnabled,
      onLine: navigator.onLine,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight
      }
    };
  }

  sendErrorReport(errorReport) {
    if (!this.vscode?.postMessage) {
      return;
    }
    try {
      this.vscode.postMessage({
        type: "error",
        command: "reportWebviewError",
        payload: errorReport
      });
    } catch (error) {
      console.warn("Failed to send error report to extension host", error);
    }
  }

  trackUserAction(action, details = {}) {
    if (!Array.isArray(this.recentActions)) {
      this.recentActions = [];
    }

    this.recentActions.push({
      action,
      details,
      timestamp: new Date().toISOString()
    });

    if (this.recentActions.length > 20) {
      this.recentActions.shift();
    }
  }

  getErrorBuffer() {
    return [...this.errorBuffer];
  }

  clearErrorBuffer() {
    this.errorBuffer = [];
    this.reportedErrors.clear();
  }

  _getMemoryUsage() {
    if (performance?.memory) {
      return {
        usedJSHeapSize: performance.memory.usedJSHeapSize,
        totalJSHeapSize: performance.memory.totalJSHeapSize
      };
    }
    return null;
  }

  _safeToString(value) {
    if (value instanceof Error) {
      return value.message;
    }
    if (typeof value === "string") {
      return value;
    }
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
}

export function createWebviewErrorReporter(logger) {
  return new WebviewErrorReporter(logger);
}