/*
 * Follow instructions in copilot-instructions.md exactly.
 */

import { BaseHandler } from "./base/handlerInterface.js";
import { createValidator } from "./base/validation.js";
import { sanitizeText } from "../utils/sanitizers.js";

const validatePayload = createValidator({
  type: "object",
  properties: {
    errorId: { type: "string", maxLength: 64 },
    message: { type: "string", required: true, maxLength: 2048 },
    code: { type: "string", maxLength: 128 },
    details: { type: "string", maxLength: 10_000 },
    recoverable: { type: "boolean" },
    hint: { type: "string", maxLength: 1024 }
  }
});

export class IngestErrorHandler extends BaseHandler {
  constructor(store, uiRenderer, options = {}) {
    super(store, uiRenderer, { ...options, messageTypes: ["ingestError"] });
  }

  canHandle(messageType) {
    return messageType === "ingestError";
  }

  validate(payload) {
    return validatePayload(payload);
  }

  async handle(payload) {
    const errorEntry = {
      id: payload.errorId,
      message: sanitizeText(payload.message, { maxLength: 2048 }),
      code: payload.code,
      details: payload.details ? sanitizeText(payload.details, { maxLength: 10_000 }) : undefined,
      recoverable: Boolean(payload.recoverable)
    };

    this.store.setState((current) => ({
      errors: [...(current.errors ?? []), errorEntry]
    }));

    this.uiRenderer.showRecoverableError({
      title: payload.code ? `Error ${payload.code}` : "Ingestion error",
      message: errorEntry.message,
      detail: errorEntry.details
    });

    if (payload.hint) {
      this.uiRenderer.updateConfig({ hint: payload.hint });
    }

    this.postMessage({
      type: "handler:errorCaptured",
      payload: {
        id: payload.errorId,
        message: errorEntry.message,
        code: payload.code
      }
    });
  }
}
