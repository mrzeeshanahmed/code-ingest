/*
 * Follow instructions in copilot-instructions.md exactly.
 */

import { BaseHandler } from "./base/handlerInterface.js";
import { createValidator } from "./base/validation.js";

const validatePayload = createValidator({
  type: "object",
  properties: {
    resultId: { type: "string", maxLength: 64 },
    title: { type: "string", maxLength: 512 },
    subtitle: { type: "string", maxLength: 1024 },
    content: { type: "string", maxLength: 200_000 },
    format: { type: "enum", enum: ["markdown", "json", "text"], default: "markdown" },
    tokenCount: {
      type: "object",
      properties: {
        total: { type: "number", min: 0 },
        approx: { type: "number", min: 0 }
      }
    },
    truncated: { type: "boolean" },
    stats: { type: "object", allowUnknown: true },
    redacted: { type: "boolean" },
    summary: { type: "string", maxLength: 8000 }
  }
});

export class GenerationResultHandler extends BaseHandler {
  constructor(store, uiRenderer, options = {}) {
    super(store, uiRenderer, { ...options, messageTypes: ["generationResult"] });
  }

  canHandle(messageType) {
    return messageType === "generationResult";
  }

  validate(payload) {
    return validatePayload(payload);
  }

  async handle(payload) {
    const result = {
      id: payload.resultId,
      title: payload.title,
      subtitle: payload.subtitle,
      content: payload.content,
      format: payload.format,
      tokenCount: payload.tokenCount,
      truncated: Boolean(payload.truncated),
      stats: payload.stats,
      redacted: Boolean(payload.redacted),
      summary: payload.summary
    };

    this.store.setState({ lastGeneration: result });
    this.uiRenderer.showGenerationResult(result);
  }
}
