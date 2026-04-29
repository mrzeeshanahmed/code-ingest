/*
 * Follow instructions in copilot-instructions.md exactly.
 */

import { clampNumber, sanitizeRecord, sanitizeText } from "../../utils/sanitizers.js";

/**
 * @typedef {Object} SchemaProperty
 * @property {"string"|"number"|"boolean"|"object"|"array"|"enum"|"unknown"} type
 * @property {boolean} [required]
 * @property {number} [minLength]
 * @property {number} [maxLength]
 * @property {number} [min]
 * @property {number} [max]
 * @property {Array<unknown>} [enum]
 * @property {Schema} [items]
 * @property {Record<string, SchemaProperty>} [properties]
 * @property {boolean} [allowUnknown]
 * @property {number} [maxLength]
 * @property {unknown} [default]
 * @property {(value: unknown) => unknown} [transform]
 */

/**
 * @typedef {Object} Schema
 * @property {"object"|"array"} type
 * @property {Record<string, SchemaProperty>} [properties]
 * @property {SchemaProperty} [items]
 * @property {boolean} [required]
 * @property {boolean} [allowUnknown]
 * @property {number} [maxLength]
 */

/**
 * @typedef {{
 *   ok: true;
 *   value: any;
 * }} ValidationSuccess
 *
 * @typedef {{
 *   ok: false;
 *   reason: string;
 *   errors: string[];
 * }} ValidationFailure
 *
 * @typedef {ValidationSuccess | ValidationFailure} ValidationResult
 */

/**
 * Build a validation function for the provided schema. Consumers should ensure that
 * the schema is shallow to keep runtime costs minimal.
 *
 * @param {Schema} schema
 * @returns {(payload: unknown) => ValidationResult}
 */
export function createValidator(schema) {
  if (!schema || typeof schema !== "object") {
    throw new TypeError("Validator schema must be an object");
  }

  return function validate(payload) {
    const errors = [];
    const value = validateSchema(payload, schema, "payload", errors);

    if (errors.length > 0) {
      return { ok: false, reason: errors[0], errors };
    }

    return { ok: true, value };
  };
}

/**
 * @param {unknown} value
 * @param {Schema | SchemaProperty} schema
 * @param {string} path
 * @param {string[]} errors
 * @returns {any}
 */
function validateSchema(value, schema, path, errors) {
  switch (schema.type) {
    case "string":
      return validateString(value, schema, path, errors);
    case "number":
      return validateNumber(value, schema, path, errors);
    case "boolean":
      return validateBoolean(value, schema, path, errors);
    case "enum":
      return validateEnum(value, schema, path, errors);
    case "array":
      return validateArray(value, schema, path, errors);
    case "object":
      return validateObject(value, schema, path, errors);
    case "unknown":
      return value;
    default:
      errors.push(`${path}: unsupported schema type "${schema.type}"`);
      return undefined;
  }
}

function validateString(value, schema, path, errors) {
  if (typeof value !== "string") {
    if (value == null && schema.required !== true) {
      return schema.default ?? undefined;
    }
    errors.push(`${path}: expected string`);
    return undefined;
  }
  let sanitized = sanitizeText(value, {
    trim: true,
    maxLength: schema.maxLength ?? 20_000
  });
  if (typeof schema.minLength === "number" && sanitized.length < schema.minLength) {
    errors.push(`${path}: expected at least ${schema.minLength} characters`);
  }
  return schema.transform ? schema.transform(sanitized) : sanitized;
}

function validateNumber(value, schema, path, errors) {
  const maybeNumber = typeof value === "number" ? value : Number(value);
  if (Number.isNaN(maybeNumber)) {
    if (schema.required) {
      errors.push(`${path}: expected number`);
    }
    return schema.default;
  }
  const clamped = clampNumber(maybeNumber, { min: schema.min, max: schema.max, defaultValue: schema.default });
  if (typeof schema.min === "number" && clamped < schema.min) {
    errors.push(`${path}: value below minimum ${schema.min}`);
  }
  if (typeof schema.max === "number" && clamped > schema.max) {
    errors.push(`${path}: value above maximum ${schema.max}`);
  }
  return schema.transform ? schema.transform(clamped) : clamped;
}

function validateBoolean(value, schema, path, errors) {
  if (typeof value === "boolean") {
    return value;
  }
  if (value === "true" || value === "1") {
    return true;
  }
  if (value === "false" || value === "0") {
    return false;
  }
  if (schema.required) {
    errors.push(`${path}: expected boolean`);
  }
  return schema.default;
}

function validateEnum(value, schema, path, errors) {
  if (!Array.isArray(schema.enum) || schema.enum.length === 0) {
    errors.push(`${path}: invalid enum schema`);
    return undefined;
  }
  if (!schema.enum.includes(value)) {
    errors.push(`${path}: invalid enum value`);
    return schema.default ?? schema.enum[0];
  }
  return value;
}

function validateArray(value, schema, path, errors) {
  if (!Array.isArray(value)) {
    if (value == null && schema.required !== true) {
      return [];
    }
    errors.push(`${path}: expected array`);
    return [];
  }

  if (!schema.items) {
    return value.slice(0);
  }

  const limit = typeof schema.maxLength === "number" ? Math.min(schema.maxLength, value.length) : value.length;
  const result = [];
  for (let index = 0; index < limit; index += 1) {
    const itemPath = `${path}[${index}]`;
    const validated = validateSchema(value[index], schema.items, itemPath, errors);
    if (validated !== undefined) {
      result.push(validated);
    }
  }
  return result;
}

function validateObject(value, schema, path, errors) {
  if (!value || typeof value !== "object") {
    if (schema.required) {
      errors.push(`${path}: expected object`);
    }
    return {};
  }

  const entries = Object.entries(value);
  const result = {};
  const allowedKeys = schema.properties ? Object.keys(schema.properties) : [];

  for (const [key, descriptor] of Object.entries(schema.properties ?? {})) {
    const childPath = `${path}.${key}`;
    const hasKey = Object.prototype.hasOwnProperty.call(value, key);
    if (!hasKey) {
      if (descriptor.required) {
        errors.push(`${childPath}: missing required property`);
      }
      if (descriptor.default !== undefined) {
        result[key] = descriptor.default;
      }
      continue;
    }
    const validated = validateSchema(value[key], descriptor, childPath, errors);
    if (validated !== undefined) {
      result[key] = validated;
    }
  }

  if (schema.allowUnknown) {
    for (const [key, val] of entries) {
      if (!allowedKeys.includes(key)) {
        result[key] = val;
      }
    }
  }

  return sanitizeRecord(result);
}