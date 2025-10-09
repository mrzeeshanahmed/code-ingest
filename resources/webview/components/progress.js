/*
 * Follow instructions in copilot-instructions.md exactly.
 */

import { sanitizeText, clampNumber } from "../utils/sanitizers.js";

const PHASE_LABELS = Object.freeze({
  scan: "Scanning files",
  filter: "Filtering",
  tokenize: "Tokenizing",
  ingest: "Ingesting",
  write: "Writing output"
});

export class ProgressComponent {
  constructor(props = {}) {
    this.props = {
      progress: props.progress ?? { phase: "scan", percent: 0 },
      onCancel: typeof props.onCancel === "function" ? props.onCancel : () => {},
      autoHide: props.autoHide !== false
    };
    this.visible = false;

    this.element = document.createElement("section");
    this.element.className = "progress-panel";
    this.element.setAttribute("role", "status");
    this.element.setAttribute("aria-live", "polite");
    this.element.setAttribute("aria-atomic", "true");

    this.title = document.createElement("h2");
    this.title.className = "progress-title";
    this.element.appendChild(this.title);

    this.message = document.createElement("p");
    this.message.className = "progress-message";
    this.element.appendChild(this.message);

    this.barContainer = document.createElement("div");
    this.barContainer.className = "progress-bar-container";
    this.barContainer.setAttribute("role", "progressbar");
    this.barContainer.setAttribute("aria-valuemin", "0");
    this.barContainer.setAttribute("aria-valuemax", "100");

    this.bar = document.createElement("div");
    this.bar.className = "progress-bar";
    this.barContainer.appendChild(this.bar);
    this.element.appendChild(this.barContainer);

    this.actions = document.createElement("div");
    this.actions.className = "progress-actions";
    this.cancelButton = document.createElement("button");
    this.cancelButton.type = "button";
    this.cancelButton.textContent = "Cancel";
    this.cancelButton.className = "progress-cancel";
    this.cancelButton.addEventListener("click", () => this.props.onCancel());
    this.actions.appendChild(this.cancelButton);
    this.element.appendChild(this.actions);

    this.update(this.props.progress);
  }

  update(progress) {
    if (!progress || typeof progress !== "object") {
      return;
    }
    const phase = sanitizeText(progress.phase ?? this.props.progress.phase ?? "scan");
    const label = PHASE_LABELS[phase] ?? sanitizeText(progress.label ?? "Processing");
    this.title.textContent = label;

    const percent = clampNumber(progress.percent, { min: 0, max: 100, defaultValue: undefined });
    if (typeof percent === "number") {
      this.bar.style.width = `${percent}%`;
      this.barContainer.setAttribute("aria-valuenow", String(Math.round(percent)));
    } else {
      this.bar.style.width = "0";
      this.barContainer.removeAttribute("aria-valuenow");
    }

    const message = sanitizeText(progress.message ?? "");
    this.message.textContent = message;

    const busy = Boolean(progress.busy);
    if (busy) {
      this.element.classList.add("is-busy");
    } else {
      this.element.classList.remove("is-busy");
    }

    if (busy || percent === undefined || percent < 100) {
      this.show();
    } else if (this.props.autoHide) {
      this.hideWithDelay();
    }

    this.props.progress = { phase, percent, message, busy };
  }

  setBusy(isBusy) {
    this.update({ ...this.props.progress, busy: isBusy });
  }

  setMessage(message) {
    this.update({ ...this.props.progress, message });
  }

  show() {
    if (this.visible) {
      return;
    }
    this.visible = true;
    this.element.classList.remove("is-hidden");
  }

  hide() {
    this.visible = false;
    this.element.classList.add("is-hidden");
  }

  hideWithDelay() {
    window.setTimeout(() => this.hide(), 800);
  }

  setOnCancel(handler) {
    if (typeof handler === "function") {
      this.props.onCancel = handler;
    }
  }
}
