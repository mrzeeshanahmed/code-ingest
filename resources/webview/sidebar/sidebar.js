(function () {
  const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : { postMessage() {} };

  let currentState;

  const elements = {
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
    exportCleanButton: document.getElementById("exportCleanButton"),
    exportGraphButton: document.getElementById("exportGraphButton"),
    exportRawButton: document.getElementById("exportRawButton")
  };

  function post(type, payload) {
    if (payload === undefined) {
      vscode.postMessage({ type });
      return;
    }

    vscode.postMessage({ type, payload });
  }

  function activeFilePayload() {
    return currentState && currentState.activeFile ? { filePath: currentState.activeFile } : undefined;
  }

  function setStatus(status) {
    const colors = {
      ready: "var(--vscode-testing-iconPassed)",
      indexing: "var(--vscode-testing-iconQueued)",
      partial: "var(--vscode-testing-iconSkipped)",
      error: "var(--vscode-testing-iconFailed)"
    };
    const labels = {
      ready: "Ready",
      indexing: "Indexing",
      partial: "Partial",
      error: "Error"
    };

    elements.statusDot.style.background = colors[status] || colors.ready;
    elements.statusText.textContent = labels[status] || labels.ready;
  }

  function setNodeMode(mode) {
    elements.nodeModeButtons.forEach((button) => {
      button.classList.toggle("active", button.dataset.mode === mode);
    });
    elements.nodeModePill.textContent = `Mode: ${mode}`;
  }

  function setHopDepth(value) {
    elements.hopDepthSelect.value = String(value);
    elements.hopDepthPill.textContent = `Depth: ${value}`;
  }

  function renderPatterns(patterns) {
    elements.excludePatterns.innerHTML = "";

    if (!patterns || patterns.length === 0) {
      const empty = document.createElement("span");
      empty.className = "muted";
      empty.textContent = "No extra exclusions";
      elements.excludePatterns.appendChild(empty);
      return;
    }

    patterns.forEach((pattern) => {
      const button = document.createElement("button");
      button.className = "pill";
      button.textContent = pattern;
      button.title = `Remove ${pattern}`;
      button.addEventListener("click", () => post("remove-exclude-pattern", { pattern }));
      elements.excludePatterns.appendChild(button);
    });
  }

  function addPattern() {
    const pattern = elements.excludePatternInput.value.trim();
    if (!pattern) {
      return;
    }

    post("add-exclude-pattern", { pattern });
    elements.excludePatternInput.value = "";
  }

  elements.rebuildButton.addEventListener("click", () => post("rebuild-graph"));
  elements.openGraphButton.addEventListener("click", () => post("open-graph-view", activeFilePayload()));
  elements.sendToChatButton.addEventListener("click", () => post("send-to-chat", activeFilePayload()));
  elements.primaryOpenGraph.addEventListener("click", () => post("open-graph-view", activeFilePayload()));
  elements.editIgnoreButton.addEventListener("click", () => post("edit-ignore"));
  elements.openSettingsButton.addEventListener("click", () => post("open-settings"));
  elements.addPatternButton.addEventListener("click", addPattern);
  elements.exportCleanButton.addEventListener("click", () => post("export-clean", { piiPolicy: elements.exportPiiPolicySelect.value }));
  elements.exportGraphButton.addEventListener("click", () => post("export-graph", { piiPolicy: elements.exportPiiPolicySelect.value }));
  elements.exportRawButton.addEventListener("click", () => post("export-raw", { piiPolicy: elements.exportPiiPolicySelect.value }));

  elements.excludePatternInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      addPattern();
    }
  });

  elements.hopDepthSelect.addEventListener("change", () => {
    const hopDepth = Number(elements.hopDepthSelect.value);
    setHopDepth(hopDepth);
    post("update-setting", {
      section: "codeIngest.graph",
      key: "hopDepth",
      value: hopDepth
    });
  });

  elements.nodeModeButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const mode = button.dataset.mode || "file";
      setNodeMode(mode);
      post("update-setting", {
        section: "codeIngest.graph",
        key: "defaultNodeMode",
        value: mode
      });
    });
  });

  window.addEventListener("message", (event) => {
    const message = event.data || {};
    if (message.type !== "sidebar-state") {
      return;
    }

    const payload = message.payload || {};
    currentState = payload;

    setStatus(payload.status || "ready");
    elements.nodeCount.textContent = String(payload.nodeCount || 0);
    elements.edgeCount.textContent = String(payload.edgeCount || 0);
    elements.fileCount.textContent = String(payload.fileCount || 0);
    elements.lastIndexed.textContent = payload.lastIndexed ? new Date(payload.lastIndexed).toLocaleString() : "Never";
    elements.dbSize.textContent = `${Math.round((payload.databaseSizeBytes || 0) / 1024)} KB`;
    elements.activeFile.textContent = payload.activeFile || "No editor open";
    elements.dependencyCount.textContent = String(payload.dependencyCount || 0);
    elements.dependentCount.textContent = String(payload.dependentCount || 0);

    const settings = payload.settings || {};
    setHopDepth(settings.hopDepth || 2);
    setNodeMode(settings.defaultNodeMode || "file");
    renderPatterns(settings.excludePatterns || []);
  });
})();
