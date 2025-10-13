/*
 * Follow instructions in copilot-instructions.md exactly.
 */

const toArray = (value) => {
  if (Array.isArray(value)) {
    return [...value];
  }
  if (value instanceof Set) {
    return Array.from(value);
  }
  if (value == null) {
    return [];
  }
  return [value];
};

const toSet = (value) => {
  if (value instanceof Set) {
    return new Set(value);
  }
  if (Array.isArray(value)) {
    return new Set(value);
  }
  if (value == null) {
    return new Set();
  }
  return new Set([value]);
};

const mergePreview = (previous, next) => ({
  title: next?.title ?? previous.title ?? "",
  subtitle: next?.subtitle ?? previous.subtitle ?? "",
  content: next?.content ?? previous.content ?? "",
  tokenCount: typeof next?.tokenCount === "number" ? next.tokenCount : previous.tokenCount ?? 0,
  truncated: Boolean(next?.truncated ?? previous.truncated),
  metadata: { ...(previous.metadata ?? {}), ...(next?.metadata ?? {}) }
});

const mergeProgress = (previous, next) => ({
  id: next?.id ?? previous.id,
  phase: next?.phase ?? previous.phase ?? "",
  percent: typeof next?.percent === "number" ? clamp(next.percent, 0, 100) : previous.percent ?? 0,
  message: next?.message ?? previous.message ?? "",
  filesProcessed: typeof next?.filesProcessed === "number" ? next.filesProcessed : previous.filesProcessed ?? 0,
  totalFiles: typeof next?.totalFiles === "number" ? next.totalFiles : previous.totalFiles ?? 0,
  cancellable: typeof next?.cancellable === "boolean" ? next.cancellable : previous.cancellable ?? false,
  cancelled: typeof next?.cancelled === "boolean" ? next.cancelled : previous.cancelled ?? false,
  overlayMessage: next?.overlayMessage ?? previous.overlayMessage
});

const clamp = (value, min, max) => {
  if (Number.isNaN(value)) {
    return min;
  }
  return Math.min(Math.max(value, min), max);
};

const mergeNotifications = (existing, patch) => ({
  errors: patch?.errors ? [...patch.errors] : existing.errors,
  warnings: patch?.warnings ? [...patch.warnings] : existing.warnings,
  info: patch?.info ? [...patch.info] : existing.info
});

export const createActions = (set, get, api) => {
  const syncLegacyState = (draft) => {
    const state = draft ?? get();
    const selectedFiles = state.fileTree.selectedFiles instanceof Set
      ? Array.from(state.fileTree.selectedFiles)
      : [];

    state.selection = selectedFiles;
    state.tree = state.fileTree.nodes;
    state.preview = state.generation.preview;
    state.progress = state.generation.progress;
    state.lastGeneration = state.generation.lastResult;
    state.errors = state.notifications.errors;
    state.warnings = state.notifications.warnings;
    state.infoMessages = state.notifications.info;
    state.activePreset = state.config?.preset ?? state.activePreset ?? "default";
    state.presets = Array.isArray(state.presets) ? [...state.presets] : state.presets ?? [];

    return state;
  };

  const updateState = (updater, action) => {
    set((current) => {
      const draft = typeof updater === "function" ? updater(current) : updater;
      return syncLegacyState({ ...current, ...draft });
    }, false, action);
  };

  return {
    ui: {
      toggleSidebar: () => updateState((state) => ({
        ui: { ...state.ui, sidebarExpanded: !state.ui.sidebarExpanded }
      }), "ui.toggleSidebar"),
      togglePreviewPanel: () => updateState((state) => ({
        ui: { ...state.ui, previewPanelVisible: !state.ui.previewPanelVisible }
      }), "ui.togglePreviewPanel"),
      setCurrentTab: (tab) => updateState((state) => ({
        ui: { ...state.ui, currentTab: tab }
      }), "ui.setCurrentTab"),
      setTheme: (theme) => updateState((state) => ({
        ui: { ...state.ui, theme }
      }), "ui.setTheme"),
      setProgressVisible: (visible) => updateState((state) => ({
        ui: { ...state.ui, progressVisible: Boolean(visible) }
      }), "ui.setProgressVisible")
    },

    fileTree: {
      setNodes: (nodes) => updateState((state) => ({
        fileTree: { ...state.fileTree, nodes: Array.isArray(nodes) ? nodes : [] }
      }), "fileTree.setNodes"),
      setExpandedPaths: (paths) => updateState((state) => ({
        fileTree: { ...state.fileTree, expandedPaths: toSet(paths) }
      }), "fileTree.setExpandedPaths"),
      toggleExpanded: (path) => updateState((state) => {
        const expandedPaths = new Set(state.fileTree.expandedPaths);
        if (expandedPaths.has(path)) {
          expandedPaths.delete(path);
        } else {
          expandedPaths.add(path);
        }
        return {
          fileTree: { ...state.fileTree, expandedPaths }
        };
      }, "fileTree.toggleExpanded"),
      setLoadingPaths: (paths) => updateState((state) => ({
        fileTree: { ...state.fileTree, loadingPaths: toSet(paths) }
      }), "fileTree.setLoadingPaths"),
      toggleSelection: (filePath) => updateState((state) => {
        const selectedFiles = new Set(state.fileTree.selectedFiles);
        if (selectedFiles.has(filePath)) {
          selectedFiles.delete(filePath);
        } else {
          selectedFiles.add(filePath);
        }
        return {
          fileTree: { ...state.fileTree, selectedFiles }
        };
      }, "fileTree.toggleSelection"),
      setSelection: (files) => updateState((state) => ({
        fileTree: { ...state.fileTree, selectedFiles: toSet(files) }
      }), "fileTree.setSelection"),
      selectAll: (files) => updateState((state) => {
        const selectedFiles = new Set(state.fileTree.selectedFiles);
        for (const file of toArray(files)) {
          selectedFiles.add(file);
        }
        return {
          fileTree: { ...state.fileTree, selectedFiles }
        };
      }, "fileTree.selectAll"),
      selectNone: () => updateState((state) => ({
        fileTree: { ...state.fileTree, selectedFiles: new Set() }
      }), "fileTree.selectNone"),
      setPreviewFiles: (files) => updateState((state) => ({
        fileTree: { ...state.fileTree, previewFiles: toSet(files) }
      }), "fileTree.setPreviewFiles"),
      setScanning: (inProgress) => updateState((state) => ({
        fileTree: { ...state.fileTree, scanningInProgress: Boolean(inProgress) }
      }), "fileTree.setScanning" )
    },

    generation: {
      startGeneration: () => updateState((state) => ({
        generation: {
          ...state.generation,
          inProgress: true,
          progress: mergeProgress(state.generation.progress, {
            phase: "scanning",
            filesProcessed: 0,
            totalFiles: 0
          })
        }
      }), "generation.startGeneration"),
      updateProgress: (progress) => updateState((state) => ({
        generation: {
          ...state.generation,
          progress: mergeProgress(state.generation.progress, progress)
        }
      }), "generation.updateProgress"),
      setPreview: (preview) => updateState((state) => ({
        generation: {
          ...state.generation,
          preview: mergePreview(state.generation.preview, preview)
        }
      }), "generation.setPreview"),
      setResult: (result) => updateState((state) => ({
        generation: {
          ...state.generation,
          lastResult: result,
          inProgress: false
        }
      }), "generation.setResult"),
      toggleRedactionOverride: () => updateState((state) => ({
        generation: {
          ...state.generation,
          redactionOverride: !state.generation.redactionOverride
        }
      }), "generation.toggleRedactionOverride"),
      setOutputFormat: (format) => updateState((state) => ({
        generation: {
          ...state.generation,
          outputFormat: format
        }
      }), "generation.setOutputFormat")
    },

    config: {
      update: (patch) => updateState((state) => ({
        config: { ...state.config, ...(patch ?? {}) },
        ...(patch && typeof patch.redactionOverride === "boolean"
          ? {
              generation: {
                ...state.generation,
                redactionOverride: patch.redactionOverride
              }
            }
          : {})
      }), "config.update"),
      setRedactionPatterns: (patterns) => updateState((state) => ({
        config: { ...state.config, redactionPatterns: Array.isArray(patterns) ? [...patterns] : [] }
      }), "config.setRedactionPatterns"),
      toggleShowRedacted: () => updateState((state) => ({
        config: { ...state.config, showRedacted: !state.config.showRedacted }
      }), "config.toggleShowRedacted")
    },

    notifications: {
      set: (patch) => updateState((state) => ({
        notifications: mergeNotifications(state.notifications, patch)
      }), "notifications.set"),
      pushError: (error) => updateState((state) => ({
        notifications: {
          ...state.notifications,
          errors: [...state.notifications.errors, error]
        }
      }), "notifications.pushError"),
      clearErrors: () => updateState((state) => ({
        notifications: { ...state.notifications, errors: [] }
      }), "notifications.clearErrors"),
      pushWarning: (warning) => updateState((state) => ({
        notifications: {
          ...state.notifications,
          warnings: [...state.notifications.warnings, warning]
        }
      }), "notifications.pushWarning"),
      clearWarnings: () => updateState((state) => ({
        notifications: { ...state.notifications, warnings: [] }
      }), "notifications.clearWarnings"),
      pushInfo: (info) => updateState((state) => ({
        notifications: {
          ...state.notifications,
          info: [...state.notifications.info, info]
        }
      }), "notifications.pushInfo"),
      clearInfo: () => updateState((state) => ({
        notifications: { ...state.notifications, info: [] }
      }), "notifications.clearInfo")
    },

    remoteRepo: {
      setLoading: (loading) => updateState((state) => ({
        remoteRepo: { ...state.remoteRepo, loadingInProgress: Boolean(loading) }
      }), "remoteRepo.setLoading"),
      setMeta: (metadata) => updateState((state) => ({
        remoteRepo: { ...state.remoteRepo, metadata }
      }), "remoteRepo.setMeta"),
      setLoadedRepo: ({ url, ref, sha }) => updateState((state) => ({
        remoteRepo: {
          ...state.remoteRepo,
          loaded: true,
          url: url ?? state.remoteRepo.url,
          ref: ref ?? state.remoteRepo.ref,
          sha: sha ?? state.remoteRepo.sha,
          loadingInProgress: false
        }
      }), "remoteRepo.setLoadedRepo"),
      reset: () => updateState((state) => ({
        remoteRepo: {
          loaded: false,
          url: "",
          ref: "main",
          metadata: null,
          loadingInProgress: false,
          sha: undefined
        }
      }), "remoteRepo.reset")
    },

    diagnostics: {
      setStatus: (status) => updateState((state) => ({
        diagnostics: { ...state.diagnostics, status },
        status
      }), "diagnostics.setStatus"),
      setViewState: (viewState) => updateState((state) => ({
        diagnostics: { ...state.diagnostics, viewState: { ...(state.diagnostics.viewState ?? {}), ...(viewState ?? {}) } },
        viewState: { ...(state.viewState ?? {}), ...(viewState ?? {}) }
      }), "diagnostics.setViewState")
    },

    devtools: {
      snapshot: () => ({ ...get() }),
      reset: () => {
        api.setState(syncLegacyState({ ...api.getInitialState?.() }), true, "devtools.reset");
      }
    }
  };
};
