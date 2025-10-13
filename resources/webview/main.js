import { createStore } from "./store.js";
import { CommandRegistry } from "./commandRegistry.js";
import { HandlerRegistry } from "./handlers/handlerRegistry.js";
import { UIRenderer } from "./uiRenderer.js";
import { IngestPreviewHandler } from "./handlers/ingestPreviewHandler.js";
import { ProgressHandler } from "./handlers/progressHandler.js";
import { TreeDataHandler } from "./handlers/treeDataHandler.js";
import { ConfigHandler } from "./handlers/configHandler.js";
import { GenerationResultHandler } from "./handlers/generationResultHandler.js";
import { IngestErrorHandler } from "./handlers/ingestErrorHandler.js";
import { RemoteRepoLoadedHandler } from "./handlers/remoteRepoLoadedHandler.js";
import { RestoredStateHandler } from "./handlers/restoredStateHandler.js";
import { StateHandler } from "./handlers/stateHandler.js";
import { PreviewDeltaHandler } from "./handlers/previewDeltaHandler.js";
import { MessageEnvelope } from "./messageEnvelope.js";
import { COMMAND_MAP } from "./commandMap.js";
import { WebviewLogger } from "./logger.js";
import { WebviewErrorReporter } from "./errorReporter.js";
import { WebviewPerformanceMonitor } from "./performanceMonitor.js";
import { WebviewDebugUtils } from "./debugUtils.js";

const DEFAULT_STATE = {
  tree: [],
  selection: [],
  preview: {
    title: "Awaiting Selection",
    subtitle: "Select files from the tree to generate a live digest preview.",
    content: ""
  },
  progress: {
    phase: "idle",
    percent: 0,
    message: "Idle"
  },
  status: "idle",
  config: {}
};

export class WebviewApplication {
  constructor() {
    this.vscode = acquireVsCodeApi();
    window.vscode = this.vscode;

    const isTestEnv = window.__CODE_INGEST_TEST__ === true;

    this.isTestEnvironment = isTestEnv;

    if (isTestEnv) {
      this.logger = {
        info: () => {},
        debug: () => {},
        warn: () => {},
        error: () => {},
        log: () => {}
      };
      this.errorReporter = new WebviewErrorReporter(this.logger);
      this.performanceMonitor = {
        measureOperation: async (_name, operation) => Promise.resolve().then(operation),
        getPerformanceReport: () => ({ operationStats: {}, totalOperations: 0 })
      };
      this.debugUtils = null;
    } else {
      this.logger = new WebviewLogger({
        logLevel: "debug",
        enableConsole: true
      });

      this.errorReporter = new WebviewErrorReporter(this.logger);
      this.performanceMonitor = new WebviewPerformanceMonitor(this.errorReporter, this.logger);
      this.debugUtils = new WebviewDebugUtils(this.logger, this.errorReporter);
    }

    window.logger = this.logger;
    window.errorReporter = this.errorReporter;
    window.performanceMonitor = this.performanceMonitor;

    this._initializeBootConfig();
  }

  _initializeBootConfig() {
    const bootConfig = typeof window.__INITIAL_STATE__ === "object" && window.__INITIAL_STATE__ !== null ? window.__INITIAL_STATE__ : {};
    const bootState = typeof bootConfig.state === "object" && bootConfig.state !== null ? bootConfig.state : {};

    this.initialState = {
      ...DEFAULT_STATE,
      ...bootState,
      preview: { ...DEFAULT_STATE.preview, ...(bootState.preview ?? {}) },
      progress: { ...DEFAULT_STATE.progress, ...(bootState.progress ?? {}) }
    };

    this.sessionToken = typeof bootConfig.sessionToken === "string" && bootConfig.sessionToken.length > 0 ? bootConfig.sessionToken : undefined;
  }

  initialize() {
    this.logger.info("Webview application initializing");
    return this.performanceMonitor.measureOperation("initialization", () => {
      this.setupStore();
      this.setupRenderer();
      this.setupHandlers();
      this.setupCommandRegistry();
      this.setupMessageHandlers();
      this.setupActionButtons();
      this.setupLifecycleEvents();
    }).catch((error) => {
      this.errorReporter.reportError(error, { type: "initialization_failure" });
      throw error;
    });
  }

  setupStore() {
    this.store = createStore(this.initialState);
    window.store = this.store;
  }

  setupRenderer() {
    this.uiRenderer = new UIRenderer(document);
  }

  setupHandlers() {
    const handlerOptions = {
      postMessage: (payload) => this.vscode.postMessage(payload),
      log: this.logger
    };

    this.registry = new HandlerRegistry({
      logger: this.logger,
      fallbackHandler: (type) => this.logger.warn(`Unhandled message type: ${type}`)
    });

    const handlers = [
      new StateHandler(this.store, this.uiRenderer, handlerOptions),
      new TreeDataHandler(this.store, this.uiRenderer, handlerOptions),
      new IngestPreviewHandler(this.store, this.uiRenderer, handlerOptions),
      new PreviewDeltaHandler(this.store, this.uiRenderer, handlerOptions),
      new ProgressHandler(this.store, this.uiRenderer, handlerOptions),
      new ConfigHandler(this.store, this.uiRenderer, handlerOptions),
      new GenerationResultHandler(this.store, this.uiRenderer, handlerOptions),
      new IngestErrorHandler(this.store, this.uiRenderer, handlerOptions),
      new RemoteRepoLoadedHandler(this.store, this.uiRenderer, handlerOptions),
      new RestoredStateHandler(this.store, this.uiRenderer, handlerOptions)
    ];

    for (const handler of handlers) {
      const messageTypes = handler.messageTypes ? Array.from(handler.messageTypes) : [];
      if (messageTypes.length === 0) {
        this.logger.warn("Handler missing message type registration", handler);
        continue;
      }
      this.registry.register(messageTypes, handler);
    }
  }

  setupCommandRegistry() {
    const envelope = new MessageEnvelope({ sessionToken: this.sessionToken });

    this.commandRegistry = new CommandRegistry({
      postMessage: (payload) => this.vscode.postMessage(payload),
      logger: this.logger,
      envelope,
      acknowledgeTimeout: 120000
    });

    const inboundCommandBindings = new Map([
      [COMMAND_MAP.HOST_TO_WEBVIEW.UPDATE_PREVIEW, "ingestPreview"],
      [COMMAND_MAP.HOST_TO_WEBVIEW.UPDATE_PROGRESS, "progress"],
      [COMMAND_MAP.HOST_TO_WEBVIEW.UPDATE_TREE_DATA, "treeData"],
      [COMMAND_MAP.HOST_TO_WEBVIEW.UPDATE_CONFIG, "config"],
      [COMMAND_MAP.HOST_TO_WEBVIEW.SHOW_ERROR, "ingestError"],
      [COMMAND_MAP.HOST_TO_WEBVIEW.RESTORE_STATE, "restoredState"]
    ]);

    for (const [commandId, messageType] of inboundCommandBindings) {
      this.commandRegistry.register(commandId, (payload) => this._processMessage(messageType, payload));
    }

    const outboundRegistrations = [
      { key: "GENERATE_DIGEST", options: { requiresAck: true } },
      { key: "LOAD_REMOTE_REPO", options: { requiresAck: true } },
      { key: "SELECT_ALL_FILES" },
      { key: "TOGGLE_REDACTION" },
      { key: "APPLY_PRESET" },
      { key: "UPDATE_SELECTION" },
      { key: "REFRESH_TREE" },
      { key: "EXPAND_ALL" },
      { key: "COLLAPSE_ALL" },
      { key: "REFRESH_PREVIEW" },
      { key: "SELECT_ALL" },
      { key: "DESELECT_ALL" },
      { key: "WEBVIEW_READY", options: { rateLimitMs: 0 } },
      { key: "FLUSH_ERROR_REPORTS" },
      { key: "VIEW_METRICS" },
      { key: "OPEN_DASHBOARD_PANEL" }
    ];

    for (const { key, options } of outboundRegistrations) {
      const commandId = COMMAND_MAP.WEBVIEW_TO_HOST?.[key];
      if (!commandId) {
        this.logger.warn("Skipping outbound command registration. Unknown key", { key });
        continue;
      }
      const registrationOptions = this.isTestEnvironment
        ? { ...options, requiresAck: false }
        : options;
      this.commandRegistry.register(commandId, undefined, registrationOptions);
    }
  }

  setupMessageHandlers() {
    window.addEventListener("message", (event) => {
      const message = event.data;
      if (!message || typeof message !== "object") {
        return;
      }

      if (message.type === "command" || message.type === "event") {
        void this.commandRegistry.handleIncoming(message);
        return;
      }

      if (message.type === "response") {
        this.commandRegistry.handleResponse(message);
        return;
      }

      if (typeof message.type === "string") {
        void this._processMessage(message.type, message.payload);
      }
    });
  }

  setupActionButtons() {
    const clickBindings = [
      { action: "refresh", key: "REFRESH_TREE" },
      { action: "refresh-tree", key: "REFRESH_TREE" },
      { action: "generate", key: "GENERATE_DIGEST", payload: () => this.getGenerateDigestPayload() },
      { action: "expand-all", key: "EXPAND_ALL" },
      { action: "collapse-all", key: "COLLAPSE_ALL" },
      { action: "refresh-preview", key: "REFRESH_PREVIEW" },
      { action: "load-remote", key: "LOAD_REMOTE_REPO" },
      { action: "toggle-redaction", key: "TOGGLE_REDACTION" },
      { action: "select-all", key: "SELECT_ALL" },
      { action: "select-none", key: "DESELECT_ALL" },
      { action: "view-metrics", key: "VIEW_METRICS" },
      { action: "flush-errors", key: "FLUSH_ERROR_REPORTS" },
      { action: "open-dashboard", key: "OPEN_DASHBOARD_PANEL" }
    ];

    for (const binding of clickBindings) {
      const commandId = COMMAND_MAP.WEBVIEW_TO_HOST?.[binding.key];
      if (!commandId) {
        this.logger.warn("No command mapping for action", binding);
        continue;
      }
      const elements = document.querySelectorAll(`[data-action="${binding.action}"]`);
      elements.forEach((element) => {
        element.addEventListener("click", () => {
          const payload = typeof binding.payload === "function" ? binding.payload() : binding.payload;
          void this.executeOutbound(commandId, payload);
        });
      });
    }

    const presetSelect = document.querySelector('[data-action="apply-preset"]');
    if (presetSelect instanceof HTMLSelectElement) {
      presetSelect.addEventListener("change", () => {
        const commandId = COMMAND_MAP.WEBVIEW_TO_HOST?.APPLY_PRESET;
        if (!commandId) {
          this.logger.warn("Preset command unavailable");
          return;
        }
        const presetId = presetSelect.value ?? "default";
        void this.executeOutbound(commandId, { presetId });
      });
    }
  }

  setupLifecycleEvents() {
    window.addEventListener("DOMContentLoaded", () => {
      void this.executeOutbound(COMMAND_MAP.WEBVIEW_TO_HOST.WEBVIEW_READY);
    });
  }

  getGenerateDigestPayload() {
    const state = this.store.getState();
    const selectedFiles = Array.isArray(state.selection) ? state.selection : [];
    const outputFormat = state.config?.outputFormat ?? "markdown";
    const redactionOverride = Boolean(state.config?.redactionOverride);

    return {
      selectedFiles,
      outputFormat,
      redactionOverride
    };
  }

  executeOutbound(commandId, payload) {
    if (typeof commandId !== "string" || commandId.length === 0) {
      this.logger.warn("Attempted to execute unknown command", { commandId });
      return Promise.resolve({ ok: false, reason: "unknown_command" });
    }
    return this.performanceMonitor
      .measureOperation("messageProcessing", () => this.commandRegistry.execute(commandId, payload))
      .catch((error) => {
        const normalizedError = error instanceof Error ? error : new Error(String(error));
        this.logger.error("Failed to execute command", { commandId, error: normalizedError.message });
        this.errorReporter.reportError(normalizedError, {
          type: "command_execution_failure",
          commandId
        });
        return undefined;
      });
  }

  _processMessage(messageType, payload) {
    return this.performanceMonitor
      .measureOperation("messageProcessing", () => this.registry.process(messageType, payload))
      .catch((error) => {
        const normalizedError = error instanceof Error ? error : new Error(String(error));
        this.errorReporter.reportError(normalizedError, { type: "message_processing_failure", messageType });
        return undefined;
      });
  }
}

const isTestMode = typeof window !== "undefined" && window.__CODE_INGEST_TEST__ === true;

if (!isTestMode) {
  const application = new WebviewApplication();

  application.initialize().catch((error) => {
    console.error("Failed to initialize webview application", error);
  });

  window.webviewApplication = application;
} else {
  window.WebviewApplication = WebviewApplication;
}
