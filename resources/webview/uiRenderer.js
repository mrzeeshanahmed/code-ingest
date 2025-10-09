/*
 * Follow instructions in copilot-instructions.md exactly.
 */

import { sanitizeRecord, sanitizeText } from "./utils/sanitizers.js";
import { FileTreeComponent } from "./components/fileTree.js";
import { PreviewComponent } from "./components/preview.js";
import { ProgressComponent } from "./components/progress.js";
import { COMMAND_MAP } from "./commandMap.generated.js";

const COMPLETION_TOAST_TIMEOUT = 3000;

export class UIRenderer {
  constructor(doc) {
    if (!doc || typeof doc.querySelector !== "function") {
      throw new TypeError("UIRenderer requires a document-like object");
    }

    this.document = doc;
    this.vscode = window?.vscode;
    this.dashboard = doc.querySelector(".dashboard") ?? doc.body;
    this.treeMount = doc.querySelector(".panel--tree .panel__body");
    this.previewMount = doc.querySelector(".panel--preview .panel__body");

    this.selectionSet = new Set();
    this.expandedPaths = new Set();
    this.treeModel = [];
    this.currentPreview = {};

    this.fileTree = this.treeMount
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

    if (this.fileTree && this.treeMount) {
      this.treeMount.replaceChildren(this.fileTree.element);
    }

    this.previewComponent = this.previewMount
      ? new PreviewComponent({
          onOpenFile: () => {},
          onCopyPreview: () => {},
          onRequestFullContent: () => {}
        })
      : null;

    if (this.previewComponent && this.previewMount) {
      this.previewMount.replaceChildren(this.previewComponent.element);
    }

    this.statusArea = this.ensureStatusArea();
    this.progressComponent = new ProgressComponent({
      onCancel: () => this.postCommand("cancelOperation")
    });
    this.progressComponent.hide();
    this.statusArea.appendChild(this.progressComponent.element);

    this.errorBanner = null;
  this.errorMessageNode = null;
    this.repoBanner = null;
    this.configSummary = null;
    this.tokenCountElement = null;
    this.statsContainer = null;
    this.loadingOverlay = null;
    this.toastTimeout = null;
  }

  updateTree(nodes, options = {}) {
    if (!this.fileTree) {
      return;
    }

    this.treeModel = this.normalizeTree(Array.isArray(nodes) ? nodes : []);
    if (options.expandState) {
      this.expandedPaths = this.extractExpandedPaths(options.expandState);
    } else {
      this.expandedPaths = this.collectExpandedPaths(Array.isArray(nodes) ? nodes : []);
    }

    this.fileTree.setSelection(this.selectionSet);
    this.fileTree.setExpanded(new Set(this.expandedPaths));
    this.fileTree.setNodes(this.treeModel);
  }

  updateTreeSelection(selection) {
    this.selectionSet = new Set(Array.isArray(selection) ? selection : []);
    if (this.fileTree) {
      this.fileTree.setSelection(this.selectionSet);
    }
  }

  updatePreview(preview) {
    if (!this.previewComponent) {
      return;
    }
    const nextPreview = {
      previewId: preview?.id ?? preview?.previewId ?? null,
      title: preview?.title ?? "Digest preview",
      subtitle: preview?.subtitle ?? "Live digest preview",
      summary: preview?.summary ?? "",
      previewText: preview?.content ?? preview?.text ?? "",
      previewHtml: preview?.html ?? "",
      truncated: Boolean(preview?.truncated),
      nodes: preview?.nodes ?? [],
      metadata: preview?.metadata ?? {}
    };
    this.currentPreview = nextPreview;
    this.previewComponent.updatePreview(nextPreview);
    if (preview?.tokenCount) {
      this.setTokenCount(preview.tokenCount);
    }
  }

  setTokenCount(tokenInfo) {
    if (this.previewComponent) {
      this.previewComponent.setTokenCount(tokenInfo);
    }
  }

  applyPreviewDelta(delta) {
    if (!this.previewComponent) {
      return;
    }
    const changes = Array.isArray(delta?.changes) ? delta.changes : [];
    this.previewComponent.applyDelta(changes);
    this.currentPreview.previewText = this.previewComponent.state.text;
  }

  updateProgress(progress) {
    if (!progress) {
      this.progressComponent.hide();
      return;
    }

    this.progressComponent.update(progress);

    if (progress.overlayMessage) {
      this.toggleLoadingOverlay(true, progress.overlayMessage);
    } else if (!progress.busy) {
      this.toggleLoadingOverlay(false);
    }

    if (progress.phase === "ingest" && progress.percent === 100) {
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
  }

  enableIngestActions(enabled) {
    const buttons = this.document.querySelectorAll('[data-action="generate"], [data-action="refresh"]');
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
    const entries = Object.entries(safeConfig)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}: ${value}`);
    this.configSummary.textContent = entries.length === 0 ? "Using default configuration" : entries.join(" · ");
  }

  showGenerationResult(result) {
    this.updatePreview({
      id: result?.resultId ?? result?.previewId,
      title: result?.title ?? "Generation complete",
      subtitle: result?.subtitle ?? "Preview of the generated digest",
      content: result?.content ?? "",
      summary: result?.summary,
      tokenCount: result?.tokenCount,
      nodes: result?.nodes ?? []
    });

    if (result?.stats && this.previewComponent) {
      const container = this.ensureStatsContainer();
      container.textContent = "";
      for (const [key, value] of Object.entries(result.stats)) {
        const item = this.document.createElement("div");
        item.className = "preview__stat";
        item.textContent = `${sanitizeText(key)}: ${sanitizeText(value)}`;
        container.appendChild(item);
      }
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

  ensureStatsContainer() {
    if (this.statsContainer) {
      return this.statsContainer;
    }
    if (!this.previewComponent) {
      this.statsContainer = this.document.createElement("div");
      this.statsContainer.className = "preview__stats";
      return this.statsContainer;
    }
    this.statsContainer = this.document.createElement("section");
    this.statsContainer.className = "preview__stats";
    this.previewComponent.element.appendChild(this.statsContainer);
    return this.statsContainer;
  }

  normalizeTree(nodes, depth = 0) {
    const result = [];
    for (const node of nodes) {
      if (!node || typeof node !== "object") {
        continue;
      }
      const path = typeof node.uri === "string" ? node.uri : typeof node.path === "string" ? node.path : node.name ?? `node-${depth}-${result.length}`;
      const children = Array.isArray(node.children) ? this.normalizeTree(node.children, depth + 1) : [];
      const type = node.type ?? (children.length > 0 ? "directory" : "file");
      result.push({
        name: node.name ?? node.label ?? "(unnamed)",
        relPath: path,
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
      const path = typeof node.uri === "string" ? node.uri : node.path;
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
    if (!path) {
      return;
    }
    if (selected) {
      this.selectionSet.add(path);
    } else {
      this.selectionSet.delete(path);
    }
    this.postCommand(COMMAND_MAP.WEBVIEW_TO_HOST.UPDATE_SELECTION, { filePath: path, selected });
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
}
