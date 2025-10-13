/*
 * Follow instructions in copilot-instructions.md exactly.
 */

import { DOMNodes } from "../nodes.js";
import { VirtualScroller } from "../virtualScroller.js";
import { sanitizeText } from "../utils/sanitizers.js";

const VIRTUALIZATION_THRESHOLD = 150;
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
    this.recalculateDirectorySelection();
  }

  setSelection(selected) {
    this.props.selectedFiles = selected instanceof Set ? selected : new Set(selected ?? []);
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
  }

  destroy() {
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
}
