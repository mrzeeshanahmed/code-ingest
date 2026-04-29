/*
 * Follow instructions in copilot-instructions.md exactly.
 */

import { DOMNodes } from "../nodes.js";
import { VirtualScroller } from "../virtualScroller.js";
import { sanitizeText } from "../utils/sanitizers.js";

const NODE_THRESHOLD = 100;

export class PreviewComponent {
  constructor(props = {}) {
    this.props = {
      onOpenFile: typeof props.onOpenFile === "function" ? props.onOpenFile : () => {},
      onCopyPreview: typeof props.onCopyPreview === "function" ? props.onCopyPreview : () => {},
      onRequestFullContent: typeof props.onRequestFullContent === "function" ? props.onRequestFullContent : () => {}
    };
    this.state = {
      previewId: null,
      nodes: [],
      summary: "",
      text: "",
      html: ""
    };

    this.element = DOMNodes.createElement("section", {
      className: "preview-panel",
      role: "region",
      ariaLabel: "Preview"
    });

  this.header = this.createHeader();
    this.element.appendChild(this.header);

    this.contentContainer = DOMNodes.createElement("div", {
      className: "preview-content",
      role: "presentation"
    });
    this.previewText = DOMNodes.createElement("div", { className: "preview-text" });
    this.nodesContainer = DOMNodes.createElement("div", { className: "preview-nodes" });
    this.contentContainer.appendChild(this.previewText);
    this.contentContainer.appendChild(this.nodesContainer);
    this.element.appendChild(this.contentContainer);

    this.footer = DOMNodes.createElement("div", { className: "preview-footer" });
    this.footerMessage = DOMNodes.createElement("span", { className: "preview-footer-message" });
    this.footer.appendChild(this.footerMessage);
    this.element.appendChild(this.footer);

    this.virtualScroller = null;
  }

  createHeader() {
    const header = DOMNodes.createElement("header", { className: "preview-header" });
    this.titleText = DOMNodes.createElement("h2", { className: "preview-title", textContent: "Preview" });
    header.appendChild(this.titleText);

    this.subtitleText = DOMNodes.createElement("p", { className: "preview-subtitle" });
    header.appendChild(this.subtitleText);

  const metaBar = DOMNodes.createElement("div", { className: "preview-meta" });

  this.tokenBadge = DOMNodes.createElement("span", { className: "preview-token-badge" });
  metaBar.appendChild(this.tokenBadge);

  const actions = DOMNodes.createElement("div", { className: "preview-actions", role: "group", ariaLabel: "Preview actions" });
    const copyButton = DOMNodes.createElement("button", {
      className: "preview-action",
      type: "button",
      textContent: "Copy",
      ariaLabel: "Copy preview"
    });
    copyButton.addEventListener("click", () => this.props.onCopyPreview(this.state));
    actions.appendChild(copyButton);

    const expandButton = DOMNodes.createElement("button", {
      className: "preview-action",
      type: "button",
      textContent: "Expand",
      ariaLabel: "Request full content"
    });
    expandButton.addEventListener("click", () => this.props.onRequestFullContent(this.state.previewId));
    actions.appendChild(expandButton);

    metaBar.appendChild(actions);
    header.appendChild(metaBar);
    return header;
  }

  updatePreview(preview) {
    if (!preview || typeof preview !== "object") {
      this.clear();
      return;
    }

    this.state.previewId = preview.previewId ?? null;
    this.state.summary = sanitizeText(preview.summary ?? "");
    this.state.text = sanitizeText(preview.previewText ?? preview.previewMarkdown ?? preview.preview ?? "");
    this.state.html = sanitizeText(preview.previewHtml ?? "");
    this.state.nodes = Array.isArray(preview.nodes) ? preview.nodes : [];

    if (preview.title) {
      this.titleText.textContent = sanitizeText(preview.title);
    }
    if (preview.subtitle) {
      this.subtitleText.textContent = sanitizeText(preview.subtitle);
      this.subtitleText.classList.remove("is-hidden");
    } else {
      this.subtitleText.textContent = "";
      this.subtitleText.classList.add("is-hidden");
    }

    this.renderSummary();
    this.renderNodes();
    this.renderFooter(preview.metadata);
  }

  renderSummary() {
    const fragment = document.createDocumentFragment();
    if (this.state.summary) {
      fragment.appendChild(DOMNodes.createElement("p", { className: "preview-summary", textContent: this.state.summary }));
    }
    if (this.state.text) {
      fragment.appendChild(DOMNodes.createElement("pre", {
        className: "preview-snippet",
        textContent: this.state.text
      }));
    }
    this.previewText.replaceChildren(fragment);
  }

  renderNodes() {
    if (!this.state.nodes.length) {
      this.nodesContainer.textContent = "";
      this.teardownVirtualScroller();
      return;
    }

    if (this.state.nodes.length > NODE_THRESHOLD) {
      this.setupVirtualScroller(this.state.nodes);
    } else {
      this.teardownVirtualScroller();
      const fragment = document.createDocumentFragment();
      for (const item of this.state.nodes) {
        fragment.appendChild(this.renderPreviewNode(item));
      }
      this.nodesContainer.replaceChildren(fragment);
    }
  }

  setupVirtualScroller(nodes) {
    if (!this.virtualScroller) {
      this.virtualScroller = new VirtualScroller(this.nodesContainer, {
        itemHeight: 48,
        bufferSize: 15,
        renderItem: (entry) => this.renderPreviewNode(entry)
      });
    }
    this.virtualScroller.setItems(nodes);
  }

  teardownVirtualScroller() {
    if (this.virtualScroller) {
      this.virtualScroller.destroy();
      this.virtualScroller = null;
    }
  }

  renderPreviewNode(node) {
    if (!node || typeof node !== "object") {
      return DOMNodes.createElement("div", { className: "preview-node" });
    }
  const originalPath = typeof node.path === "string" ? node.path : "";
  const path = sanitizeText(originalPath);
    const snippet = sanitizeText(node.snippet ?? "");
    const truncated = Boolean(node.truncated);

    const row = DOMNodes.createElement("article", {
      className: "preview-node",
      role: "button",
  tabIndex: 0,
  "data-path": path
    });

    const header = DOMNodes.createElement("header", { className: "preview-node-header" });
    header.appendChild(DOMNodes.createElement("span", { className: "preview-node-path", textContent: path }));
    if (truncated) {
      header.appendChild(DOMNodes.createElement("span", { className: "preview-node-truncated", textContent: "…" }));
    }
    row.appendChild(header);

    if (snippet) {
      row.appendChild(DOMNodes.createElement("pre", { className: "preview-node-snippet", textContent: snippet }));
    }

    row.addEventListener("click", () => this.props.onOpenFile(originalPath));
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        this.props.onOpenFile(originalPath);
      }
    });
    return row;
  }

  renderFooter(metadata) {
    if (!metadata || typeof metadata !== "object") {
      this.footerMessage.textContent = "";
      return;
    }
    const parts = Object.entries(metadata)
      .map(([key, value]) => `${sanitizeText(key)}: ${sanitizeText(value)}`)
      .slice(0, 5);
    this.footerMessage.textContent = parts.join(" • ");
  }

  applyDelta(changes) {
    if (!Array.isArray(changes) || changes.length === 0) {
      return;
    }
    let text = this.state.text ?? "";
    for (const change of changes) {
      const type = change?.changeType ?? change?.op ?? "update";
      const content = sanitizeText(change?.content ?? "", { maxLength: 200_000 });
      if (type === "append") {
        text += content;
      } else if (type === "remove") {
        text = "";
      } else {
        text = content;
      }
    }
    this.state.text = text;
    this.renderSummary();
  }

  clear() {
    this.previewText.textContent = "";
    this.nodesContainer.textContent = "";
    this.footerMessage.textContent = "";
    this.titleText.textContent = "Preview";
    this.subtitleText.textContent = "";
    this.subtitleText.classList.add("is-hidden");
    this.tokenBadge.textContent = "";
  }

  setTokenCount(tokenInfo) {
    if (!tokenInfo || typeof tokenInfo !== "object") {
      this.tokenBadge.textContent = "";
      this.tokenBadge.classList.add("is-hidden");
      return;
    }
    const total = typeof tokenInfo.total === "number" ? tokenInfo.total : undefined;
    const approx = typeof tokenInfo.approx === "number" ? tokenInfo.approx : undefined;
    if (total != null) {
      this.tokenBadge.textContent = `${total.toLocaleString()} tokens`;
    } else if (approx != null) {
      this.tokenBadge.textContent = `~${approx.toLocaleString()} tokens`;
    } else {
      this.tokenBadge.textContent = "";
    }
    if (this.tokenBadge.textContent) {
      this.tokenBadge.classList.remove("is-hidden");
    } else {
      this.tokenBadge.classList.add("is-hidden");
    }
  }
}