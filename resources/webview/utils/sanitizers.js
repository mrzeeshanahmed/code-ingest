/*
 * Follow instructions in copilot-instructions.md exactly.
 */

const STRIP_TAGS_REGEXP = /<\/?(script|iframe|object|embed|link|style)[^>]*>/gi;
const CONTROL_CHARS_REGEXP = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

/**
 * Sanitise untrusted text content before rendering. This is intentionally conservative:
 * it removes high-risk tags and control characters while preserving meaningful user text.
 *
 * @param {unknown} value
 * @param {{
 *   trim?: boolean;
 *   maxLength?: number;
 * }} [options]
 * @returns {string}
 */
export function sanitizeText(value, options = {}) {
  const str = typeof value === "string" ? value : value == null ? "" : String(value);
  const trim = options.trim !== false;
  const maxLength = typeof options.maxLength === "number" ? options.maxLength : 20_000;

  let cleaned = str.replace(STRIP_TAGS_REGEXP, "").replace(CONTROL_CHARS_REGEXP, "");
  if (trim) {
    cleaned = cleaned.trim();
  }
  if (cleaned.length > maxLength) {
    cleaned = `${cleaned.slice(0, maxLength)}…`;
  }
  return cleaned;
}

/**
 * Normalise numbers within given bounds.
 *
 * @param {unknown} value
 * @param {{ min?: number; max?: number; defaultValue?: number }} [options]
 * @returns {number | undefined}
 */
export function clampNumber(value, options = {}) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return options.defaultValue;
  }
  const min = typeof options.min === "number" ? options.min : Number.NEGATIVE_INFINITY;
  const max = typeof options.max === "number" ? options.max : Number.POSITIVE_INFINITY;
  return Math.min(Math.max(value, min), max);
}

/**
 * Shallow sanitisation for records where keys must be strings.
 *
 * @param {unknown} record
 * @param {(value: unknown, key: string) => unknown} [valueSanitiser]
 * @returns {Record<string, unknown>}
 */
export function sanitizeRecord(record, valueSanitiser) {
  if (!record || typeof record !== "object") {
    return {};
  }
  const entries = Object.entries(record);
  const result = {};
  for (const [key, val] of entries) {
    if (typeof key !== "string" || !key) {
      continue;
    }
    result[sanitizeText(key, { maxLength: 256 })] = valueSanitiser ? valueSanitiser(val, key) : val;
  }
  return result;
}
