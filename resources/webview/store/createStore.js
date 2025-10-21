/*
 * Follow instructions in copilot-instructions.md exactly.
 */

import { createStore as createSimpleStore } from "../vendor/simpleStore.js";

import { createInitialState, deserializeState, dehydrateSets, serializeState } from "./state.js";
import { createActions } from "./actions.js";
import { createMiddlewarePipeline } from "./middleware.js";
import { registerStateSync } from "./sync.js";

const PERSIST_KEY = "code-ingest-webview";

const coerceTokenCount = (value) => {
  if (value === null) {
    return null;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return null;
    }
    return { total: Math.max(0, value) };
  }
  if (!value || typeof value !== "object") {
    return null;
  }
  const normalized = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === "number" && Number.isFinite(raw)) {
      normalized[key] = key === "total" || key === "approx" ? Math.max(0, raw) : raw;
      continue;
    }
    if (typeof raw === "boolean" || typeof raw === "string") {
      normalized[key] = raw;
    }
  }
  return Object.keys(normalized).length > 0 ? normalized : null;
};

const createStorage = (storageImpl) => {
  const storage = storageImpl ?? (typeof window !== "undefined" ? window.localStorage : undefined);

  return {
    getItem: (name) => {
      if (!storage) {
        return null;
      }
      return storage.getItem(name);
    },
    setItem: (name, value) => {
      if (!storage) {
        return;
      }
      const payload = typeof value === "string" ? value : JSON.stringify(value);
      storage.setItem(name, payload);
    },
    removeItem: (name) => {
      if (!storage) {
        return;
      }
      storage.removeItem(name);
    }
  };
};

const persistPartialize = (state) => ({
  ui: state.ui,
  fileTree: dehydrateSets(state.fileTree),
  generation: state.generation,
  config: state.config,
  notifications: state.notifications,
  remoteRepo: state.remoteRepo
});

const withLegacyMirrors = (state) => ({
  ...state,
  selection: Array.from(state.fileTree?.selectedFiles ?? []),
  tree: state.fileTree?.nodes ?? [],
  preview: state.generation?.preview ?? state.preview,
  progress: state.generation?.progress ?? state.progress,
  lastGeneration: state.generation?.lastResult ?? state.lastGeneration,
  errors: state.notifications?.errors ?? state.errors ?? [],
  warnings: state.notifications?.warnings ?? state.warnings ?? [],
  infoMessages: state.notifications?.info ?? state.infoMessages ?? [],
  status: state.diagnostics?.status ?? state.status ?? "idle",
  viewState: state.diagnostics?.viewState ?? state.viewState ?? {},
  presets: state.presets ?? [],
  activePreset: state.activePreset ?? state.config?.preset ?? "default"
});

const fromLegacyState = (state) => {
  if (!state) {
    return {};
  }

  const next = {};

  if (Array.isArray(state.tree)) {
    next.fileTree = {
      nodes: state.tree,
      selectedFiles: new Set(state.selection ?? []),
      expandedPaths: new Set(),
      loadingPaths: new Set(),
      previewFiles: new Set(),
      scanningInProgress: false
    };
  }

  if (state.preview) {
    next.generation = {
      ...next.generation,
      preview: {
        content: state.preview.content ?? "",
        tokenCount: coerceTokenCount(state.preview.tokenCount),
        truncated: Boolean(state.preview.truncated),
        metadata: state.preview.metadata ?? {},
        title: state.preview.title,
        subtitle: state.preview.subtitle
      }
    };
  }

  if (state.progress) {
    next.generation = {
      ...next.generation,
      progress: {
        phase: state.progress.phase ?? "",
        percent: state.progress.percent ?? 0,
        message: state.progress.message ?? "",
        filesProcessed: state.progress.filesProcessed ?? 0,
        totalFiles: state.progress.totalFiles ?? 0
      }
    };
  }

  if (state.lastGeneration) {
    next.generation = {
      ...next.generation,
      lastResult: state.lastGeneration
    };
  }

  if (state.config) {
    next.config = state.config;
  }

  if (Array.isArray(state.errors) || Array.isArray(state.warnings) || Array.isArray(state.infoMessages)) {
    next.notifications = {
      errors: state.errors ?? [],
      warnings: state.warnings ?? [],
      info: state.infoMessages ?? []
    };
  }

  if (state.status) {
    next.status = state.status;
    next.diagnostics = { status: state.status, viewState: state.viewState ?? {} };
  }

  return next;
};

const loadPersistedState = (storageAdapter) => {
  try {
    const raw = storageAdapter.getItem(PERSIST_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw);
    const snapshot = parsed?.state ?? parsed;
    if (!snapshot) {
      return null;
    }
    return deserializeState(snapshot);
  } catch (error) {
    console.warn("store.persist.load.failed", error);
    return null;
  }
};

const writePersistedState = (storageAdapter, state) => {
  try {
    const payload = {
      state: serializeState(persistPartialize(state)),
      version: 1
    };
    storageAdapter.setItem(PERSIST_KEY, JSON.stringify(payload));
  } catch (error) {
    console.warn("store.persist.save.failed", error);
  }
};

export const createWebviewStore = ({
  initialState,
  logger,
  storage,
  enableSync = true
} = {}) => {
  const initial = initialState ? deserializeState(initialState) : {};
  const baseState = withLegacyMirrors({
    ...createInitialState(),
    ...initial,
    ...fromLegacyState(initialState)
  });

  const initializer = (set, get, api) => {
    const actions = createActions(set, get, api);
    const nextState = withLegacyMirrors({
      ...baseState,
      actions
    });

    return nextState;
  };

  const storageAdapter = createStorage(storage);
  const pipeline = createMiddlewarePipeline(initializer, logger);
  const store = createSimpleStore(pipeline);

  const persistedSnapshot = loadPersistedState(storageAdapter);
  if (persistedSnapshot) {
    store.setState(
      withLegacyMirrors({
        ...store.getState(),
        ...persistedSnapshot
      }),
      true,
      "persist.rehydrate"
    );
  }

  store.subscribe((nextState) => {
    writePersistedState(storageAdapter, nextState);
  });

  if (enableSync) {
    registerStateSync(store);
  }

  const getActions = () => store.getState().actions;

  return {
    ...store,
    getActions,
    loadPersistedState,
    writePersistedState
  };
};
