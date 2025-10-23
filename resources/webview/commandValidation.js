/*
 * Follow instructions in copilot-instructions.md exactly.
 */

import { COMMAND_MAP } from "./commandMap.js";
import { COMMAND_SCHEMA_DEFINITIONS } from "./commandSchemas.js";
import { createValidator } from "./handlers/base/validation.js";

function deriveSchemaKey(commandId) {
  if (typeof commandId !== "string") {
    return undefined;
  }
  return commandId.startsWith("codeIngest.") ? commandId.slice("codeIngest.".length) : commandId;
}

function buildSchemaMap(definitions, commandMap) {
  const entries = Object.values(commandMap.WEBVIEW_TO_HOST ?? {})
    .map((commandId) => {
      const key = deriveSchemaKey(commandId);
      const schema = key ? definitions[key] : undefined;
      return schema ? [commandId, schema] : null;
    })
    .filter(Boolean);
  return Object.freeze(Object.fromEntries(entries));
}

export const COMMAND_SCHEMAS = buildSchemaMap(COMMAND_SCHEMA_DEFINITIONS, COMMAND_MAP);

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
