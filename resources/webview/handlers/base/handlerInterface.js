/*
 * Follow instructions in copilot-instructions.md exactly.
 */

const REQUIRED_OVERRIDES = ["validate", "handle"];

/**
 * @typedef {import("../types").HandlerValidationResult} HandlerValidationResult
 */

/**
 * Base class for all webview handlers. Concrete handlers should extend this class
 * and provide message-type specific validation and handling logic. The base class
 * centralises common utilities such as host communication, logging and defensive
 * execution helpers. All implementations must remain dependency-free and avoid
 * heavy runtime checks to keep the webview bundle lean.
 */
export class BaseHandler {
  /**
   * @param {import("../../store").StoreApi} store
   * @param {import("../../uiRenderer").UIRenderer} uiRenderer
   * @param {{
   *   messageTypes?: string[];
   *   postMessage?: (payload: unknown) => void;
   *   log?: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void; error: (...args: unknown[]) => void };
   * }} [options]
   */
  constructor(store, uiRenderer, options = {}) {
    if (!store || typeof store.getState !== "function" || typeof store.setState !== "function") {
      throw new TypeError("BaseHandler requires a valid store with getState/setState.");
    }

    if (!uiRenderer || typeof uiRenderer !== "object") {
      throw new TypeError("BaseHandler requires a uiRenderer instance.");
    }

    this.store = store;
    this.uiRenderer = uiRenderer;
    this.messageTypes = new Set(options.messageTypes ?? []);
    this.postMessage = typeof options.postMessage === "function" ? options.postMessage : () => undefined;
    this.log = options.log ?? console;
    this.handlerName = typeof options.handlerName === "string" && options.handlerName.length > 0
      ? options.handlerName
      : this.constructor?.name ?? "BaseHandler";

    this._verifyOverrides();
  }

  /**
   * Ensures subclasses have implemented the expected interface. The check is kept lightweight
   * to avoid impacting runtime performance in production scenarios.
   * @private
   */
  _verifyOverrides() {
    const proto = Object.getPrototypeOf(this);
    const handlerName = this.handlerName;
    for (const methodName of REQUIRED_OVERRIDES) {
      if (proto?.[methodName] === BaseHandler.prototype[methodName]) {
        throw new Error(`${handlerName} must override ${methodName}().`);
      }
    }
  }

  /**
   * @param {string} messageType
   * @returns {boolean}
   */
  canHandle(messageType) {
    if (typeof messageType !== "string" || messageType.length === 0) {
      return true;
    }
    if (this.messageTypes.size === 0) {
      return true;
    }
    return this.messageTypes.has(messageType);
  }

  /**
   * Execute message handling with defensive guards. Subclasses rarely need to override this –
   * they should implement `validate` and `handle` instead.
   *
   * @param {string} messageType
   * @param {unknown} payload
   * @returns {Promise<void>}
   */
  async process(messageType, payload) {
    try {
      const validation = this.validate(payload, messageType);
      const result = typeof validation === "boolean"
        ? { ok: validation, value: payload }
        : validation;

      if (!result || result.ok !== true) {
        const reason = result?.reason ?? "validation_failed";
        this.log.warn?.("Handler validation failed", { messageType, reason });
        this._notifyHost("handler:validationFailed", { messageType, reason });
        return;
      }

      await this.handle(result.value ?? payload, messageType);
    } catch (error) {
      this.log.error?.("Handler process failed", error);
      this._notifyHost("handler:failed", {
        messageType,
        error: this._scrubError(error)
      });
      this.uiRenderer?.showRecoverableError?.({
        title: "Action failed",
        message: "Something went wrong while updating the view.",
        detail: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /**
   * @param {unknown} payload
   * @param {string} [messageType]
   * @returns {HandlerValidationResult | boolean}
   */
  validate(payload, _messageType) {
    throw new Error(`${this.handlerName}.validate(payload, messageType) must be implemented by the subclass.`);
  }

  /**
   * @param {unknown} payload
   * @param {string} [messageType]
   * @returns {Promise<void> | void}
   */
  handle(payload, _messageType) {
    throw new Error(`${this.handlerName}.handle(payload, messageType) must be implemented by the subclass.`);
  }

  /**
   * @param {unknown} error
   * @returns {{ message: string; stack?: string }}
   * @private
   */
  _scrubError(error) {
    if (!error) {
      return { message: "unknown_error" };
    }

    if (error instanceof Error) {
      return {
        message: error.message.slice(0, 512),
        stack: error.stack?.split("\n").slice(0, 5).join("\n")
      };
    }

    const asString = String(error);
    return { message: asString.slice(0, 512) };
  }

  /**
   * @param {string} type
   * @param {Record<string, unknown>} payload
   * @private
   */
  _notifyHost(type, payload) {
    try {
      this.postMessage({ type, payload });
    } catch (error) {
      this.log.error?.("Failed to notify host", error);
    }
  }
}
