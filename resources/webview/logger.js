/*
 * Follow instructions in copilot-instructions.md exactly.
 */

const DEFAULT_OPTIONS = {
  logLevel: "info",
  maxBufferSize: 1000,
  flushInterval: 5000,
  enableConsole: true
};

const LOG_LEVELS = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3
};

/**
 * @typedef {"debug"|"info"|"warn"|"error"} LogLevel
 */

/**
 * Webview logger that buffers log entries and forwards them to the extension host.
 */
export class WebviewLogger {
  /**
   * @param {{
   *   logLevel?: LogLevel;
   *   maxBufferSize?: number;
   *   flushInterval?: number;
   *   enableConsole?: boolean;
   * }} [options]
   */
  constructor(options = {}) {
    const mergedOptions = { ...DEFAULT_OPTIONS, ...options };

    this.logLevel = mergedOptions.logLevel;
    this.maxBufferSize = mergedOptions.maxBufferSize;
    this.flushInterval = mergedOptions.flushInterval;
    this.enableConsole = mergedOptions.enableConsole;

  /** @type {Array<{ level: LogLevel; message: string; args: unknown[]; timestamp: string; url: string; userAgent: string }>} */
  this.buffer = [];
    this.logLevels = { ...LOG_LEVELS };

    try {
      this.vscode = acquireVsCodeApi();
    } catch (error) {
      // Tests may provide a stub. Fall back to undefined if unavailable.
      this.vscode = undefined;
      console.warn("acquireVsCodeApi is not available in this context", error);
    }

    this._interval = null;
    this.startPeriodicFlush();
  }

  /**
   * @param {string} message
   * @param {...unknown} args
   */
  debug(message, ...args) {
    this.log("debug", message, args);
  }

  /**
   * @param {string} message
   * @param {...unknown} args
   */
  info(message, ...args) {
    this.log("info", message, args);
  }

  /**
   * @param {string} message
   * @param {...unknown} args
   */
  warn(message, ...args) {
    this.log("warn", message, args);
  }

  /**
   * @param {string} message
   * @param {...unknown} args
   */
  error(message, ...args) {
    this.log("error", message, args);
  }

  /**
   * @param {LogLevel} level
   * @param {string} message
   * @param {unknown[]} [args]
   */
  log(level, message, args = []) {
    if (this.logLevels[level] < this.logLevels[this.logLevel]) {
      return;
    }

    const sanitizedArgs = this.sanitizeArgs(args);
    const logEntry = {
      level,
      message,
      args: sanitizedArgs,
      timestamp: new Date().toISOString(),
      url: window.location?.href ?? "",
      userAgent: navigator.userAgent
    };

    this.buffer.push(logEntry);
    if (this.buffer.length > this.maxBufferSize) {
      this.buffer.shift();
    }

    if (this.enableConsole) {
      const consoleMethod = typeof console[level] === "function" ? console[level] : console.log;
      try {
        consoleMethod.call(console, `[Webview] ${message}`, ...args);
      } catch (error) {
        console.log(`[Webview] ${message}`, ...args, error);
      }
    }

    if (level === "error") {
      this.flushLogs();
    }
  }

  /**
   * @param {unknown[]} args
   * @returns {unknown[]}
   */
  sanitizeArgs(args) {
    return args.map((arg) => {
      if (arg instanceof Error) {
        return {
          name: arg.name,
          message: arg.message,
          stack: arg.stack
        };
      }
      if (typeof arg === "object" && arg !== null) {
        try {
          return JSON.parse(JSON.stringify(arg));
        } catch (error) {
          return `[Circular Object: ${error instanceof Error ? error.message : "unknown"}]`;
        }
      }
      return arg;
    });
  }

  flushLogs() {
    if (this.buffer.length === 0) {
      return;
    }

    const logs = [...this.buffer];
    this.buffer = [];

    if (!this.vscode?.postMessage) {
      return;
    }

    try {
      this.vscode.postMessage({
        type: "log",
        command: "flushLogs",
        payload: { logs }
      });
    } catch (error) {
      if (this.enableConsole) {
        console.error("Failed to flush webview logs", error);
      }
    }
  }

  startPeriodicFlush() {
    if (this._interval) {
      clearInterval(this._interval);
    }

    this._interval = setInterval(() => {
      if (this.buffer.length > 0) {
        this.flushLogs();
      }
    }, this.flushInterval);
  }
}

export function createWebviewLogger(options) {
  return new WebviewLogger(options);
}