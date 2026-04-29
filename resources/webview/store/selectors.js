/*
 * Follow instructions in copilot-instructions.md exactly.
 */

import { buildConfigDisplay } from "../utils/configSummary.js";

const toFrozenArray = (value) => Object.freeze(Array.isArray(value) ? [...value] : Array.from(value ?? []));

export const selectUi = (state) => state.ui;
export const selectCurrentTab = (state) => state.ui.currentTab;
export const selectTheme = (state) => state.ui.theme;

export const selectFileTreeNodes = (state) => state.fileTree.nodes;
export const selectExpandedPaths = (state) => toFrozenArray(state.fileTree.expandedPaths ?? []);
export const selectSelectedFiles = (state) => toFrozenArray(state.fileTree.selectedFiles ?? []);
export const selectPreviewFiles = (state) => toFrozenArray(state.fileTree.previewFiles ?? []);
export const selectIsScanning = (state) => Boolean(state.fileTree.scanningInProgress);

export const selectGenerationProgress = (state) => state.generation.progress;
export const selectGenerationPreview = (state) => state.generation.preview;
export const selectGenerationResult = (state) => state.generation.lastResult;
export const selectGenerationInFlight = (state) => Boolean(state.generation.inProgress);
export const selectGenerationFormat = (state) => state.generation.outputFormat;
export const selectRedactionOverride = (state) => Boolean(state.generation.redactionOverride);

export const selectNotifications = (state) => state.notifications;
export const selectErrors = (state) => state.notifications.errors;
export const selectWarnings = (state) => state.notifications.warnings;
export const selectInfo = (state) => state.notifications.info;

export const selectRemoteRepo = (state) => state.remoteRepo;
export const selectRemoteRepoBanner = (state) => ({
  url: state.remoteRepo.url,
  sha: state.remoteRepo.sha,
  ref: state.remoteRepo.ref,
  loaded: state.remoteRepo.loaded
});

export const selectConfig = (state) => state.config;
export const selectConfigSummary = (state) => {
  const config = state.config ?? {};
  if (config.summary && typeof config.summary === "object") {
    return config.summary;
  }
  return buildConfigDisplay(config);
};
export const selectConfigIncludePatterns = (state) => {
  const summary = selectConfigSummary(state);
  return Object.freeze([...(summary?.include ?? [])]);
};
export const selectConfigExcludePatterns = (state) => {
  const summary = selectConfigSummary(state);
  return Object.freeze([...(summary?.exclude ?? [])]);
};
export const selectConfigRedactionOverride = (state) => Boolean(selectConfigSummary(state)?.redactionOverride);
export const selectDiagnostics = (state) => state.diagnostics;

export const selectLegacySnapshot = (state) => ({
  selection: toFrozenArray(state.fileTree.selectedFiles ?? []),
  tree: state.fileTree.nodes,
  preview: state.generation.preview,
  progress: state.generation.progress,
  lastGeneration: state.generation.lastResult,
  errors: state.notifications.errors,
  warnings: state.notifications.warnings,
  infoMessages: state.notifications.info
});

export const selectors = {
  selectUi,
  selectCurrentTab,
  selectTheme,
  selectFileTreeNodes,
  selectExpandedPaths,
  selectSelectedFiles,
  selectPreviewFiles,
  selectIsScanning,
  selectGenerationProgress,
  selectGenerationPreview,
  selectGenerationResult,
  selectGenerationInFlight,
  selectGenerationFormat,
  selectRedactionOverride,
  selectNotifications,
  selectErrors,
  selectWarnings,
  selectInfo,
  selectRemoteRepo,
  selectRemoteRepoBanner,
  selectConfig,
  selectConfigSummary,
  selectConfigIncludePatterns,
  selectConfigExcludePatterns,
  selectConfigRedactionOverride,
  selectDiagnostics,
  selectLegacySnapshot
};