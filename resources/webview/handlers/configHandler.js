/*
 * Follow instructions in copilot-instructions.md exactly.
 */

import { BaseHandler } from "./base/handlerInterface.js";
import { createValidator } from "./base/validation.js";
import { sanitizeRecord } from "../utils/sanitizers.js";
import { buildConfigDisplay } from "../utils/configSummary.js";

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
    const sanitizedConfig = sanitizeRecord(payload.config ?? {});
    const currentState = this.store.getState ? this.store.getState() : {};
    const mergedConfig = {
      ...(currentState?.config ?? {}),
      ...sanitizedConfig
    };
    const activePreset = payload.activePreset ?? currentState?.activePreset ?? "default";
    mergedConfig.preset = activePreset;

    const display = buildConfigDisplay(mergedConfig);
    const configWithSummary = { ...mergedConfig, summary: display };

    const nextState = {
      config: configWithSummary,
      activePreset,
      presets: Array.isArray(payload.presets) ? payload.presets : currentState?.presets
    };

    const redactionOverride = Boolean(mergedConfig.redactionOverride);
    const currentGeneration = currentState?.generation;
    if (!currentGeneration || currentGeneration.redactionOverride !== redactionOverride) {
      nextState.generation = {
        ...(currentGeneration ?? {}),
        redactionOverride
      };
    }

    this.store.setState(nextState);
    this.uiRenderer.updateConfig(configWithSummary);

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
