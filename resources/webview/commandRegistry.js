/*
 * Follow instructions in copilot-instructions.md exactly.
 */

import { COMMAND_MAP } from "./commandMap.js";
import { MessageEnvelope } from "./messageEnvelope.js";
import { RateLimiter } from "./rateLimiter.js";
import { AcknowledgmentSystem } from "./acknowledgmentSystem.js";
import { validateCommandPayload } from "./commandValidation.js";

const DEFAULT_ACK_TIMEOUT = 5000;
const DEFAULT_POLICY = Object.freeze({ strategy: "parallel" });

function stableSerialize(value, seen = new WeakSet()) {
  if (value === null) {
    return "null";
  }
  const type = typeof value;
  if (type === "string") {
    return JSON.stringify(value);
  }
  if (type === "number") {
    return Number.isFinite(value) ? String(value) : `"__number__:${value}"`;
  }
  if (type === "boolean") {
    return value ? "true" : "false";
  }
  if (type === "undefined") {
    return "\"__undefined__\"";
  }
  if (type === "bigint") {
    return `"__bigint__:${value.toString()}"`;
  }
  if (type === "symbol") {
    return `"__symbol__:${String(value)}"`;
  }
  if (type === "function") {
    return "\"__function__\"";
  }
  if (value instanceof Date) {
    return `"__date__:${value.toISOString()}"`;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return "\"__circular__\"";
    }
    seen.add(value);
    const serialized = value.map((entry) => stableSerialize(entry, seen));
    seen.delete(value);
    return `[${serialized.join(",")}]`;
  }
  if (type === "object") {
    if (seen.has(value)) {
      return "\"__circular__\"";
    }
    seen.add(value);
    const keys = Object.keys(value).sort();
    const serialized = keys.map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key], seen)}`);
    seen.delete(value);
    return `{${serialized.join(",")}}`;
  }
  return JSON.stringify(String(value));
}

function hashString(subject) {
  const input = typeof subject === "string" ? subject : stableSerialize(subject);
  let hash = 0;
  for (let index = 0; index < input.length; index += 1) {
    hash = (hash * 131 + input.charCodeAt(index)) % 4_294_967_295;
  }
  return Math.abs(hash).toString(16);
}

function deriveDedupeKey(commandId, payload, policy) {
  if (!policy || policy.strategy !== "dedupe") {
    return undefined;
  }

  try {
    if (typeof policy.dedupeKey === "function") {
      const key = policy.dedupeKey(payload);
      if (typeof key === "string" && key.length > 0) {
        return `${commandId}|${hashString(key)}`;
      }
      if (typeof key === "number" && Number.isFinite(key)) {
        return `${commandId}|${key.toString(16)}`;
      }
    }

    const signature = hashString(payload);
    return `${commandId}|${signature}`;
  } catch (error) {
    console.warn?.("CommandRegistry: failed to derive dedupe key", { commandId, error });
    return undefined;
  }
}

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
    this.commandQueues = new Map();
    this.dedupeInFlight = new Map();
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
    const policy = this._normalisePolicy(options.policy, { requiresAck });

    this.commands.set(commandId, {
      handler,
      rateLimitMs,
      requiresAck,
      validation,
      direction,
      lastInvocation: 0,
      policy
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

    const validationResult = entry.validation ? entry.validation(payload) : { ok: true, value: payload };
    if (!validationResult || validationResult.ok !== true) {
      const reason = validationResult?.reason ?? "validation_failed";
      this.log.warn?.("Command validation failed", { commandId, reason });
      throw new Error(`Invalid payload for ${commandId}: ${reason}`);
    }

    const normalisedPayload = validationResult.value ?? payload;

    if (entry.direction === "local") {
      return await entry.handler(normalisedPayload, this._buildContext(commandId));
    }

    const policy = entry.policy ?? DEFAULT_POLICY;
    const dedupeKey = deriveDedupeKey(commandId, normalisedPayload, policy);

    if (dedupeKey) {
      const existing = this.dedupeInFlight.get(dedupeKey);
      if (existing) {
        this.log.debug?.("CommandRegistry: deduping outbound command", { commandId, dedupeKey });
        return existing;
      }
    }

    let executionPromise;

    if (policy.strategy === "queue" || entry.requiresAck) {
      executionPromise = this._enqueueCommand(entry, commandId, normalisedPayload);
    } else {
      executionPromise = this._executeOutbound(entry, commandId, normalisedPayload);
    }

    if (dedupeKey) {
      const trackedPromise = Promise.resolve(executionPromise).finally(() => {
        this.dedupeInFlight.delete(dedupeKey);
      });
      this.dedupeInFlight.set(dedupeKey, trackedPromise);
      return trackedPromise;
    }
    return executionPromise;
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

  async _executeOutbound(entry, commandId, payload, options = {}) {
    const skipRateLimit = options.skipRateLimit === true;
    const now = Date.now();
    if (!skipRateLimit && now - entry.lastInvocation < entry.rateLimitMs) {
      throw new Error(`Command rate limited: ${commandId}`);
    }

    if (!this.rateLimiter.isAllowed(commandId)) {
      throw new Error(`Command throttled: ${commandId}`);
    }

    entry.lastInvocation = now;
    this.rateLimiter.recordRequest(commandId);

    const message = this.envelope.createMessage("command", commandId, payload, {
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
        await entry.handler(payload, { message });
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

  _enqueueCommand(entry, commandId, payload) {
    const queueState = this._getQueueState(commandId);
    const shouldStartImmediately = queueState.queue.length === 0 && !queueState.inFlight;

    return new Promise((resolve, reject) => {
      queueState.queue.push({ entry, payload, resolve, reject, skipRateLimit: !shouldStartImmediately });
      if (shouldStartImmediately) {
        this._processQueue(commandId);
      }
    });
  }

  _processQueue(commandId) {
    const state = this.commandQueues.get(commandId);
    if (!state || state.inFlight) {
      return;
    }

    const next = state.queue.shift();
    if (!next) {
      return;
    }

    state.inFlight = true;

    Promise.resolve()
      .then(() => this._executeOutbound(next.entry, commandId, next.payload, { skipRateLimit: next.skipRateLimit }))
      .then(next.resolve, next.reject)
      .finally(() => {
        state.inFlight = false;
        this._processQueue(commandId);
      });
  }

  _getQueueState(commandId) {
    let state = this.commandQueues.get(commandId);
    if (!state) {
      state = { inFlight: false, queue: [] };
      this.commandQueues.set(commandId, state);
    }
    return state;
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

  _normalisePolicy(policyOptions, context) {
    const baseStrategy = context.requiresAck ? "queue" : "parallel";
    if (!policyOptions || typeof policyOptions !== "object") {
      return { strategy: baseStrategy };
    }

    const strategy = (() => {
      if (policyOptions.strategy === "dedupe") {
        return "dedupe";
      }
      if (policyOptions.strategy === "queue") {
        return "queue";
      }
      if (policyOptions.strategy === "parallel") {
        return "parallel";
      }
      return baseStrategy;
    })();

    const dedupeKey = typeof policyOptions.dedupeKey === "function" ? policyOptions.dedupeKey : undefined;

    return {
      strategy,
      dedupeKey
    };
  }
}
