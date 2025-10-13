/*
 * Follow instructions in copilot-instructions.md exactly.
 */

import { BaseHandler } from "./base/handlerInterface.js";
import { createValidator } from "./base/validation.js";

const treeNodeSchema = {
  type: "object",
  allowUnknown: true,
  properties: {
    uri: { type: "string", maxLength: 1024 },
    name: { type: "string", maxLength: 256 },
    relPath: { type: "string", maxLength: 1024 },
    type: { type: "string", maxLength: 16 },
    children: { type: "array", maxLength: 5_000 }
  }
};

treeNodeSchema.properties.children.items = treeNodeSchema;

const validatePayload = createValidator({
  type: "object",
  properties: {
    state: {
      type: "object",
      allowUnknown: true,
      properties: {
        tree: { type: "array", items: treeNodeSchema, maxLength: 10_000 },
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
        version: { type: "string", maxLength: 32 },
        status: { type: "string", maxLength: 64 },
        totalFiles: { type: "number", min: 0 },
        warnings: { type: "array", items: { type: "string", maxLength: 1024 } }
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

    if (payload.state.config && typeof payload.state.config === "object") {
      const actions = this.store.getActions?.();
      if (actions?.config?.update) {
        actions.config.update(payload.state.config);
      }
    }

    if (Object.prototype.hasOwnProperty.call(payload.state, "redactionOverride")) {
      const actions = this.store.getActions?.();
      if (actions?.config?.update) {
        actions.config.update({ redactionOverride: Boolean(payload.state.redactionOverride) });
      }
    }

    if (Array.isArray(payload.state.tree)) {
      this.uiRenderer.updateTree(payload.state.tree, {
        expandState: payload.state.expandState
      });
    }

    this.uiRenderer.restoreState(payload.state);

    if (payload.migrated) {
      this.uiRenderer.showRecoverableError({
        title: "State updated",
        message: "Your previous settings were migrated to the new format."
      });
    }
  }
}
