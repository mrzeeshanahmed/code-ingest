/*
 * Follow instructions in copilot-instructions.md exactly.
 */

import { sanitizeRecord, sanitizeText } from "./utils/sanitizers.js";

const FILE_ICON_MAP = Object.freeze({
  js: "javascript",
  ts: "typescript",
  tsx: "typescript",
  jsx: "javascript",
  py: "python",
  md: "markdown",
  json: "json",
  html: "html",
  css: "css",
  scss: "css",
  ipynb: "jupyter",
  yaml: "yaml",
  yml: "yaml"
});

const FILE_ICON_SYMBOLS = Object.freeze({
  folder: "📁",
  javascript: "🟨",
  typescript: "🟦",
  python: "🐍",
  markdown: "📝",
  json: "🗂️",
  html: "🌐",
  css: "🎨",
  yaml: "📄",
  jupyter: "📓",
  file: "📄"
});

export class DOMNodes {
  static createElement(tag, attributes = {}, children = []) {
    const element = document.createElement(tag);
    this.applyAttributes(element, attributes);
    this.appendChildren(element, children);
    return element;
  }

  static applyAttributes(element, attributes) {
    Object.entries(attributes).forEach(([key, value]) => {
      if (value === undefined || value === null) {
        return;
      }
      if (key === "className") {
        element.className = String(value);
      } else if (key === "textContent") {
        element.textContent = sanitizeText(String(value));
      } else if (key === "style" && typeof value === "object") {
        Object.assign(element.style, value);
      } else if (key.startsWith("aria-")) {
        element.setAttribute(key, String(value));
      } else if (key.startsWith("data-")) {
        element.setAttribute(key, String(value));
      } else if (key === "role") {
        element.setAttribute("role", String(value));
      } else if (key === "disabled") {
        element.toggleAttribute("disabled", Boolean(value));
      } else if (key === "tabIndex") {
        element.tabIndex = Number(value);
      } else if (key in element) {
        element[key] = value;
      } else {
        element.setAttribute(key, String(value));
      }
    });
  }

  static appendChildren(element, children) {
    for (const child of Array.isArray(children) ? children : [children]) {
      if (child === undefined || child === null) {
        continue;
      }
      if (typeof child === "string") {
        element.appendChild(document.createTextNode(sanitizeText(child)));
      } else if (child instanceof Node) {
        element.appendChild(child);
      } else if (Array.isArray(child)) {
        this.appendChildren(element, child);
      }
    }
  }

  static createIconSpan(file) {
    const iconClass = this.getFileIcon(file);
    const iconSymbol = FILE_ICON_SYMBOLS[iconClass] ?? FILE_ICON_SYMBOLS.file;
    return this.createElement("span", {
      className: `file-icon ${iconClass}`,
      textContent: iconSymbol,
      ariaHidden: "true"
    });
  }

  static createFileNode(file, options = {}) {
    const cleanedFile = sanitizeRecord(file ?? {});
    const depth = Number(options.depth ?? 0);
    const isSelected = options.selectedFiles?.has(cleanedFile.relPath) ?? false;
    const isExpanded = options.expandedPaths?.has(cleanedFile.relPath) ?? false;
    const hasChildren = cleanedFile.type === "directory" && Array.isArray(cleanedFile.children) && cleanedFile.children.length > 0;

    const nodeElement = this.createElement("div", {
      className: `file-node ${cleanedFile.type ?? "file"} ${isSelected ? "selected" : ""}`.trim(),
      role: "treeitem",
      ariaExpanded: cleanedFile.type === "directory" ? String(isExpanded) : undefined,
      ariaSelected: String(isSelected),
      tabIndex: options.tabIndex ?? -1,
      "data-path": cleanedFile.relPath,
      "data-type": cleanedFile.type,
      "data-depth": depth
    });

    if (cleanedFile.placeholder) {
      nodeElement.classList.add("is-placeholder");
      nodeElement.setAttribute("aria-disabled", "true");
    }

    const content = this.createElement("div", { className: "file-node-content" });
    if (depth > 0) {
      content.style.paddingLeft = `${depth * 16}px`;
    }

    if (hasChildren) {
      const expandBtn = this.createElement("button", {
        className: `expand-btn ${isExpanded ? "expanded" : ""}`,
        type: "button",
        ariaLabel: isExpanded ? "Collapse" : "Expand",
        ariaExpanded: String(isExpanded),
        tabIndex: -1
      }, this.getChevron(isExpanded));
      content.appendChild(expandBtn);
    } else {
      content.appendChild(this.createElement("span", { className: "expand-placeholder", ariaHidden: "true" }, ""));
    }

    const checkbox = this.createElement("input", {
      type: "checkbox",
      className: "file-checkbox",
      checked: isSelected,
      tabIndex: -1,
      ariaLabel: `Toggle selection for ${cleanedFile.name ?? cleanedFile.relPath}`
    });
    content.appendChild(checkbox);

    content.appendChild(this.createIconSpan(cleanedFile));

    const name = this.createElement("span", {
      className: "file-name",
      textContent: cleanedFile.name ?? cleanedFile.relPath ?? "Unnamed"
    });
    content.appendChild(name);

    if (options.showMetadata && cleanedFile.type === "file" && typeof cleanedFile.size === "number") {
      const metadata = this.createElement("span", {
        className: "file-metadata",
        textContent: this.formatFileSize(cleanedFile.size)
      });
      content.appendChild(metadata);
    }

    nodeElement.appendChild(content);
    return nodeElement;
  }

  static createCheckboxGroup(options) {
    const container = this.createElement("div", { className: "choice-group" });
    for (const choice of options.choices ?? []) {
      const id = `${options.idPrefix ?? "choice"}-${choice.value}`;
      const wrapper = this.createElement("label", { className: "choice-item", for: id });
      const input = this.createElement("input", {
        type: options.type ?? "checkbox",
        id,
        name: options.name,
        value: choice.value,
        checked: Boolean(choice.checked)
      });
      wrapper.appendChild(input);
      wrapper.appendChild(this.createElement("span", { textContent: choice.label }));
      container.appendChild(wrapper);
    }
    return container;
  }

  static focusElement(element) {
    if (!element) {
      return;
    }
    window.requestAnimationFrame(() => element.focus({ preventScroll: false }));
  }

  static getFileIcon(file) {
    if (!file) {
      return "file";
    }
    if (file.type === "directory") {
      return "folder";
    }
    const name = file.name ?? file.relPath ?? "";
    const ext = name.includes(".") ? name.split(".").pop()?.toLowerCase() : "";
    return FILE_ICON_MAP[ext] ?? "file";
  }

  static getFileIconSymbol(file) {
    const icon = this.getFileIcon(file);
    return FILE_ICON_SYMBOLS[icon] ?? FILE_ICON_SYMBOLS.file;
  }

  static formatFileSize(size) {
    if (typeof size !== "number" || Number.isNaN(size)) {
      return "";
    }
    const units = ["B", "KB", "MB", "GB", "TB"];
    let value = size;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
      value /= 1024;
      unitIndex += 1;
    }
    return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
  }
  static getChevron(expanded) {
    return expanded ? "▼" : "▶";
  }
}
