export const COMMAND_MAP = {
  HOST_TO_WEBVIEW: {
    UPDATE_PREVIEW: "codeIngest.updatePreview",
    UPDATE_PROGRESS: "codeIngest.updateProgress",
    UPDATE_TREE_DATA: "codeIngest.updateTreeData",
    UPDATE_CONFIG: "codeIngest.updateConfig",
    SHOW_ERROR: "codeIngest.showError",
    RESTORE_STATE: "codeIngest.restoreState"
  },
  WEBVIEW_TO_HOST: {
    GENERATE_DIGEST: "codeIngest.generateDigest",
    LOAD_REMOTE_REPO: "codeIngest.loadRemoteRepo",
    SELECT_ALL_FILES: "codeIngest.selectAllFiles",
    TOGGLE_REDACTION: "codeIngest.toggleRedactionOverride",
    APPLY_PRESET: "codeIngest.applyPreset",
    UPDATE_SELECTION: "codeIngest.updateSelection",
    REFRESH_TREE: "codeIngest.refreshTree",
    EXPAND_ALL: "codeIngest.expandAll",
    COLLAPSE_ALL: "codeIngest.collapseAll",
    REFRESH_PREVIEW: "codeIngest.refreshPreview",
    SELECT_ALL: "codeIngest.selectAll",
    DESELECT_ALL: "codeIngest.deselectAll",
    WEBVIEW_READY: "codeIngest.webviewReady",
    FLUSH_ERROR_REPORTS: "codeIngest.flushErrorReports",
    VIEW_METRICS: "codeIngest.viewMetrics",
    OPEN_DASHBOARD_PANEL: "codeIngest.openDashboardPanel"
  },
  EXTENSION_ONLY: {
    REFRESH_TREE: "codeIngest.refreshTree",
    OPEN_DASHBOARD: "codeIngest.openDashboard",
    EXPAND_ALL: "codeIngest.expandAll",
    COLLAPSE_ALL: "codeIngest.collapseAll",
    REFRESH_PREVIEW: "codeIngest.refreshPreview",
    SELECT_ALL: "codeIngest.selectAll",
    DESELECT_ALL: "codeIngest.deselectAll",
    INGEST_REMOTE_REPO: "codeIngest.ingestRemoteRepo",
    VIEW_METRICS: "codeIngest.viewMetrics"
  }
} as const;

export type HostCommandKey = keyof typeof COMMAND_MAP.HOST_TO_WEBVIEW;
export type HostCommandId = (typeof COMMAND_MAP.HOST_TO_WEBVIEW)[HostCommandKey];

export type WebviewCommandKey = keyof typeof COMMAND_MAP.WEBVIEW_TO_HOST;
export type WebviewCommandId = (typeof COMMAND_MAP.WEBVIEW_TO_HOST)[WebviewCommandKey];

export type ExtensionCommandKey = keyof typeof COMMAND_MAP.EXTENSION_ONLY;
export type ExtensionCommandId = (typeof COMMAND_MAP.EXTENSION_ONLY)[ExtensionCommandKey];
