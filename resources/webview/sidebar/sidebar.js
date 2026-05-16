(function () {
  var vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : { postMessage: function() {}, setState: function() {}, getState: function() { return null; } };

  var currentState;

  // ─── Overlay elements ───
  var overlays = {
    notInitialized: document.getElementById("overlayNotInitialized"),
    trustLocked: document.getElementById("overlayTrustLocked"),
    initializing: document.getElementById("overlayInitializing"),
    error: document.getElementById("overlayError")
  };
  var readyContent = document.getElementById("readyContent");
  var errorDetail = document.getElementById("errorDetail");
  var progressMessage = document.getElementById("progressMessage");
  var progressStats = document.getElementById("progressStats");
  var progressNodeCount = document.getElementById("progressNodeCount");
  var progressEdgeCount = document.getElementById("progressEdgeCount");
  var progressFileCount = document.getElementById("progressFileCount");

  // ─── Ready-state elements ───
  var elements = {
    statusDot: document.getElementById("statusDot"),
    statusText: document.getElementById("statusText"),
    nodeCount: document.getElementById("nodeCount"),
    edgeCount: document.getElementById("edgeCount"),
    fileCount: document.getElementById("fileCount"),
    lastIndexed: document.getElementById("lastIndexed"),
    dbSize: document.getElementById("dbSize"),
    activeFile: document.getElementById("activeFile"),
    dependencyCount: document.getElementById("dependencyCount"),
    dependentCount: document.getElementById("dependentCount"),
    excludePatterns: document.getElementById("excludePatterns"),
    excludePatternInput: document.getElementById("excludePatternInput"),
    hopDepthSelect: document.getElementById("hopDepthSelect"),
    hopDepthPill: document.getElementById("hopDepthPill"),
    nodeModePill: document.getElementById("nodeModePill"),
    nodeModeButtons: Array.from(document.querySelectorAll("#nodeModeToggle button")),
    rebuildButton: document.getElementById("rebuildButton"),
    openGraphButton: document.getElementById("openGraphButton"),
    sendToChatButton: document.getElementById("sendToChatButton"),
    primaryOpenGraph: document.getElementById("primaryOpenGraph"),
    editIgnoreButton: document.getElementById("editIgnoreButton"),
    openSettingsButton: document.getElementById("openSettingsButton"),
    addPatternButton: document.getElementById("addPatternButton"),
    exportPiiPolicySelect: document.getElementById("exportPiiPolicySelect"),
    exportFormatSelect: document.getElementById("exportFormatSelect"),
    exportPreviewButton: document.getElementById("exportPreviewButton"),
    exportExecuteButton: document.getElementById("exportExecuteButton"),
    exportSizeEstimate: document.getElementById("exportSizeEstimate"),
    exportTokenEstimate: document.getElementById("exportTokenEstimate"),
    contextBudgetBar: document.getElementById("contextBudgetBar"),
    contextBudgetLabel: document.getElementById("contextBudgetLabel")
  };

  // ─── Overlay buttons ───
  var initializeButton = document.getElementById("initializeButton");
  var retryButton = document.getElementById("retryButton");

  function post(type, payload) {
    if (payload === undefined) {
      vscode.postMessage({ type: type });
      return;
    }
    vscode.postMessage({ type: type, payload: payload });
  }

  function activeFilePayload() {
    return currentState && currentState.activeFile ? { filePath: currentState.activeFile } : undefined;
  }

  // ─── State machine: show/hide overlays ───
  function showView(status, errorMessage) {
    overlays.notInitialized.classList.remove("visible");
    overlays.trustLocked.classList.remove("visible");
    overlays.initializing.classList.remove("visible");
    overlays.error.classList.remove("visible");
    readyContent.classList.add("hidden");

    switch (status) {
      case "not-initialized":
        overlays.notInitialized.classList.add("visible");
        break;
      case "trust-locked":
        overlays.trustLocked.classList.add("visible");
        break;
      case "initializing":
        overlays.initializing.classList.add("visible");
        break;
      case "error":
        overlays.error.classList.add("visible");
        errorDetail.textContent = errorMessage || "An unknown error occurred.";
        break;
      default:
        // ready, indexing, partial — show main content
        readyContent.classList.remove("hidden");
        break;
    }
  }

  function updateProgressUI(payload) {
    if (progressMessage && payload.progressMessage) {
      progressMessage.textContent = payload.progressMessage;
    }
    // Show live counts during initialization if available.
    var hasStats = (payload.nodeCount > 0 || payload.edgeCount > 0 || payload.fileCount > 0);
    if (progressStats) {
      progressStats.style.display = hasStats ? "grid" : "none";
    }
    if (progressNodeCount) progressNodeCount.textContent = String(payload.nodeCount || 0);
    if (progressEdgeCount) progressEdgeCount.textContent = String(payload.edgeCount || 0);
    if (progressFileCount) progressFileCount.textContent = String(payload.fileCount || 0);
  }

  function setStatus(status) {
    var colors = {
      ready: "var(--vscode-testing-iconPassed)",
      indexing: "var(--vscode-testing-iconQueued)",
      partial: "var(--vscode-testing-iconSkipped)",
      error: "var(--vscode-testing-iconFailed)"
    };
    var labels = {
      ready: "Ready",
      indexing: "Indexing",
      partial: "Partial",
      error: "Error"
    };

    elements.statusDot.style.background = colors[status] || colors.ready;
    elements.statusText.textContent = labels[status] || labels.ready;
  }

  function setNodeMode(mode) {
    elements.nodeModeButtons.forEach(function (button) {
      button.classList.toggle("active", button.dataset.mode === mode);
    });
    elements.nodeModePill.textContent = "Mode: " + mode;
  }

  function setHopDepth(value) {
    elements.hopDepthSelect.value = String(value);
    elements.hopDepthPill.textContent = "Depth: " + value;
  }

  function renderPatterns(patterns) {
    elements.excludePatterns.innerHTML = "";

    if (!patterns || patterns.length === 0) {
      var empty = document.createElement("span");
      empty.className = "muted";
      empty.textContent = "No extra exclusions";
      elements.excludePatterns.appendChild(empty);
      return;
    }

    patterns.forEach(function (pattern) {
      var button = document.createElement("button");
      button.className = "pill";
      button.textContent = pattern;
      button.title = "Remove " + pattern;
      button.addEventListener("click", function () { post("remove-exclude-pattern", { pattern: pattern }); });
      elements.excludePatterns.appendChild(button);
    });
  }

  function addPattern() {
    var pattern = elements.excludePatternInput.value.trim();
    if (!pattern) return;
    post("add-exclude-pattern", { pattern: pattern });
    elements.excludePatternInput.value = "";
  }

  // ─── Event listeners: overlay buttons ───
  if (initializeButton) {
    initializeButton.addEventListener("click", function () { post("initialize"); });
  }
  if (retryButton) {
    retryButton.addEventListener("click", function () { post("initialize"); });
  }

  // ─── Event listeners: ready-state buttons ───
  elements.rebuildButton.addEventListener("click", function () { post("rebuild-graph"); });
  elements.openGraphButton.addEventListener("click", function () { post("open-graph-view", activeFilePayload()); });
  elements.sendToChatButton.addEventListener("click", function () { post("send-to-chat", activeFilePayload()); });
  elements.primaryOpenGraph.addEventListener("click", function () { post("open-graph-view", activeFilePayload()); });
  elements.editIgnoreButton.addEventListener("click", function () { post("edit-ignore"); });
  elements.openSettingsButton.addEventListener("click", function () { post("open-settings"); });
  elements.addPatternButton.addEventListener("click", addPattern);
  elements.exportPreviewButton.addEventListener("click", function () { 
    elements.exportPreviewButton.textContent = "Estimating...";
    post("export-preview", { piiPolicy: elements.exportPiiPolicySelect.value, format: elements.exportFormatSelect.value }); 
  });
  elements.exportExecuteButton.addEventListener("click", function () { 
    post("export-execute", { piiPolicy: elements.exportPiiPolicySelect.value, format: elements.exportFormatSelect.value }); 
  });

  elements.excludePatternInput.addEventListener("keydown", function (event) {
    if (event.key === "Enter") addPattern();
  });

  elements.hopDepthSelect.addEventListener("change", function () {
    var hopDepth = Number(elements.hopDepthSelect.value);
    setHopDepth(hopDepth);
    post("update-setting", { section: "codeIngest.graph", key: "hopDepth", value: hopDepth });
  });

  elements.nodeModeButtons.forEach(function (button) {
    button.addEventListener("click", function () {
      var mode = button.dataset.mode || "file";
      setNodeMode(mode);
      post("update-setting", { section: "codeIngest.graph", key: "defaultNodeMode", value: mode });
    });
  });

  // ─── Message handler ───
  window.addEventListener("message", function (event) {
    var message = event.data || {};
    if (message.type !== "sidebar-state") return;

    var payload = message.payload || {};
    currentState = payload;
    var status = payload.status || "ready";

    // Persist state so the webview can restore on visibility change.
    vscode.setState(payload);

    // Switch between overlay views and ready content.
    showView(status, payload.errorMessage);

    // Update progress UI when initializing.
    if (status === "initializing") {
      updateProgressUI(payload);
    }

    // Only update ready-state fields if we're actually showing them.
    if (status === "ready" || status === "indexing" || status === "partial") {
      setStatus(status);
      elements.nodeCount.textContent = String(payload.nodeCount || 0);
      elements.edgeCount.textContent = String(payload.edgeCount || 0);
      elements.fileCount.textContent = String(payload.fileCount || 0);
      elements.lastIndexed.textContent = payload.lastIndexed ? new Date(payload.lastIndexed).toLocaleString() : "Never";
      elements.dbSize.textContent = Math.round((payload.databaseSizeBytes || 0) / 1024) + " KB";
      elements.activeFile.textContent = payload.activeFile || "No editor open";
      elements.dependencyCount.textContent = String(payload.dependencyCount || 0);
      elements.dependentCount.textContent = String(payload.dependentCount || 0);

      var settings = payload.settings || {};
      setHopDepth(settings.hopDepth || 2);
      setNodeMode(settings.defaultNodeMode || "file");
      renderPatterns(settings.excludePatterns || []);

      if (payload.contextBudget) {
        var pct = Math.min(100, Math.max(0, (payload.contextBudget.used / payload.contextBudget.total) * 100));
        elements.contextBudgetBar.style.width = pct + "%";
        elements.contextBudgetBar.style.background = pct > 90 ? "var(--vscode-testing-iconFailed)" : pct > 75 ? "var(--vscode-testing-iconQueued)" : "var(--vscode-testing-iconPassed)";
        elements.contextBudgetLabel.textContent = payload.contextBudget.used + " / " + payload.contextBudget.total + " tokens";
      }

      if (payload.exportPreviewResult) {
        elements.exportPreviewButton.textContent = "Preview Export";
        elements.exportSizeEstimate.textContent = Math.round(payload.exportPreviewResult.sizeBytes / 1024) + " KB";
        elements.exportTokenEstimate.textContent = payload.exportPreviewResult.tokens || "N/A";
        elements.exportExecuteButton.disabled = false;
        elements.exportExecuteButton.classList.remove("secondary");
        elements.exportExecuteButton.classList.add("primary");
      }
    }
  });

  // ─── Restore persisted state on re-mount ───
  var savedState = vscode.getState();
  if (savedState && savedState.status) {
    currentState = savedState;
    showView(savedState.status, savedState.errorMessage);
    if (savedState.status === "initializing") {
      updateProgressUI(savedState);
    }
  } else {
    // Initial state: show not-initialized until a message arrives.
    showView("not-initialized");
  }
})();
