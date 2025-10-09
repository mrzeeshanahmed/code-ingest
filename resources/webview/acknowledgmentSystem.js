/*
 * Follow instructions in copilot-instructions.md exactly.
 */

export class AcknowledgmentSystem {
  constructor(timeout = 5000) {
    this.timeout = timeout;
    this.pendingAcks = new Map();
  }

  waitForAcknowledgment(messageId) {
    if (!messageId) {
      return Promise.resolve();
    }

    if (this.pendingAcks.has(messageId)) {
      return this.pendingAcks.get(messageId).promise;
    }

    let resolveFn;
    let rejectFn;
    const promise = new Promise((resolve, reject) => {
      resolveFn = resolve;
      rejectFn = reject;
    });

    const timeoutId = setTimeout(() => {
      this.pendingAcks.delete(messageId);
      rejectFn?.(new Error(`Command timeout: ${messageId}`));
    }, this.timeout);

    this.pendingAcks.set(messageId, {
      resolve: (value) => {
        clearTimeout(timeoutId);
        this.pendingAcks.delete(messageId);
        resolveFn?.(value);
      },
      reject: (error) => {
        clearTimeout(timeoutId);
        this.pendingAcks.delete(messageId);
        rejectFn?.(error);
      },
      timeoutId,
      promise
    });

    return promise;
  }

  handleAcknowledgment(messageId, result) {
    const pending = this.pendingAcks.get(messageId);
    if (!pending) {
      return false;
    }

    pending.resolve(result);
    return true;
  }

  reject(messageId, error) {
    const pending = this.pendingAcks.get(messageId);
    if (!pending) {
      return false;
    }

    pending.reject(error instanceof Error ? error : new Error(String(error)));
    return true;
  }
}
