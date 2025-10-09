/*
 * Follow instructions in copilot-instructions.md exactly.
 */

import { BaseHandler } from "./base/handlerInterface.js";
import { createValidator } from "./base/validation.js";

const validatePayload = createValidator({
  type: "object",
  properties: {
    state: {
      type: "object",
      allowUnknown: true,
      properties: {
        selection: { type: "array", items: { type: "string", maxLength: 1024 } },
        expandState: { type: "object", allowUnknown: true },
        preview: {
          type: "object",
          properties: {
            title: { type: "string", maxLength: 512 },
            subtitle: { type: "string", maxLength: 1024 },
            content: { type: "string", maxLength: 200_000 }
          }
        },
        version: { type: "string", maxLength: 32 }
      }
    },
    migrated: { type: "boolean" }
  }
});

export class RestoredStateHandler extends BaseHandler {
  constructor(store, uiRenderer, options = {}) {
    super(store, uiRenderer, { ...options, messageTypes: ["restoredState"] });
  }

  canHandle(messageType) {
    return messageType === "restoredState";
  }

  validate(payload) {
    return validatePayload(payload);
  }

  async handle(payload) {
    if (!payload.state) {
      return;
    }

    this.store.setState((current) => ({
      ...current,
      ...payload.state
    }));

    this.uiRenderer.restoreState(payload.state);

    if (payload.migrated) {
      this.uiRenderer.showRecoverableError({
        title: "State updated",
        message: "Your previous settings were migrated to the new format."
      });
    }
  }
}
