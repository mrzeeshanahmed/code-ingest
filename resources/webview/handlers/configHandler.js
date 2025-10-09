/*
 * Follow instructions in copilot-instructions.md exactly.
 */

import { BaseHandler } from "./base/handlerInterface.js";
import { createValidator } from "./base/validation.js";
import { sanitizeRecord } from "../utils/sanitizers.js";

const validatePayload = createValidator({
  type: "object",
  required: true,
  properties: {
    config: { type: "object", allowUnknown: true },
    presets: { type: "array", items: { type: "string", maxLength: 128 } },
    activePreset: { type: "string", maxLength: 128 },
    validationErrors: { type: "array", items: { type: "string", maxLength: 512 } }
  }
});

export class ConfigHandler extends BaseHandler {
  constructor(store, uiRenderer, options = {}) {
    super(store, uiRenderer, { ...options, messageTypes: ["config"] });
  }

  canHandle(messageType) {
    return messageType === "config";
  }

  validate(payload) {
    return validatePayload(payload);
  }

  async handle(payload) {
    const config = sanitizeRecord(payload.config ?? {});
    this.store.setState((current) => ({
      config: { ...current.config, ...config },
      activePreset: payload.activePreset ?? current.activePreset,
      presets: payload.presets ?? current.presets
    }));

    const summary = {
      ...config,
      preset: payload.activePreset ?? "Custom"
    };
    this.uiRenderer.updateConfig(summary);

    if (payload.validationErrors && payload.validationErrors.length > 0) {
      this.uiRenderer.showRecoverableError({
        title: "Configuration issues",
        message: payload.validationErrors.join(" · ")
      });
    } else {
      this.uiRenderer.clearRecoverableError();
    }
  }
}
