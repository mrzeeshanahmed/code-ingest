/*
 * Follow instructions in copilot-instructions.md exactly.
 */

const createPreviewState = () => ({
  title: "",
  subtitle: "",
  content: "",
  tokenCount: null,
  truncated: false,
  metadata: {}
});

const createProgressState = () => ({
  id: undefined,
  phase: "",
  percent: 0,
  message: "",
  filesProcessed: 0,
  totalFiles: 0,
  cancellable: false,
  cancelled: false,
  overlayMessage: undefined
});

const createGenerationState = () => ({
  inProgress: false,
  preview: createPreviewState(),
  progress: createProgressState(),
  lastResult: null,
  redactionOverride: false,
  outputFormat: "markdown"
});

const createFileTreeState = () => ({
  nodes: [],
  selectedFiles: new Set(),
  expandedPaths: new Set(),
  loadingPaths: new Set(),
  previewFiles: new Set(),
  scanningInProgress: false
});

const createUiState = () => ({
  sidebarExpanded: true,
  previewPanelVisible: false,
  currentTab: "overview",
  theme: "system",
  progressVisible: false
});

const createConfigState = () => ({
  redactionPatterns: [],
  showRedacted: false,
  maxFiles: 5000,
  preset: "default"
});

const createNotificationState = () => ({
  errors: [],
  warnings: [],
  info: []
});

const createRemoteRepoState = () => ({
  loaded: false,
  url: "",
  ref: "main",
  sha: undefined,
  metadata: null,
  loadingInProgress: false
});

const createDiagnosticsState = () => ({
  status: "idle",
  viewState: {}
});

export const createInitialState = () => {
  const generation = createGenerationState();
  const fileTree = createFileTreeState();
  const notifications = createNotificationState();

  return {
    ui: createUiState(),
    fileTree,
    generation,
    config: createConfigState(),
    notifications,
    remoteRepo: createRemoteRepoState(),
    diagnostics: createDiagnosticsState(),
    presets: [],
    activePreset: "default",

    // Legacy top-level mirrors required by existing handlers/tests.
    selection: [],
    tree: [],
    preview: generation.preview,
    progress: generation.progress,
    lastGeneration: generation.lastResult,
    errors: notifications.errors,
    warnings: notifications.warnings,
    infoMessages: notifications.info,
    status: "idle",
    viewState: {}
  };
};

export const rehydrateSets = (slice) => {
  if (!slice) {
    return slice;
  }

  const clone = { ...slice };
  if (Array.isArray(clone.selectedFiles)) {
    clone.selectedFiles = new Set(clone.selectedFiles);
  }
  if (Array.isArray(clone.expandedPaths)) {
    clone.expandedPaths = new Set(clone.expandedPaths);
  }
  if (Array.isArray(clone.loadingPaths)) {
    clone.loadingPaths = new Set(clone.loadingPaths);
  }
  if (Array.isArray(clone.previewFiles)) {
    clone.previewFiles = new Set(clone.previewFiles);
  }

  return clone;
};

export const dehydrateSets = (slice) => {
  if (!slice) {
    return slice;
  }

  const clone = { ...slice };
  if (clone.selectedFiles instanceof Set) {
    clone.selectedFiles = Array.from(clone.selectedFiles);
  }
  if (clone.expandedPaths instanceof Set) {
    clone.expandedPaths = Array.from(clone.expandedPaths);
  }
  if (clone.loadingPaths instanceof Set) {
    clone.loadingPaths = Array.from(clone.loadingPaths);
  }
  if (clone.previewFiles instanceof Set) {
    clone.previewFiles = Array.from(clone.previewFiles);
  }

  return clone;
};

export const serializeState = (state) => {
  if (!state) {
    return state;
  }

  return {
    ...state,
    fileTree: dehydrateSets(state.fileTree),
    selection: Array.isArray(state.selection)
      ? [...state.selection]
      : Array.from(state.fileTree?.selectedFiles ?? []),
    tree: Array.isArray(state.tree) ? [...state.tree] : [...(state.fileTree?.nodes ?? [])]
  };
};

export const deserializeState = (state) => {
  if (!state) {
    return state;
  }

  const next = { ...state };
  if (state.fileTree !== undefined) {
    next.fileTree = rehydrateSets(state.fileTree);
  }
  return next;
};