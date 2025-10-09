/*
 * Follow instructions in copilot-instructions.md exactly.
 */

import { deserializeState, serializeState } from "./state.js";

const DEFAULT_LOGGER = (event, payload) => {
  try {
    const ts = new Date().toISOString();
    console.debug(`[store:${event}]`, ts, payload);
  } catch (error) {
    console.warn("store.logger.error", error);
  }
};

const ensureSet = (value, label) => {
  if (value == null) {
    return new Set();
  }
  if (value instanceof Set) {
    return value;
  }
  if (Array.isArray(value)) {
    return new Set(value);
  }
  DEFAULT_LOGGER("state.validation.coerce", { label, reason: "expected Set" });
  return new Set([value]);
};

const validateStateShape = (state) => {
  if (!state) {
    return state;
  }

  const clone = { ...state };
  const fileTree = { ...clone.fileTree };
  fileTree.selectedFiles = ensureSet(fileTree.selectedFiles, "fileTree.selectedFiles");
  fileTree.expandedPaths = ensureSet(fileTree.expandedPaths, "fileTree.expandedPaths");
  fileTree.loadingPaths = ensureSet(fileTree.loadingPaths, "fileTree.loadingPaths");
  fileTree.previewFiles = ensureSet(fileTree.previewFiles, "fileTree.previewFiles");
  clone.fileTree = fileTree;
  return clone;
};

export const withLogging = (config, logger = DEFAULT_LOGGER) => (set, get, api) =>
  config((partial, replace, action) => {
    if (action) {
      logger("action", { action, state: serializeState(get()) });
    }
    set(partial, replace, action);
    if (action) {
      logger("state", { action, state: serializeState(get()) });
    }
  }, get, api);

export const withValidation = (config) => (set, get, api) =>
  config((partial, replace, action) => {
    const apply = (next) => {
      const validated = validateStateShape(next);
      set(validated, replace, action);
    };

    if (typeof partial === "function") {
      return apply(partial(validateStateShape(get())));
    }

    return apply(partial);
  }, get, api);

export const withSerialization = (config) => (set, get, api) =>
  config(
    (partial, replace, action) =>
      set(partial, replace, action),
    () => deserializeState(get()),
    api
  );

export const createMiddlewarePipeline = (initializer, logger) =>
  withLogging(withValidation(initializer), logger);
