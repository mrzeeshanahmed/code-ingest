/*
 * Follow instructions in copilot-instructions.md exactly.
 */

import { DOMNodes } from "../nodes.js";
import { VirtualScroller } from "../virtualScroller.js";
import { sanitizeText } from "../utils/sanitizers.js";

const VIRTUALIZATION_THRESHOLD = 150;
const LARGE_SELECTION_THRESHOLD = 800;
const BULK_SELECTION_MESSAGE = "Processing large selection…";
const FULL_SELECTION_MESSAGE = "All files selected";

const ACTIONS = Object.freeze([
  { id: "select-all", label: "Select all" },
  { id: "clear-selection", label: "Clear" }
]);

const escapeSelector = typeof CSS !== "undefined" && typeof CSS.escape === "function"
  ? (value) => CSS.escape(value)
  : (value) => String(value).replace(/([^a-zA-Z0-9_-])/g, "\\$1");

export class FileTreeComponent {
  constructor(props = {}) {
    this.props = {
      nodes: props.nodes ?? [],
      selectedFiles: props.selectedFiles ?? new Set(),
      expandedPaths: props.expandedPaths ?? new Set(),
      onToggleSelection: typeof props.onToggleSelection === "function" ? props.onToggleSelection : () => {},
      onToggleExpand: typeof props.onToggleExpand === "function" ? props.onToggleExpand : () => {},
      onRangeSelect: typeof props.onRangeSelect === "function" ? props.onRangeSelect : () => {},
      onOpen: typeof props.onOpen === "function" ? props.onOpen : () => {},
      onSelectionCommand: typeof props.onSelectionCommand === "function" ? props.onSelectionCommand : () => {}
    };

    this.focusedPath = null;
    this.dragState = null;
    this.selectedDirectories = new Set();
    this.cachedDirectoryPaths = this.collectDirectoryPaths(this.props.nodes ?? []);
    this.totalFileCount = this.countFiles(this.props.nodes ?? []);
    this.bulkSelectionActive = false;
    this.selectionRecalcHandle = null;
    this.statusBanner = null;
    this.statusBannerHideHandle = null;

    this.onClick = this.handleTreeClick.bind(this);
    this.onKeydown = this.handleKeydown.bind(this);
    this.onDragStart = this.handleDragStart.bind(this);
    this.onDragOver = this.handleDragOver.bind(this);
    this.onDrop = this.handleDrop.bind(this);

    this.element = DOMNodes.createElement("section", {
      className: "file-tree",
      role: "tree",
      ariaLabel: "Workspace files"
    });

    this.element.appendChild(this.createHeader());
    this.contentContainer = DOMNodes.createElement("div", {
      className: "file-tree-content",
      role: "presentation"
    });
    this.element.appendChild(this.contentContainer);

    this.virtualScroller = null;
    this.renderNodes(this.props.nodes);
    this.attachEventListeners();
  }

  createHeader() {
    const header = DOMNodes.createElement("div", { className: "file-tree-header" });
    const title = DOMNodes.createElement("h2", { textContent: "Files", className: "file-tree-title" });
    header.appendChild(title);

    const actions = DOMNodes.createElement("div", { className: "file-tree-actions", role: "group", ariaLabel: "File tree actions" });
    for (const action of ACTIONS) {
      const button = DOMNodes.createElement("button", {
        className: "file-tree-action",
        type: "button",
        textContent: action.label,
        "data-action": action.id,
        tabIndex: 0
      });
      actions.appendChild(button);
    }
    header.appendChild(actions);
    const status = DOMNodes.createElement("div", {
      className: "file-tree-status",
      textContent: ""
    });
    status.setAttribute("hidden", "true");
    header.appendChild(status);
    this.statusBanner = status;
    return header;
  }

  attachEventListeners() {
    this.element.addEventListener("click", this.onClick);
    this.element.addEventListener("keydown", this.onKeydown);
    this.element.addEventListener("dragstart", this.onDragStart);
    this.element.addEventListener("dragover", this.onDragOver);
    this.element.addEventListener("drop", this.onDrop);
  }

  detachEventListeners() {
    this.element.removeEventListener("click", this.onClick);
    this.element.removeEventListener("keydown", this.onKeydown);
    this.element.removeEventListener("dragstart", this.onDragStart);
    this.element.removeEventListener("dragover", this.onDragOver);
    this.element.removeEventListener("drop", this.onDrop);
  }

  setNodes(nodes) {
    if (!Array.isArray(nodes)) {
      return;
    }
    this.props.nodes = nodes;
    this.renderNodes(nodes);
    this.cachedDirectoryPaths = this.collectDirectoryPaths(nodes);
    this.totalFileCount = this.countFiles(nodes);
    this.bulkSelectionActive = false;
    this.hideStatusBanner();
    this.recalculateDirectorySelection();
  }

  setSelection(selected) {
    this.props.selectedFiles = selected instanceof Set ? selected : new Set(selected ?? []);
    const selectedSize = this.props.selectedFiles.size;
    const totalFiles = this.totalFileCount ?? 0;
    const hasFiles = totalFiles > 0;
    const isFullSelection = hasFiles && selectedSize >= totalFiles;
    const isBulkSelection = !isFullSelection && selectedSize >= LARGE_SELECTION_THRESHOLD;

    if (isFullSelection) {
      this.bulkSelectionActive = false;
      this.selectedDirectories = new Set(this.cachedDirectoryPaths ?? []);
      if (selectedSize > 0) {
        this.showStatusBanner(FULL_SELECTION_MESSAGE, "success", 1600);
      } else {
        this.hideStatusBanner();
      }
      this.updateSelectionStyles();
      if (this.virtualScroller) {
        this.virtualScroller.setItems(this.flattenNodes(this.props.nodes ?? []));
      }
      return;
    }

    if (isBulkSelection) {
      this.bulkSelectionActive = true;
      this.showStatusBanner(BULK_SELECTION_MESSAGE, "info");
      this.scheduleDirectoryRecalc();
      if (this.virtualScroller) {
        this.virtualScroller.setItems(this.flattenNodes(this.props.nodes ?? []));
      } else {
        this.updateSelectionStyles();
      }
      return;
    }

    this.bulkSelectionActive = false;
    this.hideStatusBanner();
    this.recalculateDirectorySelection();
    if (this.virtualScroller) {
      const flattened = this.flattenNodes(this.props.nodes ?? []);
      this.virtualScroller.setItems(flattened);
    } else {
      this.updateSelectionStyles();
    }
  }

  setExpanded(expanded) {
    this.props.expandedPaths = expanded instanceof Set ? expanded : new Set(expanded ?? []);
    this.renderNodes(this.props.nodes);
  }

  renderNodes(nodes) {
    if (!Array.isArray(nodes)) {
      this.contentContainer.textContent = "";
      return;
    }

    if (nodes.length > VIRTUALIZATION_THRESHOLD) {
      this.setupVirtualScrolling(nodes);
    } else {
      this.teardownVirtualScrolling();
      const fragment = this.renderNodeList(nodes, 0);
      this.contentContainer.replaceChildren(fragment);
    }
  }

  setupVirtualScrolling(nodes) {
    if (!this.virtualScroller) {
      this.virtualScroller = new VirtualScroller(this.contentContainer, {
        itemHeight: 28,
        bufferSize: 20,
        renderItem: (item) => this.renderVirtualNode(item)
      });
    }
    const flattened = this.flattenNodes(nodes);
    this.virtualScroller.setItems(flattened);
  }

  teardownVirtualScrolling() {
    if (this.virtualScroller) {
      this.virtualScroller.destroy();
      this.virtualScroller = null;
    }
  }

  flattenNodes(nodes, depth = 0, acc = []) {
    for (const node of nodes) {
      acc.push({ node, depth });
      if (node.type === "directory" && this.props.expandedPaths.has(node.relPath) && Array.isArray(node.children)) {
        this.flattenNodes(node.children, depth + 1, acc);
      }
    }
    return acc;
  }

  renderVirtualNode(item) {
    if (!item || !item.node) {
      return DOMNodes.createElement("div");
    }
    const element = DOMNodes.createFileNode(item.node, {
      depth: item.depth,
      selectedFiles: this.props.selectedFiles,
      expandedPaths: this.props.expandedPaths,
      showMetadata: true
    });
    return element;
  }

  renderNodeList(nodes, depth) {
    const fragment = document.createDocumentFragment();
    for (const node of nodes) {
      const element = DOMNodes.createFileNode(node, {
        depth,
        selectedFiles: this.props.selectedFiles,
        expandedPaths: this.props.expandedPaths,
        showMetadata: true
      });
      fragment.appendChild(element);
      if (node.type === "directory" && this.props.expandedPaths.has(node.relPath) && Array.isArray(node.children)) {
        const children = this.renderNodeList(node.children, depth + 1);
        fragment.appendChild(children);
      }
    }
    return fragment;
  }

  updateSelectionStyles() {
    const checkboxes = this.element.querySelectorAll("input.file-checkbox");
    checkboxes.forEach((cb) => {
      const nodeElement = cb.closest(".file-node");
      const path = nodeElement?.dataset.path;
      if (!path) {
        cb.checked = false;
        return;
      }
      if (nodeElement?.dataset.type === "directory") {
        cb.checked = this.selectedDirectories.has(path);
      } else {
        cb.checked = this.props.selectedFiles.has(path);
      }
    });
  }

  handleTreeClick(event) {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    const action = target.closest(".file-tree-action");
    if (action) {
      const actionId = action.dataset.action;
      this.handleAction(actionId);
      return;
    }

    const expandButton = target.closest(".expand-btn");
    if (expandButton) {
      const nodeElement = expandButton.closest(".file-node");
      if (!nodeElement) {
        return;
      }
      const path = nodeElement.dataset.path;
      if (path) {
        this.toggleExpand(path);
      }
      return;
    }

    const checkbox = target.closest(".file-checkbox");
    if (checkbox) {
      const nodeElement = checkbox.closest(".file-node");
      const path = nodeElement?.dataset.path;
      if (!path) {
        return;
      }
      const nodeType = nodeElement?.dataset.type ?? "file";
      this.toggleSelection(path, checkbox.checked, event.shiftKey, nodeType);
      event.stopPropagation();
      return;
    }

    const nodeElement = target.closest(".file-node");
    if (nodeElement) {
      const path = nodeElement.dataset.path;
      if (path) {
        this.focusNode(nodeElement);
        if (nodeElement.dataset.type === "file") {
          this.props.onOpen(path);
        } else {
          this.toggleExpand(path);
        }
      }
    }
  }

  handleAction(actionId) {
    switch (actionId) {
      case "select-all":
        this.props.onSelectionCommand({ type: "select-all" });
        break;
      case "clear-selection":
        this.props.onSelectionCommand({ type: "clear" });
        break;
      default:
        break;
    }
  }

  handleKeydown(event) {
    const focusNode = this.getFocusedNode();
    switch (event.key) {
      case "ArrowUp":
        event.preventDefault();
        this.focusSibling(focusNode, -1);
        break;
      case "ArrowDown":
        event.preventDefault();
        this.focusSibling(focusNode, 1);
        break;
      case "ArrowLeft":
        event.preventDefault();
        this.collapseOrFocusParent(focusNode);
        break;
      case "ArrowRight":
        event.preventDefault();
        this.expandOrFocusChild(focusNode);
        break;
      case " ":
      case "Enter":
        event.preventDefault();
        if (focusNode) {
          const path = focusNode.dataset.path;
          if (!path) {
            break;
          }
          if (event.key === "Enter") {
            if (focusNode.dataset.type === "file") {
              this.props.onOpen(path);
            } else {
              this.toggleExpand(path);
            }
          } else {
            const checkbox = focusNode.querySelector(".file-checkbox");
            if (checkbox) {
              checkbox.checked = !checkbox.checked;
              const nodeType = focusNode.dataset.type ?? "file";
              this.toggleSelection(path, checkbox.checked, event.shiftKey, nodeType);
            }
          }
        }
        break;
      default:
        break;
    }
  }

  handleDragStart(event) {
    const node = event.target instanceof HTMLElement ? event.target.closest(".file-node") : null;
    if (!node || !event.dataTransfer) {
      return;
    }
    const path = node.dataset.path;
    if (!path) {
      return;
    }
    this.dragState = { path };
    event.dataTransfer.setData("text/uri-list", sanitizeText(path));
    event.dataTransfer.effectAllowed = "copy";
  }

  handleDragOver(event) {
    if (!this.dragState) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }

  handleDrop(event) {
    if (!this.dragState) {
      return;
    }
    event.preventDefault();
    this.dragState = null;
  }

  toggleSelection(path, isSelected, useRange, nodeType = "file") {
    if (useRange) {
      this.props.onRangeSelect(path);
      return;
    }
    if (nodeType === "directory") {
      if (isSelected) {
        this.selectedDirectories.add(path);
      } else {
        this.selectedDirectories.delete(path);
      }
      const node = this.findNode(path, this.props.nodes ?? []);
      if (node) {
        const descendants = this.collectDescendantFiles(node);
        for (const descendant of descendants) {
          if (isSelected) {
            this.props.selectedFiles.add(descendant);
          } else {
            this.props.selectedFiles.delete(descendant);
          }
          this.props.onToggleSelection({ path: descendant, selected: isSelected });
        }
      }
    } else {
      if (isSelected) {
        this.props.selectedFiles.add(path);
      } else {
        this.props.selectedFiles.delete(path);
      }
      this.props.onToggleSelection({ path, selected: isSelected });
    }

    if (this.virtualScroller) {
      const flattened = this.flattenNodes(this.props.nodes ?? []);
      this.virtualScroller.setItems(flattened);
    } else {
      this.updateSelectionStyles();
    }
  }

  toggleExpand(path) {
    this.props.onToggleExpand({ path });
    if (this.props.expandedPaths.has(path)) {
      this.props.expandedPaths.delete(path);
    } else {
      this.props.expandedPaths.add(path);
    }
    this.renderNodes(this.props.nodes);
  }

  getFocusedNode() {
    if (this.focusedPath) {
      return this.element.querySelector(`.file-node[data-path="${escapeSelector(this.focusedPath)}"]`);
    }
    return this.element.querySelector(".file-node[tabindex='0']") ?? this.element.querySelector(".file-node");
  }

  focusNode(node) {
    if (!node) {
      return;
    }
    this.element.querySelectorAll(".file-node").forEach((el) => {
      el.tabIndex = -1;
    });
    node.tabIndex = 0;
    this.focusedPath = node.dataset.path ?? null;
    DOMNodes.focusElement(node);
  }

  focusSibling(current, offset) {
    const nodes = Array.from(this.element.querySelectorAll(".file-node"));
    if (!nodes.length) {
      return;
    }
    const index = Math.max(0, nodes.indexOf(current));
    const nextIndex = Math.min(nodes.length - 1, index + offset);
    this.focusNode(nodes[nextIndex]);
  }

  collapseOrFocusParent(node) {
    if (!node) {
      return;
    }
    const path = node.dataset.path;
    if (!path) {
      return;
    }
    if (node.dataset.type === "directory" && this.props.expandedPaths.has(path)) {
      this.toggleExpand(path);
      return;
    }
    const parentDepth = Number(node.dataset.depth ?? 0) - 1;
    if (parentDepth < 0) {
      return;
    }
    let previous = node.previousElementSibling;
    while (previous) {
      const depth = Number(previous.dataset.depth ?? 0);
      if (depth === parentDepth) {
        this.focusNode(previous);
        return;
      }
      if (depth < parentDepth) {
        break;
      }
      previous = previous.previousElementSibling;
    }
  }

  expandOrFocusChild(node) {
    if (!node) {
      return;
    }
    const path = node.dataset.path;
    if (!path) {
      return;
    }
    if (node.dataset.type === "directory") {
      if (!this.props.expandedPaths.has(path)) {
        this.toggleExpand(path);
        return;
      }
      const next = node.nextElementSibling;
      if (next && Number(next.dataset.depth ?? 0) === Number(node.dataset.depth ?? 0) + 1) {
        this.focusNode(next);
      }
    }
  }

  recalculateDirectorySelection() {
    if (this.selectionRecalcHandle !== null) {
      clearTimeout(this.selectionRecalcHandle);
      this.selectionRecalcHandle = null;
    }
    this.selectedDirectories.clear();

    const evaluateNode = (node) => {
      if (!node) {
        return { allSelected: true, hasFiles: false };
      }
      const relPath = node.relPath ?? node.uri ?? node.path;
      if (node.type === "directory") {
        if (relPath && this.props.selectedFiles.has(relPath)) {
          this.selectedDirectories.add(relPath);
          return { allSelected: true, hasFiles: true };
        }
        if (!Array.isArray(node.children) || node.children.length === 0) {
          return { allSelected: true, hasFiles: false };
        }
      }

      if (node.type !== "directory" || !Array.isArray(node.children) || node.children.length === 0) {
        const isFile = node.type !== "directory";
        if (!isFile || !relPath) {
          return { allSelected: true, hasFiles: false };
        }
        return {
          allSelected: this.props.selectedFiles.has(relPath),
          hasFiles: true
        };
      }

      let allSelected = true;
      let hasFiles = false;
      for (const child of node.children) {
        const result = evaluateNode(child);
        if (result.hasFiles) {
          hasFiles = true;
          if (!result.allSelected) {
            allSelected = false;
          }
        }
      }

      if (hasFiles && allSelected && relPath) {
        this.selectedDirectories.add(relPath);
      }

      return { allSelected, hasFiles };
    };

    for (const rootNode of this.props.nodes ?? []) {
      evaluateNode(rootNode);
    }

    this.updateSelectionStyles();
    this.bulkSelectionActive = false;
    this.hideStatusBanner();
  }

  showStatusBanner(message, variant = "info", autoHideMs) {
    if (!this.statusBanner) {
      return;
    }
    if (this.statusBannerHideHandle !== null) {
      clearTimeout(this.statusBannerHideHandle);
      this.statusBannerHideHandle = null;
    }
    const safeMessage = typeof message === "string" && message.trim().length > 0 ? message.trim() : "";
    const variantClass = typeof variant === "string" && variant.length > 0 ? ` file-tree-status--${variant}` : "";
    this.statusBanner.className = `file-tree-status${variantClass}`;
    this.statusBanner.textContent = safeMessage;
    if (!safeMessage) {
      this.statusBanner.setAttribute("hidden", "true");
    } else {
      this.statusBanner.removeAttribute("hidden");
    }
    if (typeof autoHideMs === "number" && Number.isFinite(autoHideMs) && autoHideMs > 0) {
      this.statusBannerHideHandle = setTimeout(() => {
        this.statusBannerHideHandle = null;
        this.hideStatusBanner();
      }, autoHideMs);
    }
  }

  hideStatusBanner() {
    if (!this.statusBanner) {
      return;
    }
    if (this.statusBannerHideHandle !== null) {
      clearTimeout(this.statusBannerHideHandle);
      this.statusBannerHideHandle = null;
    }
    this.statusBanner.textContent = "";
    this.statusBanner.className = "file-tree-status";
    this.statusBanner.setAttribute("hidden", "true");
  }

  destroy() {
    if (this.selectionRecalcHandle !== null) {
      clearTimeout(this.selectionRecalcHandle);
      this.selectionRecalcHandle = null;
    }
    this.hideStatusBanner();
    this.teardownVirtualScrolling();
    this.detachEventListeners();
  }

  findNode(path, nodes) {
    for (const node of nodes) {
      if (!node) {
        continue;
      }
      const relPath = node.relPath ?? node.uri ?? node.path;
      if (relPath === path) {
        return node;
      }
      if (Array.isArray(node.children)) {
        const match = this.findNode(path, node.children);
        if (match) {
          return match;
        }
      }
    }
    return null;
  }

  collectDescendantFiles(node, acc = []) {
    if (!node || !Array.isArray(node.children)) {
      return acc;
    }
    for (const child of node.children) {
      if (!child) {
        continue;
      }
      const relPath = child.relPath ?? child.uri ?? child.path;
      if (child.type === "directory") {
        this.collectDescendantFiles(child, acc);
      } else if (relPath) {
        acc.push(relPath);
      }
    }
    return acc;
  }

  collectDirectoryPaths(nodes, acc = []) {
    if (!Array.isArray(nodes)) {
      return acc;
    }
    for (const node of nodes) {
      if (!node) {
        continue;
      }
      if (node.type === "directory") {
        const relPath = node.relPath ?? node.uri ?? node.path;
        if (relPath) {
          acc.push(relPath);
        }
        if (Array.isArray(node.children)) {
          this.collectDirectoryPaths(node.children, acc);
        }
      }
    }
    return acc;
  }

  countFiles(nodes) {
    if (!Array.isArray(nodes)) {
      return 0;
    }
    let total = 0;
    for (const node of nodes) {
      if (!node) {
        continue;
      }
      if (node.type === "directory") {
        total += this.countFiles(node.children ?? []);
      } else {
        total += 1;
      }
    }
    return total;
  }

  scheduleDirectoryRecalc() {
    if (this.selectionRecalcHandle !== null) {
      clearTimeout(this.selectionRecalcHandle);
    }
    this.bulkSelectionActive = true;
    this.selectionRecalcHandle = setTimeout(() => {
      this.selectionRecalcHandle = null;
      this.recalculateDirectorySelection();
    }, 50);
  }
}
