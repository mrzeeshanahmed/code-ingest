import { createStore } from "./store.js";
import { commandRegistry } from "./commandRegistry.js";

const vscode = acquireVsCodeApi();

const initialState = {
  tree: [],
  preview: {
    title: "Awaiting Selection",
    subtitle: "Select files from the tree to generate a live digest preview.",
    content: ""
  },
  status: "idle"
};

const store = createStore(initialState);

function renderFileTree(state) {
  const treeContainer = document.querySelector(".tree");
  if (!treeContainer) {
    return;
  }

  treeContainer.innerHTML = "";

  if (!state.tree || state.tree.length === 0) {
    const emptyNode = document.createElement("li");
    emptyNode.className = "empty-state";
    emptyNode.setAttribute("role", "treeitem");
    emptyNode.setAttribute("aria-disabled", "true");
    emptyNode.textContent = "No files selected yet.";
    treeContainer.appendChild(emptyNode);
    return;
  }

  for (const node of state.tree) {
    treeContainer.appendChild(createTreeItem(node));
  }
}

function createTreeItem(node) {
  const li = document.createElement("li");
  li.setAttribute("role", "treeitem");
  li.dataset.uri = node.uri;
  li.className = "tree-item";

  const label = document.createElement("div");
  label.className = "tree-item__label";
  label.textContent = node.name;

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = Boolean(node.selected);
  checkbox.dataset.uri = node.uri;
  checkbox.addEventListener("change", (event) => {
    const uri = event.currentTarget.dataset.uri;
    vscode.postMessage({ type: "command", command: "toggleSelection", payload: { uri } });
  });

  label.prepend(checkbox);
  li.appendChild(label);

  if (node.children && node.children.length > 0) {
    li.classList.add("tree-item--directory");

    const toggleButton = document.createElement("button");
    toggleButton.type = "button";
    toggleButton.className = "tree-item__toggle";
    toggleButton.textContent = node.expanded ? "▾" : "▸";
    toggleButton.addEventListener("click", () => {
      vscode.postMessage({ type: "command", command: "toggleExpand", payload: { uri: node.uri } });
    });

    label.prepend(toggleButton);

    const childList = document.createElement("ul");
    childList.setAttribute("role", "group");
    childList.className = "tree";

    for (const child of node.children) {
      childList.appendChild(createTreeItem(child));
    }

    if (!node.expanded) {
      childList.style.display = "none";
    }

    li.appendChild(childList);
  }

  return li;
}

function renderPreview(state) {
  const preview = document.querySelector(".preview");
  const title = preview?.querySelector(".preview__title");
  const subtitle = preview?.querySelector(".preview__subtitle");
  const content = preview?.querySelector(".preview__content");

  if (!preview || !title || !subtitle || !content) {
    return;
  }

  if (!state.preview) {
    return;
  }

  title.textContent = state.preview.title;
  subtitle.textContent = state.preview.subtitle;
  content.textContent = state.preview.content;
}

store.subscribe((state) => {
  renderFileTree(state);
  renderPreview(state);
});

window.addEventListener("message", (event) => {
  const message = event.data;
  if (!message) {
    return;
  }

  switch (message.type) {
    case "state:update": {
      store.setState(message.payload || {});
      break;
    }
    case "state:patch": {
      store.setState((current) => ({ ...current, ...message.payload }));
      break;
    }
    default: {
      console.warn("Unknown message type", message.type);
    }
  }
});

commandRegistry.register("refresh", () => {
  vscode.postMessage({ type: "command", command: "refresh" });
});

commandRegistry.register("generateDigest", () => {
  vscode.postMessage({ type: "command", command: "generateDigest" });
});

const refreshButton = document.querySelector('[data-action="refresh"]');
refreshButton?.addEventListener("click", () => {
  commandRegistry.dispatch("refresh");
});

const generateButton = document.querySelector('[data-action="generate"]');
generateButton?.addEventListener("click", () => {
  commandRegistry.dispatch("generateDigest");
});

const expandAllButton = document.querySelector('[data-action="expand-all"]');
expandAllButton?.addEventListener("click", () => {
  vscode.postMessage({ type: "command", command: "expandAll" });
});

const collapseAllButton = document.querySelector('[data-action="collapse-all"]');
collapseAllButton?.addEventListener("click", () => {
  vscode.postMessage({ type: "command", command: "collapseAll" });
});

const refreshPreviewButton = document.querySelector('[data-action="refresh-preview"]');
refreshPreviewButton?.addEventListener("click", () => {
  vscode.postMessage({ type: "command", command: "refreshPreview" });
});

window.addEventListener("DOMContentLoaded", () => {
  vscode.postMessage({ type: "command", command: "webviewReady" });
});
