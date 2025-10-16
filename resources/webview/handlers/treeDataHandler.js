/*
 * Follow instructions in copilot-instructions.md exactly.
 */

import { BaseHandler } from "./base/handlerInterface.js";
import { createValidator } from "./base/validation.js";

const treeNodeSchema = {
  type: "object",
  allowUnknown: true,
  properties: {
    uri: { type: "string", required: true, maxLength: 1024 },
    name: { type: "string", maxLength: 256 },
    label: { type: "string", maxLength: 256 },
    expanded: { type: "boolean" },
    selected: { type: "boolean" },
    placeholder: { type: "boolean" },
    depth: { type: "number", min: 0, max: 50 },
    snippet: { type: "string", maxLength: 4096 },
    children: { type: "array", items: undefined, maxLength: 5_000 }
  }
};

treeNodeSchema.properties.children.items = treeNodeSchema;

const validatePayload = createValidator({
  type: "object",
  properties: {
    scanId: { type: "string", maxLength: 64 },
    tree: { type: "array", required: true, items: treeNodeSchema, maxLength: 10_000 },
    selection: { type: "array", items: { type: "string", maxLength: 1024 } },
    expandState: { type: "object", allowUnknown: true },
    warnings: { type: "array", items: { type: "string", maxLength: 1024 } }
  }
});

export class TreeDataHandler extends BaseHandler {
  constructor(store, uiRenderer, options = {}) {
    super(store, uiRenderer, { ...options, messageTypes: ["treeData"] });
  }

  canHandle(messageType) {
    return messageType === "treeData";
  }

  validate(payload) {
    return validatePayload(payload);
  }

  async handle(payload) {
    const statePatch = {
      tree: payload.tree,
      selection: payload.selection ?? []
    };

    this.store.setState(statePatch);

    this.uiRenderer?.updateTree?.(payload.tree, {
      scanId: payload.scanId,
      expandState: payload.expandState
    });

    if (payload.selection) {
      this.uiRenderer?.updateTreeSelection?.(payload.selection);
    }

    if (payload.warnings && payload.warnings.length > 0) {
      this.uiRenderer?.showRecoverableError?.({
        title: "Tree scan warnings",
        message: payload.warnings.join(" · ")
      });
    } else {
      this.uiRenderer?.clearRecoverableError?.();
    }
  }
}
