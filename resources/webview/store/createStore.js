/*
 * Follow instructions in copilot-instructions.md exactly.
 */

import { createStore as createZustandStore } from "zustand/vanilla";
import { devtools, persist, subscribeWithSelector } from "zustand/middleware";

import { createInitialState, deserializeState, dehydrateSets } from "./state.js";
import { createActions } from "./actions.js";
import { createMiddlewarePipeline } from "./middleware.js";
import { registerStateSync } from "./sync.js";

const PERSIST_KEY = "code-ingest-webview";

const isDevtoolsAvailable = () => typeof window !== "undefined" && !!window.__REDUX_DEVTOOLS_EXTENSION__;

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
        tokenCount: state.preview.tokenCount ?? 0,
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

  const enhanceWithPersist = persist(initializer, {
    name: PERSIST_KEY,
    version: 1,
    storage: createStorage(storage),
    partialize: persistPartialize,
    merge: (persistedState, currentState) => {
      if (!persistedState) {
        return currentState;
      }
      const merged = withLegacyMirrors({
        ...currentState,
        ...deserializeState(persistedState)
      });
      return merged;
    }
  });

  const devtoolsWrap = (stateCreator) =>
    isDevtoolsAvailable()
      ? devtools(stateCreator, { name: "code-ingest-webview" })
      : stateCreator;

  const pipeline = subscribeWithSelector(
    createMiddlewarePipeline(devtoolsWrap(enhanceWithPersist), logger)
  );

  const store = createZustandStore(pipeline);

  if (enableSync) {
    registerStateSync(store);
  }

  const getActions = () => store.getState().actions;

  return {
    ...store,
    getActions
  };
};
