/*
 * Follow instructions in copilot-instructions.md exactly.
 */

export class RateLimiter {
  constructor(options = {}) {
    const { windowMs = 1000, maxRequests = 10 } = options;
    this.windowMs = windowMs;
    this.maxRequests = maxRequests;
    this.commandCounts = new Map();
  }

  isAllowed(commandId) {
    if (!commandId) {
      return true;
    }

    const now = Date.now();
    const windowStart = now - this.windowMs;
    const entries = this.commandCounts.get(commandId) ?? [];
    const filtered = entries.filter((timestamp) => timestamp >= windowStart);

    if (filtered.length >= this.maxRequests) {
      this.commandCounts.set(commandId, filtered);
      return false;
    }

    this.commandCounts.set(commandId, filtered);
    return true;
  }

  recordRequest(commandId) {
    if (!commandId) {
      return;
    }

    const now = Date.now();
    const entries = this.commandCounts.get(commandId) ?? [];
    entries.push(now);
    this.commandCounts.set(commandId, entries);
  }
}