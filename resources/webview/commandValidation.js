/*
 * Follow instructions in copilot-instructions.md exactly.
 */

import { createValidator } from "./handlers/base/validation.js";

export const COMMAND_SCHEMAS = {
  "codeIngest.generateDigest": {
    type: "object",
    properties: {
      selectedFiles: {
        type: "array",
        required: true,
        items: { type: "string", minLength: 1 },
        maxLength: 5000
      },
      outputFormat: {
        type: "enum",
        enum: ["markdown", "json", "text"],
        default: "markdown"
      },
      redactionOverride: {
        type: "boolean",
        default: false
      }
    }
  },
  "codeIngest.updateSelection": {
    type: "object",
    properties: {
      filePath: { type: "string", required: true, minLength: 1, maxLength: 4096 },
      selected: { type: "boolean", required: true }
    }
  },
  "codeIngest.loadRemoteRepo": {
    type: "object",
    properties: {
      repoUrl: { type: "string", required: true, minLength: 1, maxLength: 2048 },
      ref: { type: "string", maxLength: 128 },
      sparsePaths: {
        type: "array",
        items: { type: "string", minLength: 1, maxLength: 4096 },
        maxLength: 200
      }
    }
  }
};

const validatorCache = new Map();

export function validateCommandPayload(commandId, payload) {
  const schema = COMMAND_SCHEMAS[commandId];
  if (!schema) {
    return { ok: true, value: payload };
  }

  if (!validatorCache.has(commandId)) {
    validatorCache.set(commandId, createValidator(schema));
  }

  const validator = validatorCache.get(commandId);
  return validator(payload);
}
