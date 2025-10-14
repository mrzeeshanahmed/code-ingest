/*
 * Follow instructions in copilot-instructions.md exactly.
 */

import { clampNumber, sanitizeRecord, sanitizeText } from "./utils/sanitizers.js";
import { FileTreeComponent } from "./components/fileTree.js";
import { COMMAND_MAP } from "./commandMap.js";

const COMPLETION_TOAST_TIMEOUT = 3000;
const PROGRESS_LABELS = Object.freeze({
  scan: "Scanning files",
  filter: "Filtering selections",
  tokenize: "Tokenizing content",
  ingest: "Ingesting",
  write: "Writing output"
});

export class UIRenderer {
  constructor(doc, options = {}) {
    if (!doc || typeof doc.querySelector !== "function") {
      throw new TypeError("UIRenderer requires a document-like object");
    }

  this.document = doc;
  this.vscode = window?.vscode;
  this.commandExecutor = typeof options.commandExecutor === "function" ? options.commandExecutor : null;
  this.workspaceRoot = typeof options.workspaceRoot === "string" && options.workspaceRoot.length > 0 ? options.workspaceRoot : undefined;
  this.workspaceInfo = this.workspaceRoot ? this.buildWorkspaceInfo(this.workspaceRoot) : null;
  this.selectionDebounceMs = Number.isFinite(options.selectionDebounceMs) && options.selectionDebounceMs >= 0 ? options.selectionDebounceMs : 100;
  this.selectionUpdateBuffer = new Map();
  this.selectionFlushTimer = null;
    this.dashboard = doc.querySelector(".layout") ?? doc.body;
    this.statusArea = doc.querySelector(".status-strip") ?? this.dashboard;

    this.statusPrimaryChip = this.statusArea.querySelector('[data-element="status-primary"]')
      ?? this.dashboard.querySelector('[data-element="status-primary"]');
    this.statusRepoChip = this.dashboard.querySelector('[data-element="status-repo"]');
    this.statusConfigChip = this.dashboard.querySelector('[data-element="status-config"]');
    this.insightConfigElement = this.dashboard.querySelector('[data-element="insight-config"]');
    this.insightRepoElement = this.dashboard.querySelector('[data-element="insight-repo"]');
    this.insightPerformanceElement = this.dashboard.querySelector('[data-element="insight-performance"]');

    this.pipelineSection = doc.querySelector("#panel-status .progress");
    this.pipelineTrack = this.pipelineSection?.querySelector(".progress__track");
    this.pipelineIndicator = this.pipelineSection?.querySelector(".progress__indicator");
    this.pipelineMessage = this.pipelineSection?.querySelector(".progress__message");
    this.pipelineLog = doc.querySelector('[data-element="status-log"]');
    this.pipelineLogEntries = [];

    this.treeHost = doc.getElementById("file-tree-host");
    this.treePlaceholder = doc.querySelector('[data-element="tree-placeholder"]');

    this.selectionSet = new Set();
    this.expandedPaths = new Set();
    this.treeModel = [];

    this.fileTree = this.treeHost
      ? new FileTreeComponent({
          nodes: [],
          selectedFiles: this.selectionSet,
          expandedPaths: this.expandedPaths,
          onToggleSelection: ({ path, selected }) => this.handleToggleSelection(path, selected),
          onToggleExpand: ({ path }) => this.handleToggleExpand(path),
          onSelectionCommand: (action) => this.handleTreeAction(action),
          onOpen: () => {}
        })
      : null;

    if (this.fileTree && this.treeHost) {
      this.treeHost.replaceChildren(this.fileTree.element);
      this.treeHost.hidden = false;
    }

    this.previewArticle = doc.querySelector("article.preview");
    this.previewTitleNode = this.previewArticle?.querySelector(".preview__title") ?? null;
    this.previewSubtitleNode = this.previewArticle?.querySelector(".preview__subtitle") ?? null;
    this.previewContentNode = this.previewArticle?.querySelector(".preview__content") ?? null;
    this.previewFooterNode = this.previewArticle?.querySelector(".preview__footer") ?? null;
    this.previewMetaElement = doc.querySelector('[data-element="preview-meta"]');
    this.previewTruncationElement = this.previewFooterNode?.querySelector('[data-element="preview-truncation"]') ?? null;

    this.currentPreview = {
      previewId: null,
      title: "",
      subtitle: "",
      summary: "",
      previewText: "",
      previewHtml: "",
      truncated: false,
      nodes: [],
      metadata: {},
      tokenCount: null,
      stats: null
    };

    this.errorBanner = null;
    this.errorMessageNode = null;
    this.repoBanner = null;
    this.configSummary = null;
    this.loadingOverlay = null;
    this.toastTimeout = null;
  }

  setCommandExecutor(executor) {
    this.commandExecutor = typeof executor === "function" ? executor : null;
  }

  updateTree(nodes, options = {}) {
    const candidateNodes = Array.isArray(nodes) ? nodes : [];
    this.treeModel = this.normalizeTree(candidateNodes);

    if (options.expandState) {
      this.expandedPaths = this.extractExpandedPaths(options.expandState);
    } else {
      this.expandedPaths = this.collectExpandedPaths(candidateNodes);
    }

    const hasNodes = this.treeModel.length > 0;
    if (this.treePlaceholder) {
      if (hasNodes) {
        this.treePlaceholder.setAttribute("hidden", "true");
      } else {
        this.treePlaceholder.removeAttribute("hidden");
      }
    }

    if (this.treeHost) {
      this.treeHost.classList.toggle("is-empty", !hasNodes);
      if (this.fileTree) {
        this.treeHost.hidden = false;
      } else {
        this.treeHost.hidden = !hasNodes;
      }
    }

    if (!this.fileTree) {
      return;
    }

    this.fileTree.setSelection(this.selectionSet);
    this.fileTree.setExpanded(new Set(this.expandedPaths));
    this.fileTree.setNodes(this.treeModel);
  }

  updateTreeSelection(selection) {
    const normalized = Array.isArray(selection)
      ? selection
          .map((value) => this.toWorkspaceRelative(value))
          .filter((value) => typeof value === "string" && value.length > 0)
      : [];

    this.selectionSet = new Set(normalized);
    this.cancelSelectionFlush();
    if (this.fileTree) {
      this.fileTree.setSelection(this.selectionSet);
    }
  }

  updatePreview(preview) {
    const sanitizedMetadata = sanitizeRecord(preview?.metadata ?? {}, (value) => sanitizeText(value, { maxLength: 2048 }));
    const normalizedNodes = Array.isArray(preview?.nodes)
      ? preview.nodes
          .filter((node) => node && typeof node === "object")
          .map((node) => ({
            path: sanitizeText(node.path ?? node.uri ?? node.relPath ?? "", { maxLength: 1024 }),
            snippet: sanitizeText(node.snippet ?? node.preview ?? node.text ?? "", { maxLength: 4000 }),
            truncated: Boolean(node.truncated)
          }))
      : [];

    this.currentPreview = {
      previewId: preview?.id ?? preview?.previewId ?? null,
      title: sanitizeText(preview?.title ?? "Digest preview"),
      subtitle: sanitizeText(preview?.subtitle ?? "Live digest preview"),
      summary: sanitizeText(preview?.summary ?? "", { maxLength: 20_000 }),
      previewText: sanitizeText(preview?.content ?? preview?.text ?? preview?.previewText ?? "", { maxLength: 200_000 }),
      previewHtml: sanitizeText(preview?.html ?? preview?.previewHtml ?? "", { maxLength: 200_000 }),
      truncated: Boolean(preview?.truncated),
      nodes: normalizedNodes,
      metadata: sanitizedMetadata,
      tokenCount: preview?.tokenCount ?? null,
      stats: preview?.stats ?? null
    };

    this.renderCurrentPreview();
    this.refreshPreviewMeta();
  }

  setTokenCount(tokenInfo) {
    this.currentPreview.tokenCount = tokenInfo ?? null;
    this.refreshPreviewMeta();
  }

  applyPreviewDelta(delta) {
    const changes = Array.isArray(delta?.changes) ? delta.changes : [];
    let nextText = this.currentPreview.previewText ?? "";
    for (const change of changes) {
      const type = change?.changeType ?? change?.op ?? "update";
      const content = sanitizeText(change?.content ?? "", { maxLength: 200_000 });
      if (type === "append") {
        nextText += content;
      } else if (type === "remove") {
        nextText = "";
      } else {
        nextText = content;
      }
    }
    this.currentPreview.previewText = nextText;
    this.renderCurrentPreview();
  }

  renderCurrentPreview() {
    const preview = this.currentPreview ?? {};
    const title = preview.title || "Digest preview";
    const subtitle = preview.subtitle || "";

    if (this.previewTitleNode) {
      this.previewTitleNode.textContent = title;
    }

    if (this.previewSubtitleNode) {
      if (subtitle) {
        this.previewSubtitleNode.textContent = subtitle;
        this.previewSubtitleNode.removeAttribute("hidden");
      } else {
        this.previewSubtitleNode.textContent = "";
        this.previewSubtitleNode.setAttribute("hidden", "true");
      }
    }

    if (this.previewContentNode) {
      const sections = [];
      if (preview.summary) {
        sections.push(preview.summary);
      }
      const body = preview.previewHtml || preview.previewText;
      if (body) {
        sections.push(body);
      }
      if (Array.isArray(preview.nodes) && preview.nodes.length > 0) {
        const nodeStrings = preview.nodes
          .filter((node) => node && (node.path || node.snippet))
          .map((node) => {
            const snippet = node.snippet ? `\n  ${node.snippet}` : "";
            return `${node.path || "(unknown path)"}${snippet}`;
          });
        sections.push(nodeStrings.join("\n\n"));
      }
      const combined = sections.filter(Boolean).join("\n\n");
      this.previewContentNode.textContent = combined || "Run a generation to populate the preview.";
    }

    if (this.previewArticle) {
      const hasContent = Boolean(this.previewContentNode?.textContent?.trim());
      this.previewArticle.dataset.state = hasContent ? "ready" : "empty";
    }

    if (this.previewFooterNode) {
      const shouldShowNotice = preview.truncated === true;
      if (shouldShowNotice) {
        if (!this.previewTruncationElement) {
          this.previewTruncationElement = this.document.createElement("span");
          this.previewTruncationElement.className = "preview__truncation";
          this.previewTruncationElement.dataset.element = "preview-truncation";
          this.previewFooterNode.appendChild(this.previewTruncationElement);
        }
        this.previewTruncationElement.textContent = "Content truncated. Use copy to capture full output.";
      } else if (this.previewTruncationElement) {
        this.previewTruncationElement.remove();
        this.previewTruncationElement = null;
      }
    }
  }

  refreshPreviewMeta() {
    if (!this.previewMetaElement) {
      return;
    }

    const parts = [];
    const tokenInfo = this.currentPreview.tokenCount;
    if (tokenInfo && typeof tokenInfo === "object") {
      if (typeof tokenInfo.total === "number" && Number.isFinite(tokenInfo.total)) {
        parts.push(`${tokenInfo.total.toLocaleString()} tokens`);
      } else if (typeof tokenInfo.approx === "number" && Number.isFinite(tokenInfo.approx)) {
        parts.push(`~${tokenInfo.approx.toLocaleString()} tokens`);
      }
    }

    const stats = this.currentPreview.stats;
    if (stats && typeof stats === "object") {
      for (const [key, value] of Object.entries(stats).slice(0, 3)) {
        const safeKey = sanitizeText(key, { maxLength: 128 });
        const safeValue = sanitizeText(value, { maxLength: 1024 });
        if (safeKey && safeValue) {
          parts.push(`${safeKey}: ${safeValue}`);
        }
      }
    }

    if (parts.length === 0) {
      const metadataEntries = Object.entries(this.currentPreview.metadata ?? {}).slice(0, 2);
      for (const [metaKey, metaValue] of metadataEntries) {
        const safeKey = sanitizeText(metaKey, { maxLength: 128 });
        const safeValue = sanitizeText(metaValue, { maxLength: 512 });
        if (safeKey && safeValue) {
          parts.push(`${safeKey}: ${safeValue}`);
        }
      }
    }

    if (this.currentPreview.truncated) {
      parts.push("Preview truncated");
    }

    const message = parts.length > 0 ? parts.join(" • ") : "Token usage and stats will appear here.";
    this.previewMetaElement.textContent = message;
  }

  appendPipelineLog(entry) {
    if (!this.pipelineLog) {
      return;
    }
    const safeEntry = sanitizeText(entry, { maxLength: 4096 });
    if (!safeEntry) {
      return;
    }

    const lastEntry = this.pipelineLogEntries[this.pipelineLogEntries.length - 1];
    if (lastEntry === safeEntry) {
      return;
    }

    this.pipelineLogEntries.push(safeEntry);
    if (this.pipelineLogEntries.length > 100) {
      this.pipelineLogEntries.splice(0, this.pipelineLogEntries.length - 100);
    }

    this.pipelineLog.textContent = this.pipelineLogEntries.join("\n");
    this.pipelineLog.scrollTop = this.pipelineLog.scrollHeight;
  }

  updateProgress(progress) {
    const label = PROGRESS_LABELS[progress?.phase] ?? "Processing";
    const percent = clampNumber(progress?.percent, { min: 0, max: 100, defaultValue: undefined });
    const statusMessage = sanitizeText(progress?.message ?? label);

    if (!progress) {
      if (this.pipelineIndicator) {
        this.pipelineIndicator.style.width = "0%";
      }
      if (this.pipelineTrack) {
        this.pipelineTrack.removeAttribute("aria-valuenow");
      }
      if (this.pipelineMessage) {
        this.pipelineMessage.textContent = "Waiting for operation.";
      }
      if (this.pipelineSection) {
        this.pipelineSection.dataset.phase = "idle";
        this.pipelineSection.classList.remove("is-busy");
      }
      if (this.statusPrimaryChip) {
        this.statusPrimaryChip.textContent = "Idle";
      }
      if (this.insightPerformanceElement) {
        this.insightPerformanceElement.textContent = "Idle";
      }
      this.toggleLoadingOverlay(false);
      return;
    }

    if (this.pipelineIndicator) {
      this.pipelineIndicator.style.width = typeof percent === "number" ? `${percent}%` : "0%";
    }
    if (this.pipelineTrack) {
      if (typeof percent === "number") {
        this.pipelineTrack.setAttribute("aria-valuenow", String(Math.round(percent)));
      } else {
        this.pipelineTrack.removeAttribute("aria-valuenow");
      }
      this.pipelineTrack.setAttribute("aria-label", `${label} progress`);
    }
    if (this.pipelineMessage) {
      this.pipelineMessage.textContent = statusMessage || label;
    }
    if (this.pipelineSection) {
      this.pipelineSection.dataset.phase = progress.phase ?? "processing";
      const isBusy = progress.busy === true || (typeof percent === "number" && percent < 100);
      this.pipelineSection.classList.toggle("is-busy", isBusy);
    }

    if (this.statusPrimaryChip) {
      this.statusPrimaryChip.textContent = statusMessage || label;
    }

    if (this.insightPerformanceElement) {
      const percentText = typeof percent === "number" ? `${Math.round(percent)}%` : "…";
      this.insightPerformanceElement.textContent = `${label}: ${percentText}`;
    }

    if (progress.overlayMessage) {
      this.toggleLoadingOverlay(true, progress.overlayMessage);
    } else if (progress.busy === false && (typeof percent === "number" ? percent >= 100 : true)) {
      this.toggleLoadingOverlay(false);
    }

    if (typeof progress.message === "string" && progress.message.trim()) {
      this.appendPipelineLog(`${label}: ${progress.message}`);
    }

    if (progress.phase === "ingest" && percent === 100) {
      this.showCompletionToast("Ingestion complete");
    }
  }

  toggleLoadingOverlay(visible, message) {
    if (!visible) {
      if (this.loadingOverlay) {
        this.loadingOverlay.remove();
        this.loadingOverlay = null;
      }
      return;
    }

    if (!this.loadingOverlay) {
      this.loadingOverlay = this.document.createElement("div");
      this.loadingOverlay.className = "loading-overlay";
      this.loadingOverlay.setAttribute("role", "alert");
      const spinner = this.document.createElement("div");
      spinner.className = "loading-overlay__spinner";
      const label = this.document.createElement("div");
      label.className = "loading-overlay__label";
      this.loadingOverlay.appendChild(spinner);
      this.loadingOverlay.appendChild(label);
      this.dashboard.appendChild(this.loadingOverlay);
    }

    const label = this.loadingOverlay.querySelector(".loading-overlay__label");
    if (label) {
      label.textContent = sanitizeText(message ?? "Working…");
    }
    if (this.statusPrimaryChip && message) {
      this.statusPrimaryChip.textContent = sanitizeText(message);
    }
  }

  showRecoverableError(error) {
    const container = this.ensureStatusArea();
    if (!this.errorBanner) {
      this.errorBanner = this.document.createElement("div");
      this.errorBanner.className = "status-bar__error";
      this.errorBanner.setAttribute("role", "alert");

      this.errorMessageNode = this.document.createElement("span");
      this.errorMessageNode.className = "status-bar__error-message";
      this.errorBanner.appendChild(this.errorMessageNode);

      const copyButton = this.document.createElement("button");
      copyButton.type = "button";
      copyButton.className = "status-bar__copy";
      copyButton.textContent = "Copy details";
      copyButton.addEventListener("click", () => {
        const message = this.errorBanner?.dataset.message ?? "";
        this.postCommand("copyScrubbedError", { message });
      });
      this.errorBanner.appendChild(copyButton);
      container.appendChild(this.errorBanner);
    }

    const title = sanitizeText(error?.title ?? "Something went wrong");
    const message = sanitizeText(error?.message ?? "Check the logs for more information.");
    this.errorBanner.dataset.message = message;
    this.errorBanner.dataset.title = title;
    this.errorBanner.setAttribute("aria-label", `${title}: ${message}`);
    if (this.errorMessageNode) {
      this.errorMessageNode.textContent = `${title}: ${message}`;
    }
  }

  clearRecoverableError() {
    if (this.errorBanner) {
      this.errorBanner.remove();
      this.errorBanner = null;
      this.errorMessageNode = null;
    }
  }

  showRepoMetadata(meta) {
    const container = this.ensureStatusArea();
    if (!this.repoBanner) {
      this.repoBanner = this.document.createElement("div");
      this.repoBanner.className = "status-bar__repo";
      container.appendChild(this.repoBanner);
    }

    const url = sanitizeText(meta?.repoUrl ?? "");
    const sha = sanitizeText(meta?.sha ?? "");
    const subpath = sanitizeText(meta?.subpath ?? "");
    const shortSha = sha.slice(0, 7);
    const message = subpath ? `${url} (${subpath}) @ ${shortSha}` : `${url} @ ${shortSha}`;
    this.repoBanner.textContent = `Remote repo loaded: ${message}`;
    if (this.statusRepoChip) {
      this.statusRepoChip.textContent = message;
    }
    if (this.insightRepoElement) {
      this.insightRepoElement.textContent = `Remote repo loaded: ${message}`;
    }
  }

  enableIngestActions(enabled) {
    const buttons = this.document.querySelectorAll('[data-action="generate"], [data-action="refresh"], [data-action="refresh-tree"]');
    buttons.forEach((button) => {
      button.disabled = !enabled;
    });
  }

  updateConfig(config) {
    const container = this.ensureStatusArea();
    if (!this.configSummary) {
      this.configSummary = this.document.createElement("div");
      this.configSummary.className = "status-bar__config";
      container.appendChild(this.configSummary);
    }

    const safeConfig = sanitizeRecord(config ?? {});
    const redactionOverride = Boolean(safeConfig.redactionOverride);
    const entries = Object.entries(safeConfig)
      .filter(([key, value]) => key !== "redactionOverride" && value !== undefined)
      .map(([key, value]) => `${key}: ${value}`);
    const summary = entries.length === 0 ? "Using default configuration" : entries.join(" · ");
    this.configSummary.textContent = summary;
    if (this.statusConfigChip) {
      this.statusConfigChip.textContent = summary;
    }
    if (this.insightConfigElement) {
      this.insightConfigElement.textContent = summary;
    }

    const toggleButton = this.document.querySelector('[data-action="toggle-redaction"]');
    if (toggleButton instanceof HTMLButtonElement) {
      toggleButton.setAttribute("aria-pressed", redactionOverride ? "true" : "false");
      toggleButton.classList.toggle("is-active", redactionOverride);
      toggleButton.textContent = redactionOverride ? "Disable Redaction" : "Enable Redaction";
    }
  }

  showGenerationResult(result) {
    this.updatePreview({
      id: result?.resultId ?? result?.previewId,
      title: result?.title ?? "Generation complete",
      subtitle: result?.subtitle ?? "Preview of the generated digest",
      content: result?.content ?? "",
      summary: result?.summary,
      tokenCount: result?.tokenCount,
      nodes: result?.nodes ?? [],
      stats: result?.stats ?? null,
      metadata: result?.metadata ?? {}
    });

    if (result?.stats && this.insightPerformanceElement) {
      const primaryStat = Object.entries(result.stats)[0];
      if (primaryStat) {
        const [statKey, statValue] = primaryStat;
        this.insightPerformanceElement.textContent = `${sanitizeText(statKey)}: ${sanitizeText(statValue)}`;
      } else {
        this.insightPerformanceElement.textContent = "Digest updated";
      }
    }

    if (typeof result?.message === "string" && result.message.trim()) {
      this.appendPipelineLog(result.message);
    } else {
      this.appendPipelineLog("Digest generation completed.");
    }

    if (this.statusPrimaryChip) {
      this.statusPrimaryChip.textContent = "Digest ready";
    }
  }

  restoreState(state) {
    if (!state || typeof state !== "object") {
      return;
    }

    if (Array.isArray(state.selection)) {
      this.updateTreeSelection(state.selection);
    }

    if (state.expandState && typeof state.expandState === "object") {
      this.expandedPaths = this.extractExpandedPaths(state.expandState);
      if (this.fileTree) {
        this.fileTree.setExpanded(new Set(this.expandedPaths));
      }
    }

    if (state.preview) {
      this.updatePreview(state.preview);
    }
  }

  ensureStatusArea() {
    if (this.statusArea) {
      return this.statusArea;
    }
    const parent = this.dashboard?.querySelector(".dashboard__header") ?? this.dashboard;
    const existing = parent.querySelector(".status-bar");
    if (existing) {
      this.statusArea = existing;
      return existing;
    }
    const section = this.document.createElement("section");
    section.className = "status-bar";
    section.setAttribute("role", "status");
    parent.appendChild(section);
    this.statusArea = section;
    return section;
  }

  normalizeTree(nodes, depth = 0) {
    const result = [];
    for (const node of nodes) {
      if (!node || typeof node !== "object") {
        continue;
      }

      const absolutePath = typeof node.uri === "string" ? node.uri : typeof node.path === "string" ? node.path : undefined;
      let relativePath = typeof node.relPath === "string" && node.relPath.length > 0
        ? this.toWorkspaceRelative(node.relPath)
        : undefined;

      if (!relativePath && absolutePath) {
        relativePath = this.toWorkspaceRelative(absolutePath);
      }

      if (!relativePath && typeof node.name === "string") {
        relativePath = node.name;
      }

      if (!relativePath) {
        relativePath = `node-${depth}-${result.length}`;
      }

      const children = Array.isArray(node.children) ? this.normalizeTree(node.children, depth + 1) : [];
      const type = node.type ?? (children.length > 0 ? "directory" : "file");

      result.push({
        name: node.name ?? node.label ?? "(unnamed)",
        relPath: relativePath,
        uri: absolutePath,
        type,
        children,
        placeholder: Boolean(node.placeholder),
        expanded: Boolean(node.expanded),
        size: typeof node.size === "number" ? node.size : undefined
      });
    }
    return result;
  }

  extractExpandedPaths(expandState) {
    const paths = new Set();
    for (const [path, expanded] of Object.entries(expandState ?? {})) {
      if (expanded) {
        paths.add(path);
      }
    }
    return paths;
  }

  collectExpandedPaths(nodes, acc = new Set()) {
    for (const node of nodes ?? []) {
      if (!node || typeof node !== "object") {
        continue;
      }
  const rawPath = typeof node.relPath === "string" ? node.relPath : typeof node.uri === "string" ? node.uri : node.path;
  const path = this.toWorkspaceRelative(rawPath);
      if (node.expanded && path) {
        acc.add(path);
      }
      if (Array.isArray(node.children)) {
        this.collectExpandedPaths(node.children, acc);
      }
    }
    return acc;
  }

  handleToggleSelection(path, selected) {
    const normalizedPath = this.toWorkspaceRelative(path);
    if (!normalizedPath) {
      return;
    }
    if (selected) {
      this.selectionSet.add(normalizedPath);
    } else {
      this.selectionSet.delete(normalizedPath);
    }
    this.enqueueSelectionUpdate(normalizedPath, selected);
  }

  handleToggleExpand(path) {
    if (!path) {
      return;
    }
    if (this.expandedPaths.has(path)) {
      this.expandedPaths.delete(path);
    } else {
      this.expandedPaths.add(path);
    }
  }

  handleTreeAction(action) {
    if (!action || typeof action.type !== "string") {
      return;
    }
    if (action.type === "select-all") {
      this.postCommand(COMMAND_MAP.WEBVIEW_TO_HOST.SELECT_ALL);
    } else if (action.type === "clear") {
      this.postCommand(COMMAND_MAP.WEBVIEW_TO_HOST.DESELECT_ALL);
    }
  }

  postCommand(commandId, payload) {
    if (typeof this.commandExecutor === "function") {
      try {
        void this.commandExecutor(commandId, payload);
      } catch (error) {
        console.error("UIRenderer: command executor failed", commandId, error);
      }
      return;
    }

    if (!this.vscode || typeof this.vscode.postMessage !== "function") {
      return;
    }

    this.vscode.postMessage({ type: "command", command: commandId, payload });
  }

  showCompletionToast(message) {
    const container = this.ensureStatusArea();
    let toast = container.querySelector(".status-bar__toast");
    if (!toast) {
      toast = this.document.createElement("div");
      toast.className = "status-bar__toast";
      toast.setAttribute("role", "status");
      container.appendChild(toast);
    }
    toast.textContent = sanitizeText(message ?? "Completed");
    if (this.toastTimeout) {
      window.clearTimeout(this.toastTimeout);
    }
    this.toastTimeout = window.setTimeout(() => {
      toast?.remove();
      this.toastTimeout = null;
    }, COMPLETION_TOAST_TIMEOUT);
  }

  normalizeSeparators(value) {
    return typeof value === "string" ? value.replace(/[\\/]+/g, "/") : value;
  }

  buildWorkspaceInfo(root) {
    const normalized = this.normalizeSeparators(root).replace(/\/+$/, "");
    if (normalized.length === 0) {
      return null;
    }
    return {
      normalized,
      normalizedLower: normalized.toLowerCase()
    };
  }

  stripDrivePrefix(value) {
    if (typeof value !== "string") {
      return undefined;
    }
    if (/^\/[a-zA-Z]:/.test(value)) {
      return value.slice(1);
    }
    return value;
  }

  toWorkspaceRelative(value) {
    if (typeof value !== "string") {
      return undefined;
    }
    let candidate = value.trim();
    if (candidate.length === 0) {
      return undefined;
    }

    if (candidate.startsWith("file://")) {
      try {
        const url = new URL(candidate);
        candidate = decodeURIComponent(url.pathname ?? "");
      } catch {
        candidate = candidate.slice("file://".length);
      }
    }

    candidate = this.normalizeSeparators(this.stripDrivePrefix(candidate) ?? candidate);

    if (this.workspaceInfo && candidate) {
      const candidateLower = candidate.toLowerCase();
      if (candidateLower.startsWith(this.workspaceInfo.normalizedLower)) {
        candidate = candidate.slice(this.workspaceInfo.normalized.length);
        while (candidate.startsWith("/")) {
          candidate = candidate.slice(1);
        }
      }
    }

    if (candidate.startsWith("/")) {
      candidate = candidate.replace(/^\/+/, "");
    }

    if (/^[a-zA-Z]:/.test(candidate)) {
      return undefined;
    }

    if (candidate.includes("://")) {
      return undefined;
    }

    if (candidate.length === 0 || candidate === ".") {
      return undefined;
    }

    return candidate;
  }

  enqueueSelectionUpdate(path, selected) {
    this.selectionUpdateBuffer.set(path, Boolean(selected));
    this.scheduleSelectionFlush();
  }

  scheduleSelectionFlush() {
    if (this.selectionDebounceMs === 0) {
      this.flushSelectionUpdates();
      return;
    }

    if (this.selectionFlushTimer) {
      window.clearTimeout(this.selectionFlushTimer);
    }

    this.selectionFlushTimer = window.setTimeout(() => {
      this.selectionFlushTimer = null;
      this.flushSelectionUpdates();
    }, this.selectionDebounceMs);
  }

  flushSelectionUpdates() {
    if (this.selectionUpdateBuffer.size === 0) {
      return;
    }
    const updates = Array.from(this.selectionUpdateBuffer.entries());
    this.selectionUpdateBuffer.clear();
    for (const [path, selected] of updates) {
      this.postCommand(COMMAND_MAP.WEBVIEW_TO_HOST.UPDATE_SELECTION, { filePath: path, selected });
    }
  }

  cancelSelectionFlush() {
    if (this.selectionFlushTimer) {
      window.clearTimeout(this.selectionFlushTimer);
      this.selectionFlushTimer = null;
    }
    this.selectionUpdateBuffer.clear();
  }
}
