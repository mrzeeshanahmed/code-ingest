/*
 * Follow instructions in copilot-instructions.md exactly.
 */

import { BaseHandler } from "./base/handlerInterface.js";
import { createValidator } from "./base/validation.js";

const PHASES = ["scan", "filter", "tokenize", "ingest", "write", "select"];

const validatePayload = createValidator({
  type: "object",
  properties: {
    progressId: { type: "string", maxLength: 128 },
    phase: { type: "enum", enum: PHASES, required: true },
    percent: { type: "number", min: 0, max: 100 },
    message: { type: "string", maxLength: 2048 },
    cancellable: { type: "boolean" },
    cancelled: { type: "boolean" },
    overlayMessage: { type: "string", maxLength: 512 }
  }
});

export class ProgressHandler extends BaseHandler {
  constructor(store, uiRenderer, options = {}) {
    super(store, uiRenderer, { ...options, messageTypes: ["progress"] });
  }

  canHandle(messageType) {
    return messageType === "progress";
  }

  validate(payload) {
    return validatePayload(payload);
  }

  async handle(payload) {
    this.store.setState({
      progress: {
        id: payload.progressId,
        progressId: payload.progressId,
        phase: payload.phase,
        percent: typeof payload.percent === "number" ? payload.percent : undefined,
        message: payload.message,
        cancellable: Boolean(payload.cancellable),
        cancelled: Boolean(payload.cancelled)
      }
    });

    this.uiRenderer?.updateProgress?.(payload);

    const isSelectionPhase = payload.phase === "select";

    if (isSelectionPhase) {
      const showOverlay = Boolean(payload.overlayMessage) && payload.cancelled !== true && payload.percent !== 100;
      if (showOverlay) {
        this.uiRenderer?.toggleLoadingOverlay?.(true, payload.overlayMessage);
      } else {
        this.uiRenderer?.toggleLoadingOverlay?.(false);
      }
      return;
    }

    if (payload.overlayMessage || payload.phase === "ingest") {
      const showOverlay = payload.cancelled !== true && payload.percent !== 100;
      this.uiRenderer?.toggleLoadingOverlay?.(showOverlay, payload.overlayMessage ?? payload.message);
    } else if (payload.percent === 100) {
      this.uiRenderer?.toggleLoadingOverlay?.(false);
    }
  }
}