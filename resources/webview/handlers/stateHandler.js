/*
 * Follow instructions in copilot-instructions.md exactly.
 */

import { BaseHandler } from "./base/handlerInterface.js";
import { createValidator } from "./base/validation.js";

const treeArraySchema = { type: "array", items: { type: "object", allowUnknown: true }, maxLength: 10_000 };

const stateUpdateValidator = createValidator({
  type: "object",
  required: true,
  allowUnknown: true,
  properties: {
    tree: treeArraySchema,
    preview: { type: "object", allowUnknown: true },
    progress: { type: "object", allowUnknown: true },
    selection: { type: "array", items: { type: "string", maxLength: 1024 } },
    status: { type: "string", maxLength: 64 },
    viewState: { type: "object", allowUnknown: true }
  }
});

const statePatchValidator = createValidator({
  type: "object",
  allowUnknown: true
});

export class StateHandler extends BaseHandler {
  constructor(store, uiRenderer, options = {}) {
    super(store, uiRenderer, {
      ...options,
      messageTypes: ["state:update", "state:patch", "state"]
    });
  }

  canHandle(messageType) {
    return messageType === "state:update" || messageType === "state:patch" || messageType === "state";
  }

  validate(payload, messageType) {
    if (messageType === "state:update") {
      return stateUpdateValidator(payload);
    }
    return statePatchValidator(payload);
  }

  async handle(payload, messageType) {
    if (messageType === "state:update") {
      this.store.setState(payload ?? {});
    } else if (messageType === "state") {
      this.store.setState((current) => ({ ...current, viewState: payload?.viewState }));
    } else {
      this.store.setState((current) => ({ ...current, ...(payload ?? {}) }));
    }

    if (payload?.tree) {
      this.uiRenderer?.updateTree?.(payload.tree);
    }
    if (payload?.selection) {
      this.uiRenderer?.updateTreeSelection?.(payload.selection);
    }
    if (payload?.preview) {
      this.uiRenderer?.updatePreview?.(payload.preview);
    }
    if (payload?.progress) {
      this.uiRenderer?.updateProgress?.(payload.progress);
    }
  }
}
