import { createWebviewStore } from "./store/createStore.js";
import { selectors } from "./store/selectors.js";

const isPlainObject = (value) => Object.prototype.toString.call(value) === "[object Object]";

const deepClone = (value) => {
  if (Array.isArray(value)) {
    return value.map((item) => deepClone(item));
  }
  if (value instanceof Set) {
    return new Set(Array.from(value, (item) => deepClone(item)));
  }
  if (isPlainObject(value)) {
    const clone = {};
    for (const [key, nested] of Object.entries(value)) {
      clone[key] = deepClone(nested);
    }
    return clone;
  }
  return value;
};

const cloneSet = (value) => {
  if (value instanceof Set) {
    return new Set(value);
  }
  if (Array.isArray(value)) {
    return new Set(value);
  }
  if (value && typeof value[Symbol.iterator] === "function") {
    return new Set(value);
  }
  if (value === undefined || value === null) {
    return new Set();
  }
  return new Set([value]);
};

const toArray = (value) => {
  if (Array.isArray(value)) {
    return [...value];
  }
  if (value === undefined || value === null) {
    return [];
  }
  return [value];
};

const createDefaultFileTree = () => ({
  nodes: [],
  selectedFiles: new Set(),
  expandedPaths: new Set(),
  loadingPaths: new Set(),
  previewFiles: new Set(),
  scanningInProgress: false
});

const createDefaultGeneration = () => ({
  inProgress: false,
  preview: {
    title: "",
    subtitle: "",
    content: "",
    tokenCount: 0,
    truncated: false,
    metadata: {}
  },
  progress: {
    id: undefined,
    phase: "",
    percent: 0,
    message: "",
    filesProcessed: 0,
    totalFiles: 0,
    cancellable: false,
    cancelled: false,
    overlayMessage: undefined
  },
  lastResult: null,
  redactionOverride: false,
  outputFormat: "markdown"
});

const createDefaultNotifications = () => ({
  errors: [],
  warnings: [],
  info: []
});

const createDefaultDiagnostics = () => ({
  status: "idle",
  viewState: {}
});

const reduceLegacyPatch = (state, patch) => {
  if (!patch || !isPlainObject(patch)) {
    return state;
  }

  const remaining = { ...patch };
  const next = { ...state };
  let mutated = false;

  const ensureFileTree = () => {
    if (next.fileTree === state.fileTree) {
      const base = state.fileTree ?? createDefaultFileTree();
      next.fileTree = {
        ...base,
        nodes: Array.isArray(base.nodes) ? base.nodes.map((node) => deepClone(node)) : [],
        selectedFiles: cloneSet(base.selectedFiles),
        expandedPaths: cloneSet(base.expandedPaths),
        loadingPaths: cloneSet(base.loadingPaths),
        previewFiles: cloneSet(base.previewFiles)
      };
    }
    return next.fileTree;
  };

  const ensureGeneration = () => {
    if (next.generation === state.generation) {
      const base = state.generation ?? createDefaultGeneration();
      next.generation = {
        ...base,
        preview: { ...(base.preview ?? {}) },
        progress: { ...(base.progress ?? {}) }
      };
    }
    return next.generation;
  };

  const ensureNotifications = () => {
    if (next.notifications === state.notifications) {
      const base = state.notifications ?? createDefaultNotifications();
      next.notifications = {
        ...base,
        errors: Array.isArray(base.errors) ? [...base.errors] : [],
        warnings: Array.isArray(base.warnings) ? [...base.warnings] : [],
        info: Array.isArray(base.info) ? [...base.info] : []
      };
    }
    return next.notifications;
  };

  const ensureDiagnostics = () => {
    if (next.diagnostics === state.diagnostics) {
      const base = state.diagnostics ?? createDefaultDiagnostics();
      next.diagnostics = {
        ...base,
        viewState: isPlainObject(base.viewState) ? { ...base.viewState } : {}
      };
    }
    return next.diagnostics;
  };

  const ensureConfig = () => {
    if (next.config === state.config) {
      next.config = { ...(state.config ?? {}) };
    }
    return next.config;
  };

  const ensureRemoteRepo = () => {
    if (next.remoteRepo === state.remoteRepo) {
      next.remoteRepo = { ...(state.remoteRepo ?? {}) };
    }
    return next.remoteRepo;
  };

  if (Object.prototype.hasOwnProperty.call(remaining, "tree")) {
    const nodes = Array.isArray(remaining.tree) ? remaining.tree.map((node) => deepClone(node)) : [];
    ensureFileTree().nodes = nodes;
    next.tree = nodes;
    delete remaining.tree;
    mutated = true;
  }

  if (Object.prototype.hasOwnProperty.call(remaining, "selection")) {
    const selection = toArray(remaining.selection);
    ensureFileTree().selectedFiles = cloneSet(selection);
    next.selection = selection;
    delete remaining.selection;
    mutated = true;
  }

  if (Object.prototype.hasOwnProperty.call(remaining, "fileTree")) {
    const incoming = remaining.fileTree ?? {};
    const fileTree = ensureFileTree();
    if (Array.isArray(incoming.nodes)) {
      fileTree.nodes = incoming.nodes.map((node) => deepClone(node));
      next.tree = fileTree.nodes;
    }
    if (incoming.selectedFiles !== undefined) {
      fileTree.selectedFiles = cloneSet(incoming.selectedFiles);
      next.selection = Array.from(fileTree.selectedFiles);
    }
    if (incoming.expandedPaths !== undefined) {
      fileTree.expandedPaths = cloneSet(incoming.expandedPaths);
    }
    if (incoming.loadingPaths !== undefined) {
      fileTree.loadingPaths = cloneSet(incoming.loadingPaths);
    }
    if (incoming.previewFiles !== undefined) {
      fileTree.previewFiles = cloneSet(incoming.previewFiles);
    }
    if (typeof incoming.scanningInProgress === "boolean") {
      fileTree.scanningInProgress = incoming.scanningInProgress;
    }
    delete remaining.fileTree;
    mutated = true;
  }

  if (Object.prototype.hasOwnProperty.call(remaining, "preview")) {
    const previewPatch = isPlainObject(remaining.preview) ? remaining.preview : {};
    const generation = ensureGeneration();
    generation.preview = { ...generation.preview, ...deepClone(previewPatch) };
    next.preview = generation.preview;
    delete remaining.preview;
    mutated = true;
  }

  if (Object.prototype.hasOwnProperty.call(remaining, "progress")) {
    const progressPatch = isPlainObject(remaining.progress) ? remaining.progress : {};
    const generation = ensureGeneration();
    generation.progress = { ...generation.progress, ...deepClone(progressPatch) };
    next.progress = generation.progress;
    delete remaining.progress;
    mutated = true;
  }

  if (Object.prototype.hasOwnProperty.call(remaining, "generation")) {
    const incoming = isPlainObject(remaining.generation) ? remaining.generation : {};
    const generation = ensureGeneration();
    Object.assign(generation, deepClone(incoming));
    if (incoming.preview) {
      generation.preview = { ...generation.preview, ...deepClone(incoming.preview) };
      next.preview = generation.preview;
    }
    if (incoming.progress) {
      generation.progress = { ...generation.progress, ...deepClone(incoming.progress) };
      next.progress = generation.progress;
    }
    if (incoming.lastResult !== undefined) {
      next.lastGeneration = generation.lastResult;
    }
    if (incoming.redactionOverride !== undefined) {
      const value = Boolean(incoming.redactionOverride);
      generation.redactionOverride = value;
      ensureConfig().redactionOverride = value;
      next.redactionOverride = value;
    }
    delete remaining.generation;
    mutated = true;
  }

  if (Object.prototype.hasOwnProperty.call(remaining, "config")) {
    const configPatch = isPlainObject(remaining.config) ? remaining.config : {};
    const config = ensureConfig();
    Object.assign(config, deepClone(configPatch));
    next.config = config;
    if (config.preset !== undefined) {
      next.activePreset = config.preset;
    }
    if (config.redactionOverride !== undefined) {
      ensureGeneration().redactionOverride = Boolean(config.redactionOverride);
    }
    delete remaining.config;
    mutated = true;
  }

  if (Object.prototype.hasOwnProperty.call(remaining, "activePreset")) {
    ensureConfig().preset = remaining.activePreset;
    next.activePreset = remaining.activePreset;
    delete remaining.activePreset;
    mutated = true;
  }

  if (Object.prototype.hasOwnProperty.call(remaining, "presets")) {
    next.presets = Array.isArray(remaining.presets) ? remaining.presets.map((preset) => deepClone(preset)) : [];
    delete remaining.presets;
    mutated = true;
  }

  if (Object.prototype.hasOwnProperty.call(remaining, "errors")) {
    const notifications = ensureNotifications();
    notifications.errors = Array.isArray(remaining.errors) ? remaining.errors.map((err) => deepClone(err)) : [];
    next.errors = notifications.errors;
    delete remaining.errors;
    mutated = true;
  }

  if (Object.prototype.hasOwnProperty.call(remaining, "warnings")) {
    const notifications = ensureNotifications();
    notifications.warnings = Array.isArray(remaining.warnings) ? remaining.warnings.map((warning) => deepClone(warning)) : [];
    next.warnings = notifications.warnings;
    delete remaining.warnings;
    mutated = true;
  }

  if (Object.prototype.hasOwnProperty.call(remaining, "infoMessages")) {
    const notifications = ensureNotifications();
    notifications.info = Array.isArray(remaining.infoMessages)
      ? remaining.infoMessages.map((info) => deepClone(info))
      : [];
    next.infoMessages = notifications.info;
    delete remaining.infoMessages;
    mutated = true;
  }

  if (Object.prototype.hasOwnProperty.call(remaining, "notifications")) {
    const notifications = ensureNotifications();
    const incoming = isPlainObject(remaining.notifications) ? remaining.notifications : {};
    if (incoming.errors !== undefined) {
      notifications.errors = Array.isArray(incoming.errors) ? incoming.errors.map((err) => deepClone(err)) : [];
    }
    if (incoming.warnings !== undefined) {
      notifications.warnings = Array.isArray(incoming.warnings)
        ? incoming.warnings.map((warning) => deepClone(warning))
        : [];
    }
    if (incoming.info !== undefined) {
      notifications.info = Array.isArray(incoming.info) ? incoming.info.map((info) => deepClone(info)) : [];
    }
    next.errors = notifications.errors;
    next.warnings = notifications.warnings;
    next.infoMessages = notifications.info;
    delete remaining.notifications;
    mutated = true;
  }

  if (Object.prototype.hasOwnProperty.call(remaining, "status")) {
    ensureDiagnostics().status = remaining.status;
    next.status = remaining.status;
    delete remaining.status;
    mutated = true;
  }

  if (Object.prototype.hasOwnProperty.call(remaining, "viewState")) {
    const diagnostics = ensureDiagnostics();
    const viewStatePatch = isPlainObject(remaining.viewState) ? remaining.viewState : {};
    diagnostics.viewState = { ...diagnostics.viewState, ...deepClone(viewStatePatch) };
    next.viewState = diagnostics.viewState;
    delete remaining.viewState;
    mutated = true;
  }

  if (Object.prototype.hasOwnProperty.call(remaining, "diagnostics")) {
    const diagnostics = ensureDiagnostics();
    const incoming = isPlainObject(remaining.diagnostics) ? remaining.diagnostics : {};
    Object.assign(diagnostics, deepClone(incoming));
    if (incoming.status !== undefined) {
      next.status = diagnostics.status;
    }
    if (incoming.viewState !== undefined) {
      diagnostics.viewState = isPlainObject(incoming.viewState)
        ? { ...diagnostics.viewState, ...deepClone(incoming.viewState) }
        : diagnostics.viewState;
      next.viewState = diagnostics.viewState;
    }
    delete remaining.diagnostics;
    mutated = true;
  }

  if (Object.prototype.hasOwnProperty.call(remaining, "redactionOverride")) {
    const value = Boolean(remaining.redactionOverride);
    ensureConfig().redactionOverride = value;
    ensureGeneration().redactionOverride = value;
    next.redactionOverride = value;
    delete remaining.redactionOverride;
    mutated = true;
  }

  if (Object.prototype.hasOwnProperty.call(remaining, "remoteRepo")) {
    const repo = ensureRemoteRepo();
    Object.assign(repo, deepClone(remaining.remoteRepo ?? {}));
    next.remoteRepo = repo;
    delete remaining.remoteRepo;
    mutated = true;
  }

  for (const [key, value] of Object.entries(remaining)) {
    if (value === undefined) {
      if (Object.prototype.hasOwnProperty.call(next, key) && next[key] !== undefined) {
        next[key] = undefined;
        mutated = true;
      }
      continue;
    }

    if (!Object.is(next[key], value)) {
      next[key] = deepClone(value);
      mutated = true;
    }
  }

  return mutated ? next : state;
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

  let ready = false;
  const pendingUpdates = [];

  const flushPendingUpdates = () => {
    if (pendingUpdates.length === 0) {
      return;
    }

    const updates = pendingUpdates.splice(0);
    for (const update of updates) {
      store.setState(update.producer, false, update.action);
    }
  };

  const enqueueUpdate = (producer, action = "legacy.patch") => {
    if (ready) {
      store.setState(producer, false, action);
      return;
    }

    pendingUpdates.push({ producer, action });
  };

  const wrappedSetState = (updater, _replace, action) => {
    const producer = (state) => {
      const patch = typeof updater === "function" ? updater(state) : updater;
      if (!patch || (!isPlainObject(patch) && typeof patch !== "object")) {
        return state;
      }
      return reduceLegacyPatch(state, deepClone(patch));
    };

    enqueueUpdate(producer, action ?? "legacy.patch");
  };

  const markReady = () => {
    if (ready) {
      return;
    }
    ready = true;
    flushPendingUpdates();
  };

  return {
    getState: store.getState,
    setState: wrappedSetState,
    subscribe: store.subscribe,
    getActions: store.getActions,
    selectors,
    markReady
  };
};

export { selectors } from "./store/selectors.js";
