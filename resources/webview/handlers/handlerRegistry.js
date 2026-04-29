/*
 * Follow instructions in copilot-instructions.md exactly.
 */

import { sanitizeText } from "../utils/sanitizers.js";

export class HandlerRegistry {
  /**
   * @param {{
   *   logger?: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void; error: (...args: unknown[]) => void };
   *   fallbackHandler?: (type: string, payload: unknown) => void;
   * }} [options]
   */
  constructor(options = {}) {
    this.handlers = new Map();
    this.logger = options.logger ?? console;
    this.fallbackHandler = typeof options.fallbackHandler === "function" ? options.fallbackHandler : null;
    this.ready = false;
    this.buffer = [];
  }

  /**
   * @param {string | string[]} messageType
   * @param {{ process: (messageType: string, payload: unknown) => Promise<void>; canHandle?: (messageType: string) => boolean }} handler
   */
  register(messageType, handler) {
    const types = Array.isArray(messageType) ? messageType : [messageType];
    for (const type of types) {
      try {
        if (typeof type !== "string" || !type) {
          throw new TypeError("Message type must be a non-empty string.");
        }
        if (!handler || typeof handler.process !== "function") {
          throw new TypeError(`Handler for ${type} must expose a process(messageType, payload) method.`);
        }
        if (typeof handler.validate !== "function" || typeof handler.handle !== "function") {
          throw new TypeError(`Handler for ${type} must implement validate(payload) and handle(payload).`);
        }
        if (typeof handler.canHandle !== "function") {
          this.logger.warn?.(`Handler for ${type} does not implement canHandle(messageType); defaulting to permissive handler.`);
          handler.canHandle = () => true;
        }

        this.handlers.set(type, handler);
      } catch (error) {
        const normalizedError = error instanceof Error ? error : new Error(String(error));
        this.logger.error?.("Failed to register handler", { type, error: normalizedError.message });
        this._reportError(`registry:register:${type ?? "unknown"}`, normalizedError);
        this._notifyRegistrationFailure(type, normalizedError);
        throw normalizedError;
      }
    }
  }

  clear() {
    this.handlers.clear();
    if (this.buffer.length > 0) {
      const pending = this.buffer.splice(0);
      for (const entry of pending) {
        entry.reject?.(new Error("Handler registry cleared before processing buffered message"));
      }
    }
    this.ready = false;
  }

  /**
   * @param {string} messageType
   * @returns {any}
   */
  getHandler(messageType) {
    return this.handlers.get(messageType);
  }

  /**
   * @param {string} messageType
   * @param {unknown} payload
   */
  async process(messageType, payload) {
    if (!messageType) {
      this.logger.warn("Received message without type.");
      return;
    }

    if (!this.ready) {
      return new Promise((resolve, reject) => {
        this.buffer.push({ messageType, payload, resolve, reject });
      });
    }

    const handler = this.handlers.get(messageType);
    if (!handler) {
      this.logger.warn(`No handler registered for message type: ${messageType}`);
      if (this.fallbackHandler) {
        try {
          this.fallbackHandler(messageType, payload);
        } catch (error) {
          this.logger.error("Fallback handler failed", error);
        }
      }
      return;
    }

    if (typeof handler.canHandle === "function" && !handler.canHandle(messageType)) {
      this.logger.warn(`Handler refused message type: ${messageType}`);
      return;
    }

    try {
      await handler.process(messageType, payload);
    } catch (error) {
      this.logger.error?.(`Failed to process message: ${messageType}`, error);
      this._reportError(messageType, error);
      if (error instanceof Error) {
        Object.defineProperty(error, "__handlerReported", {
          value: true,
          enumerable: false,
          configurable: true
        });
      }
      throw error;
    }
  }

  _reportError(messageType, error) {
    const payload = {
      type: sanitizeText(messageType, { maxLength: 128 }),
      message: error instanceof Error ? sanitizeText(error.message, { maxLength: 512 }) : sanitizeText(String(error), { maxLength: 512 })
    };
    try {
      window.vscode?.postMessage?.({ type: "handler:error", payload });
    } catch (postError) {
      this.logger.error?.("Failed to report handler error", postError);
    }
  }

  _notifyRegistrationFailure(messageType, error) {
    const payload = {
      type: sanitizeText(messageType ?? "unknown", { maxLength: 128 }),
      reason: error instanceof Error ? sanitizeText(error.message, { maxLength: 512 }) : sanitizeText(String(error), { maxLength: 512 })
    };

    try {
      window.vscode?.postMessage?.({ type: "handler:registrationFailed", payload });
    } catch (postError) {
      this.logger.error?.("Failed to post handler registration failure", postError);
    }
  }

  setReady() {
    if (this.ready) {
      return;
    }

    this.ready = true;

    if (this.buffer.length === 0) {
      return;
    }

    const pending = this.buffer.splice(0);
    for (const entry of pending) {
      void this.process(entry.messageType, entry.payload)
        .then((result) => {
          entry.resolve?.(result);
        })
        .catch((error) => {
          const reportableError = error instanceof Error ? error : new Error(String(error));
          if (!(reportableError instanceof Error && reportableError.__handlerReported === true)) {
            this._reportError(entry.messageType, reportableError);
          }
          entry.reject?.(error);
        });
    }
  }
}