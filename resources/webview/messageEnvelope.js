/*
 * Follow instructions in copilot-instructions.md exactly.
 */

import { COMMAND_MAP } from "./commandMap.js";

const ALLOWED_TYPES = new Set(["command", "response", "event"]);

function getKnownCommands(direction, commandMap = COMMAND_MAP) {
  if (!commandMap) {
    return new Set();
  }

  if (direction === "outbound") {
    return new Set(Object.values(commandMap.WEBVIEW_TO_HOST ?? {}));
  }

  return new Set(Object.values(commandMap.HOST_TO_WEBVIEW ?? {}));
}

export class MessageEnvelope {
  constructor(options = {}) {
    const { commandMap = COMMAND_MAP, sessionToken } = options;
    this.commandMap = commandMap;
    this.messageId = 0;
    this.sessionToken = sessionToken ?? this.generateSessionToken();
    this.allowedClockDriftMs = 30_000;
    this.lastTimestamps = new Map();
  }

  createMessage(type, command, payload = {}, metadata = {}) {
    if (!ALLOWED_TYPES.has(type)) {
      throw new TypeError(`Unsupported message type: ${type}`);
    }

    const knownCommands = getKnownCommands(type === "command" ? "outbound" : "inbound", this.commandMap);
    if (!knownCommands.has(command)) {
      throw new Error(`Unknown command: ${command}`);
    }

    return {
      id: ++this.messageId,
      type,
      command,
      payload,
      timestamp: Date.now(),
      token: this.sessionToken,
      expectsAck: Boolean(metadata.expectsAck)
    };
  }

  validateMessage(message, options = {}) {
    const { direction = "inbound", requireToken = true } = options;
    const errors = [];

    if (!message || typeof message !== "object") {
      errors.push("message must be an object");
      return { ok: false, reason: errors[0], errors };
    }

    if (typeof message.id !== "number" || !Number.isFinite(message.id)) {
      errors.push("missing message id");
    }

    if (!ALLOWED_TYPES.has(message.type)) {
      errors.push(`invalid message type: ${message.type}`);
    }

    if (typeof message.command !== "string" || message.command.length === 0) {
      errors.push("invalid command identifier");
    } else {
      const knownCommands = getKnownCommands(direction, this.commandMap);
      if (!knownCommands.has(message.command)) {
        errors.push(`unknown command: ${message.command}`);
      }
    }

    if (typeof message.timestamp !== "number") {
      errors.push("missing timestamp");
    } else {
      const now = Date.now();
      if (Math.abs(now - message.timestamp) > this.allowedClockDriftMs) {
        errors.push("stale message timestamp");
      } else {
        const lastTimestamp = this.lastTimestamps.get(message.command) ?? 0;
        if (message.timestamp < lastTimestamp) {
          errors.push("timestamp replay detected");
        } else {
          this.lastTimestamps.set(message.command, message.timestamp);
        }
      }
    }

    if (requireToken) {
      if (typeof message.token !== "string" || message.token.length === 0) {
        errors.push("missing session token");
      } else if (direction === "inbound" && message.token !== this.sessionToken) {
        errors.push("session token mismatch");
      }
    }

    if (errors.length > 0) {
      return { ok: false, reason: errors[0], errors };
    }

    return { ok: true, value: message };
  }

  generateSessionToken() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) {
      return crypto.randomUUID();
    }

    return Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  setSessionToken(token) {
    if (typeof token === "string" && token.length > 0) {
      this.sessionToken = token;
    }
  }
}