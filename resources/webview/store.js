import { createWebviewStore } from "./store/createStore.js";
import { selectors } from "./store/selectors.js";

const applyLegacyPatch = (store, patch) => {
  if (!patch) {
    return;
  }

  const actions = store.getActions();
  const remaining = { ...patch };

  if (Object.prototype.hasOwnProperty.call(remaining, "tree")) {
    actions.fileTree.setNodes(remaining.tree);
    delete remaining.tree;
  }

  if (Object.prototype.hasOwnProperty.call(remaining, "selection")) {
    actions.fileTree.setSelection(remaining.selection ?? []);
    delete remaining.selection;
  }

  if (Object.prototype.hasOwnProperty.call(remaining, "preview")) {
    actions.generation.setPreview(remaining.preview ?? {});
    delete remaining.preview;
  }

  if (Object.prototype.hasOwnProperty.call(remaining, "progress")) {
    actions.generation.updateProgress(remaining.progress ?? {});
    delete remaining.progress;
  }

  if (Object.prototype.hasOwnProperty.call(remaining, "config")) {
    actions.config.update(remaining.config ?? {});
    delete remaining.config;
  }

  if (Object.prototype.hasOwnProperty.call(remaining, "activePreset")) {
    actions.config.update({ preset: remaining.activePreset });
    delete remaining.activePreset;
  }

  if (Object.prototype.hasOwnProperty.call(remaining, "presets")) {
    store.setState({ presets: remaining.presets ?? [] }, false, "legacy.presets");
    delete remaining.presets;
  }

  if (Object.prototype.hasOwnProperty.call(remaining, "errors")) {
    actions.notifications.set({ errors: remaining.errors ?? [] });
    delete remaining.errors;
  }

  if (Object.prototype.hasOwnProperty.call(remaining, "warnings")) {
    actions.notifications.set({ warnings: remaining.warnings ?? [] });
    delete remaining.warnings;
  }

  if (Object.prototype.hasOwnProperty.call(remaining, "infoMessages")) {
    actions.notifications.set({ info: remaining.infoMessages ?? [] });
    delete remaining.infoMessages;
  }

  if (Object.prototype.hasOwnProperty.call(remaining, "status")) {
    actions.diagnostics.setStatus(remaining.status);
    delete remaining.status;
  }

  if (Object.prototype.hasOwnProperty.call(remaining, "viewState")) {
    actions.diagnostics.setViewState(remaining.viewState ?? {});
    delete remaining.viewState;
  }

  if (Object.keys(remaining).length > 0) {
    store.setState(remaining, false, "legacy.patch");
  }
};

export const createStore = (initialState = {}) => {
  const isTestEnvironment = globalThis.__CODE_INGEST_TEST__ === true;
  const store = createWebviewStore({
    initialState,
    enableSync: !isTestEnvironment,
    logger: isTestEnvironment ? () => {} : undefined,
    storage: isTestEnvironment
      ? {
          getItem: () => null,
          setItem: () => {},
          removeItem: () => {}
        }
      : undefined
  });

  const wrappedSetState = (updater) => {
    if (typeof updater === "function") {
      const current = store.getState();
      const patch = updater(current);
      applyLegacyPatch(store, patch);
      return;
    }
    applyLegacyPatch(store, updater);
  };


  return {
    getState: store.getState,
    setState: wrappedSetState,
    subscribe: store.subscribe,
    getActions: store.getActions,
    selectors
  };
};

export { selectors } from "./store/selectors.js";
