/*
 * Follow instructions in copilot-instructions.md exactly.
 */

import { clampNumber } from "./utils/sanitizers.js";

const RAF = typeof window !== "undefined" && window.requestAnimationFrame
  ? window.requestAnimationFrame.bind(window)
  : (callback) => setTimeout(callback, 16);

export class VirtualScroller {
  constructor(container, options = {}) {
    if (!container) {
      throw new Error("VirtualScroller requires a container element");
    }
    this.container = container;
    this.items = [];
    this.itemHeight = clampNumber(options.itemHeight, { defaultValue: 28, min: 20, max: 72 }) ?? 28;
    this.bufferSize = clampNumber(options.bufferSize, { defaultValue: 10, min: 0, max: 200 }) ?? 10;
    this.renderItem = typeof options.renderItem === "function" ? options.renderItem : () => document.createElement("div");
    this.onRangeChanged = typeof options.onRangeChanged === "function" ? options.onRangeChanged : undefined;
    this.getItemKey = typeof options.getItemKey === "function" ? options.getItemKey : (item, index) => `${index}`;

    this.scrollRoot = document.createElement("div");
    this.scrollRoot.className = "virtual-scroll-root";
    this.placeholderSpacer = document.createElement("div");
    this.placeholderSpacer.className = "virtual-scroll-spacer";
    this.visibleContainer = document.createElement("div");
    this.visibleContainer.className = "virtual-scroll-visible";
  this.visibleContainer.style.position = "relative";

    this.scrollRoot.appendChild(this.placeholderSpacer);
    this.scrollRoot.appendChild(this.visibleContainer);
    this.container.innerHTML = "";
    this.container.appendChild(this.scrollRoot);

    this.scrollHandler = this.handleScroll.bind(this);
    this.resizeObserver = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => this.scheduleUpdate()) : null;
    this.container.addEventListener("scroll", this.scrollHandler, { passive: true });
    if (this.resizeObserver) {
      this.resizeObserver.observe(this.container);
    }

    this.height = 0;
    this.firstRenderedIndex = 0;
    this.lastRenderedIndex = -1;
    this.pendingFrame = null;
  }

  destroy() {
    this.container.removeEventListener("scroll", this.scrollHandler);
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
    }
    this.items = [];
    this.visibleContainer.innerHTML = "";
    this.placeholderSpacer.style.height = "0px";
    this.cancelFrame();
  }

  setItems(items = []) {
    this.items = Array.isArray(items) ? items : [];
    this.updateHeight();
    this.scheduleUpdate();
  }

  setRenderItem(renderItem) {
    if (typeof renderItem === "function") {
      this.renderItem = renderItem;
      this.scheduleUpdate();
    }
  }

  updateHeight() {
    this.height = this.items.length * this.itemHeight;
    this.placeholderSpacer.style.height = `${this.height}px`;
  }

  handleScroll() {
    this.scheduleUpdate();
  }

  scheduleUpdate() {
    if (this.pendingFrame !== null) {
      return;
    }
    this.pendingFrame = RAF(() => {
      this.pendingFrame = null;
      this.renderVisibleItems();
    });
  }

  cancelFrame() {
    if (this.pendingFrame === null) {
      return;
    }
    if (typeof window !== "undefined" && window.cancelAnimationFrame) {
      window.cancelAnimationFrame(this.pendingFrame);
    } else {
      clearTimeout(this.pendingFrame);
    }
    this.pendingFrame = null;
  }

  renderVisibleItems() {
    const scrollTop = this.container.scrollTop;
    const containerHeight = this.container.clientHeight || 0;
    const totalItems = this.items.length;
    if (totalItems === 0 || containerHeight === 0) {
      this.visibleContainer.innerHTML = "";
      this.firstRenderedIndex = 0;
      this.lastRenderedIndex = -1;
      return;
    }

    const firstVisibleIndex = Math.max(Math.floor(scrollTop / this.itemHeight) - this.bufferSize, 0);
    const itemsInView = Math.ceil(containerHeight / this.itemHeight) + this.bufferSize * 2;
    const lastVisibleIndex = Math.min(firstVisibleIndex + itemsInView, totalItems);

    if (firstVisibleIndex === this.firstRenderedIndex && lastVisibleIndex === this.lastRenderedIndex) {
      return;
    }

    this.firstRenderedIndex = firstVisibleIndex;
    this.lastRenderedIndex = lastVisibleIndex;

    const fragment = document.createDocumentFragment();
    for (let index = firstVisibleIndex; index < lastVisibleIndex; index += 1) {
      const item = this.items[index];
      const node = this.renderItem(item, index);
      if (node) {
        node.style.position = "absolute";
        node.style.top = `${index * this.itemHeight}px`;
        node.style.left = "0";
        node.style.right = "0";
        fragment.appendChild(node);
      }
    }

    this.visibleContainer.innerHTML = "";
    this.visibleContainer.appendChild(fragment);

    if (this.onRangeChanged) {
      this.onRangeChanged({ start: firstVisibleIndex, end: lastVisibleIndex });
    }
  }
}
