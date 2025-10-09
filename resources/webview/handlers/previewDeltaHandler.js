/*
 * Follow instructions in copilot-instructions.md exactly.
 */

import { BaseHandler } from "./base/handlerInterface.js";
import { createValidator } from "./base/validation.js";

const validatePayload = createValidator({
  type: "object",
  properties: {
    deltaId: { type: "string", maxLength: 64 },
    changes: {
      type: "array",
      required: true,
      maxLength: 500,
      items: {
        type: "object",
        properties: {
          changeType: { type: "enum", enum: ["append", "update", "remove", "replace"], default: "update" },
          content: { type: "string", maxLength: 50_000 }
        }
      }
    },
    tokenCount: {
      type: "object",
      properties: {
        total: { type: "number", min: 0 },
        approx: { type: "number", min: 0 }
      }
    }
  }
});

export class PreviewDeltaHandler extends BaseHandler {
  constructor(store, uiRenderer, options = {}) {
    super(store, uiRenderer, { ...options, messageTypes: ["previewDelta"] });
  }

  canHandle(messageType) {
    return messageType === "previewDelta";
  }

  validate(payload) {
    return validatePayload(payload);
  }

  async handle(payload) {
    this.uiRenderer.applyPreviewDelta(payload);

    if (payload.tokenCount) {
      this.uiRenderer.setTokenCount(payload.tokenCount);
      this.store.setState((current) => ({
        preview: {
          ...(current.preview ?? {}),
          tokenCount: payload.tokenCount
        }
      }));
    }
  }
}
