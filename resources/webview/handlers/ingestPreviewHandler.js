/*
 * Follow instructions in copilot-instructions.md exactly.
 */

import { BaseHandler } from "./base/handlerInterface.js";
import { createValidator } from "./base/validation.js";
import { sanitizeText } from "../utils/sanitizers.js";

const validatePayload = createValidator({
  type: "object",
  properties: {
    previewId: { type: "string", required: true, minLength: 1, maxLength: 128 },
    title: { type: "string", maxLength: 512 },
    subtitle: { type: "string", maxLength: 1024 },
    content: { type: "string", maxLength: 200_000 },
    summary: { type: "string", maxLength: 8000 },
    tokenCount: {
      type: "object",
      properties: {
        total: { type: "number", min: 0 },
        approx: { type: "number", min: 0 }
      }
    },
    truncated: { type: "boolean" },
    format: { type: "enum", enum: ["markdown", "json", "text"], default: "markdown" },
    metadata: { type: "object", allowUnknown: true }
  }
});

export class IngestPreviewHandler extends BaseHandler {
  constructor(store, uiRenderer, options = {}) {
    super(store, uiRenderer, { ...options, messageTypes: ["ingestPreview"] });
  }

  canHandle(messageType) {
    return messageType === "ingestPreview";
  }

  validate(payload) {
    return validatePayload(payload);
  }

  async handle(payload) {
    const previewState = {
      id: payload.previewId,
      title: payload.title ?? "Digest Preview",
      subtitle: payload.subtitle ?? "Live digest preview",
      content: payload.content ?? "",
      summary: payload.summary ?? "",
      tokenCount: payload.tokenCount ?? null,
      truncated: Boolean(payload.truncated),
      format: payload.format ?? "markdown",
      metadata: payload.metadata ?? {}
    };

    this.store.setState({ preview: previewState });
    this.uiRenderer.updatePreview(previewState);

    if (previewState.tokenCount && Object.keys(previewState.tokenCount).length > 0) {
      this.uiRenderer.setTokenCount(previewState.tokenCount);
    }

    if (payload.metadata && typeof payload.metadata === "object") {
      const metaEntries = Object.entries(payload.metadata)
        .map(([key, value]) => `${sanitizeText(key)}=${sanitizeText(value)}`)
        .join(" · ");
      if (metaEntries) {
        this.uiRenderer.updateConfig({ previewMetadata: metaEntries });
      }
    }
  }
}