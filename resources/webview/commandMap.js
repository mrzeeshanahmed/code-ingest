/*
 * Follow instructions in copilot-instructions.md exactly.
 */

import { COMMAND_MAP as GENERATED_MAP } from "./commandMap.generated.js";

const HOST_TO_WEBVIEW_BASE = Object.freeze({
  UPDATE_PREVIEW: "codeIngest.updatePreview",
  UPDATE_PROGRESS: "codeIngest.updateProgress",
  UPDATE_TREE_DATA: "codeIngest.updateTreeData",
  UPDATE_CONFIG: "codeIngest.updateConfig",
  SHOW_ERROR: "codeIngest.showError",
  RESTORE_STATE: "codeIngest.restoreState"
});

const WEBVIEW_TO_HOST_BASE = Object.freeze({
  GENERATE_DIGEST: "codeIngest.generateDigest",
  LOAD_REMOTE_REPO: "codeIngest.loadRemoteRepo",
  TOGGLE_REDACTION: "codeIngest.toggleRedactionOverride",
  APPLY_PRESET: "codeIngest.applyPreset",
  UPDATE_SELECTION: "codeIngest.updateSelection",
  REFRESH_TREE: "codeIngest.refreshTree",
  EXPAND_ALL: "codeIngest.expandAll",
  COLLAPSE_ALL: "codeIngest.collapseAll",
  REFRESH_PREVIEW: "codeIngest.refreshPreview",
  COPY_PREVIEW: "codeIngest.copyPreview",
  SELECT_ALL: "codeIngest.selectAll",
  DESELECT_ALL: "codeIngest.deselectAll",
  WEBVIEW_READY: "codeIngest.webviewReady",
  FLUSH_ERROR_REPORTS: "codeIngest.flushErrorReports",
  VIEW_METRICS: "codeIngest.viewMetrics",
  OPEN_DASHBOARD_PANEL: "codeIngest.openDashboardPanel"
});

const COMMAND_POLICY_BASE = Object.freeze({
  GENERATE_DIGEST: { strategy: "dedupe", rationale: "Prevent duplicate digest runs for identical selections." },
  LOAD_REMOTE_REPO: { strategy: "queue", rationale: "Ensure remote loads run sequentially." },
  WEBVIEW_READY: { strategy: "dedupe", rationale: "Ready signal should only be emitted once per session." },
  REFRESH_TREE: { strategy: "queue", rationale: "Avoid overlapping refreshes that fight over tree state." }
});

function isUppercaseKey(key) {
  return /^[A-Z0-9_]+$/.test(key);
}

function toCamelCase(key) {
  return key
    .toLowerCase()
    .replace(/_([a-z0-9])/g, (_, char) => char.toUpperCase());
}

function createSection(baseEntries, generatedSection = {}) {
  const section = {};
  const merged = { ...generatedSection, ...baseEntries };

  for (const [key, value] of Object.entries(merged)) {
    if (typeof value !== "string" || value.length === 0) {
      continue;
    }
    section[key] = value;
    if (isUppercaseKey(key)) {
      const camelKey = toCamelCase(key);
      if (!Object.prototype.hasOwnProperty.call(section, camelKey)) {
        section[camelKey] = value;
      }
    }
  }

  return Object.freeze(section);
}

const hostToWebviewSection = createSection(
  HOST_TO_WEBVIEW_BASE,
  GENERATED_MAP?.HOST_TO_WEBVIEW ?? {}
);
const webviewToHostSection = createSection(
  WEBVIEW_TO_HOST_BASE,
  GENERATED_MAP?.WEBVIEW_TO_HOST ?? {}
);

export const COMMAND_MAP = Object.freeze({
  HOST_TO_WEBVIEW: hostToWebviewSection,
  WEBVIEW_TO_HOST: webviewToHostSection
});

export const COMMAND_POLICIES = Object.freeze(COMMAND_POLICY_BASE);

export const HOST_TO_WEBVIEW_REVERSE = Object.freeze(
  Object.fromEntries(
    Object.entries(COMMAND_MAP.HOST_TO_WEBVIEW).map(([key, value]) => [value, key])
  )
);

export const WEBVIEW_TO_HOST_REVERSE = Object.freeze(
  Object.fromEntries(
    Object.entries(COMMAND_MAP.WEBVIEW_TO_HOST).map(([key, value]) => [value, key])
  )
);

export function isValidHostToWebviewCommand(command) {
  return Object.values(COMMAND_MAP.HOST_TO_WEBVIEW).includes(command);
}

export function isValidWebviewToHostCommand(command) {
  return Object.values(COMMAND_MAP.WEBVIEW_TO_HOST).includes(command);
}

export function getCommandPolicy(commandId) {
  if (typeof commandId !== "string" || commandId.length === 0) {
    return undefined;
  }
  const key = WEBVIEW_TO_HOST_REVERSE[commandId];
  if (!key) {
    return undefined;
  }
  return COMMAND_POLICIES[key] ?? undefined;
}

export function getAllCommands() {
  return {
    hostToWebview: Object.values(COMMAND_MAP.HOST_TO_WEBVIEW),
    webviewToHost: Object.values(COMMAND_MAP.WEBVIEW_TO_HOST)
  };
}
