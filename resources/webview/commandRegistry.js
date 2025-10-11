/*
 * Follow instructions in copilot-instructions.md exactly.
 */

import { COMMAND_MAP } from "./commandMap.js";
import { MessageEnvelope } from "./messageEnvelope.js";
import { RateLimiter } from "./rateLimiter.js";
import { AcknowledgmentSystem } from "./acknowledgmentSystem.js";
import { validateCommandPayload } from "./commandValidation.js";

const DEFAULT_ACK_TIMEOUT = 5000;

function resolveDirection(commandId) {
  const outbound = Object.values(COMMAND_MAP.WEBVIEW_TO_HOST ?? {});
  if (outbound.includes(commandId)) {
    return "outbound";
  }

  const inbound = Object.values(COMMAND_MAP.HOST_TO_WEBVIEW ?? {});
  if (inbound.includes(commandId)) {
    return "inbound";
  }

  return "local";
}

function normaliseValidation(validation, commandId) {
  if (typeof validation === "function") {
    return validation;
  }

  return (payload) => validateCommandPayload(commandId, payload);
}

export class CommandRegistry {
  constructor(options = {}) {
    const {
      postMessage,
      logger = console,
      envelope = new MessageEnvelope(),
      rateLimiter = new RateLimiter(),
      acknowledgmentSystem = new AcknowledgmentSystem(options.acknowledgeTimeout || DEFAULT_ACK_TIMEOUT),
      acknowledgeTimeout = DEFAULT_ACK_TIMEOUT
    } = options;

    if (typeof postMessage !== "function") {
      throw new TypeError("CommandRegistry requires a postMessage function");
    }

    this.postMessage = postMessage;
    this.log = logger;
    this.envelope = envelope;
    this.rateLimiter = rateLimiter;
    this.ackSystem = acknowledgmentSystem;
    this.acknowledgeTimeout = acknowledgeTimeout;

    this.commands = new Map();
    this.pendingCommands = new Map();
  }

  register(commandId, handler, options = {}) {
    if (typeof commandId !== "string" || commandId.length === 0) {
      throw new TypeError("commandId must be a non-empty string");
    }

    const direction = options.direction ?? resolveDirection(commandId);
    const requiresHandler = direction === "inbound" || direction === "local";

    if (requiresHandler && typeof handler !== "function") {
      throw new TypeError(`Command ${commandId} requires a handler function`);
    }

    const rateLimitMs = typeof options.rateLimitMs === "number" ? options.rateLimitMs : 100;
    const requiresAck = Boolean(options.requiresAck);
    const validation = normaliseValidation(options.validation, commandId);

    this.commands.set(commandId, {
      handler,
      rateLimitMs,
      requiresAck,
      validation,
      direction,
      lastInvocation: 0
    });

    return () => {
      this.commands.delete(commandId);
    };
  }

  async execute(commandId, payload = {}) {
    const entry = this.commands.get(commandId);
    if (!entry) {
      throw new Error(`Command not registered: ${commandId}`);
    }

    if (entry.direction !== "outbound" && entry.direction !== "local") {
      throw new Error(`Command ${commandId} cannot be executed from webview context`);
    }

    const now = Date.now();
    if (now - entry.lastInvocation < entry.rateLimitMs) {
      throw new Error(`Command rate limited: ${commandId}`);
    }

    if (!this.rateLimiter.isAllowed(commandId)) {
      throw new Error(`Command throttled: ${commandId}`);
    }

    const validationResult = entry.validation ? entry.validation(payload) : { ok: true, value: payload };
    if (!validationResult || validationResult.ok !== true) {
      const reason = validationResult?.reason ?? "validation_failed";
      this.log.warn?.("Command validation failed", { commandId, reason });
      throw new Error(`Invalid payload for ${commandId}: ${reason}`);
    }

    const normalisedPayload = validationResult.value ?? payload;
    entry.lastInvocation = now;
    this.rateLimiter.recordRequest(commandId);

    if (entry.direction === "local") {
      return await entry.handler(normalisedPayload, this._buildContext(commandId));
    }

    const message = this.envelope.createMessage("command", commandId, normalisedPayload, {
      expectsAck: entry.requiresAck
    });

    let ackPromise;
    if (entry.requiresAck) {
      ackPromise = this.ackSystem.waitForAcknowledgment(message.id);
      this.pendingCommands.set(message.id, {
        commandId,
        timestamp: now,
        promise: ackPromise
      });
    }

    try {
      if (typeof entry.handler === "function") {
        await entry.handler(normalisedPayload, { message });
      }
    } catch (handlerError) {
      this.log.error?.("Command handler failed", handlerError);
      if (entry.requiresAck && ackPromise) {
        this.ackSystem.reject(message.id, handlerError);
        this.pendingCommands.delete(message.id);
      }
      throw handlerError;
    }

    this.postMessage(message);

    if (entry.requiresAck && ackPromise) {
      return ackPromise;
    }

    return { ok: true };
  }

  async handleIncoming(message) {
    const validation = this.envelope.validateMessage(message, { direction: "inbound" });
    if (!validation.ok) {
      this.log.warn?.("Rejected incoming message", validation.reason);
      return;
    }

    const entry = this.commands.get(message.command);
    if (!entry) {
      this.log.warn?.("No handler registered for command", { commandId: message.command });
      return;
    }

    if (entry.direction !== "inbound") {
      this.log.warn?.("Received inbound message for outbound command", { commandId: message.command });
      return;
    }

    if (!this.rateLimiter.isAllowed(message.command)) {
      this.log.warn?.("Inbound command throttled", { commandId: message.command });
      return;
    }

    const payloadValidation = entry.validation ? entry.validation(message.payload) : { ok: true, value: message.payload };
    if (!payloadValidation || payloadValidation.ok !== true) {
      const reason = payloadValidation?.reason ?? "validation_failed";
      this.log.warn?.("Inbound command payload rejected", { commandId: message.command, reason });
      this._sendErrorResponse(message, reason);
      return;
    }

    const context = this._buildContext(message.command, message);

    try {
      const result = await entry.handler(payloadValidation.value ?? message.payload, context);
      if (message.expectsAck) {
        this._sendAck(message, result);
      }
    } catch (error) {
      this.log.error?.("Inbound command handler failed", error);
      this._sendErrorResponse(message, error instanceof Error ? error.message : String(error));
    }
  }

  handleResponse(message) {
    if (!message || typeof message !== "object") {
      return;
    }

    const resolved = this.ackSystem.handleAcknowledgment(message.id, message.payload);
    if (resolved) {
      this.pendingCommands.delete(message.id);
    }
  }

  _sendAck(originalMessage, payload) {
    try {
      const response = {
        id: originalMessage.id,
        type: "response",
        command: originalMessage.command,
        payload: payload ?? { ok: true },
        timestamp: Date.now(),
        token: this.envelope.sessionToken
      };
      this.postMessage(response);
    } catch (error) {
      this.log.error?.("Failed to send acknowledgment", error);
    }
  }

  _sendErrorResponse(originalMessage, reason) {
    if (!originalMessage?.expectsAck) {
      return;
    }

    this._sendAck(originalMessage, {
      ok: false,
      reason
    });
  }

  _buildContext(commandId, message) {
    return {
      commandId,
      message,
      postMessage: this.postMessage,
      logger: this.log
    };
  }
}
