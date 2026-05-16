(function () {
  const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : { postMessage() {} };
  const tooltip = document.getElementById("tooltip");
  const contextMenu = document.getElementById("contextMenu");
  const graphNotice = document.getElementById("graphNotice");
  const graphNoticeText = document.getElementById("graphNoticeText");
  const loadFullGraphButton = document.getElementById("loadFullGraphButton");

  // --- Web Worker for layout/physics computation (offloads main thread) ---
  let layoutWorker = undefined;
  let layoutRequestId = 0;
  const pendingLayoutCallbacks = new Map();

  try {
    layoutWorker = new Worker("graph.worker.js");
    layoutWorker.onmessage = function (event) {
      const msg = event.data;
      if (!msg || !msg.requestId) return;
      const callback = pendingLayoutCallbacks.get(msg.requestId);
      if (callback) {
        pendingLayoutCallbacks.delete(msg.requestId);
        callback(msg);
      }
    };
    layoutWorker.onerror = function (error) {
      console.warn("[graph-view] Layout worker error, falling back to Cytoscape layout:", error.message);
      layoutWorker = undefined;
    };
  } catch (e) {
    console.warn("[graph-view] Unable to create layout worker, using Cytoscape layout only:", e.message);
    layoutWorker = undefined;
  }

  function computeLayoutInWorker(nodes, edges) {
    return new Promise(function (resolve, reject) {
      if (!layoutWorker) {
        reject(new Error("Layout worker unavailable"));
        return;
      }
      var requestId = "layout-" + (++layoutRequestId);
      pendingLayoutCallbacks.set(requestId, function (msg) {
        if (msg.type === "error") {
          reject(new Error(msg.payload && msg.payload.message || "Layout failed"));
        } else if (msg.type === "layout-result") {
          resolve(msg.payload.positions);
        }
      });
      layoutWorker.postMessage({
        type: "layout",
        payload: { nodes: nodes, edges: edges },
        requestId: requestId
      });
    });
  }

  const state = {
    graph: { nodes: [], edges: [] },
    layout: "cose",
    mode: "file",
    focusFile: undefined,
    selectedNodeIds: new Set(),
    search: "",
    cy: undefined,
    truncated: false,
    fullGraphLoaded: false,
    ramEstimateMb: 0,
    focusOpacity: 0.15,
    maxNodes: 500,
    lastIndexed: undefined,
    lastZoomMode: "close"
  };

  const emptyStateContainer = document.getElementById("emptyStateContainer");
  const emptyStateIcon = document.getElementById("emptyStateIcon");
  const emptyStateTitle = document.getElementById("emptyStateTitle");
  const emptyStateDesc = document.getElementById("emptyStateDesc");

  function showEmptyState(icon, title, desc) {
    emptyStateContainer.style.display = "flex";
    emptyStateIcon.textContent = icon;
    emptyStateTitle.textContent = title;
    emptyStateDesc.textContent = desc;
    document.getElementById("cy").style.display = "none";
  }

  function hideEmptyState() {
    emptyStateContainer.style.display = "none";
    document.getElementById("cy").style.display = "block";
  }

  loadFullGraphButton.addEventListener("click", () => {
    vscode.postMessage({ type: "load-full-graph" });
  });

  function hideTooltip() {
    tooltip.style.display = "none";
  }

  function showTooltip(event, node) {
    const incoming = node.incomers("edge").length;
    const outgoing = node.outgoers("edge").length;
    tooltip.innerHTML = `
      <strong>${node.data("label")}</strong><br>
      <span class="muted">${node.data("type")} • ${node.data("relativePath")}</span><br>
      in/out: ${incoming}/${outgoing}<br>
      indexed: ${new Date(node.data("lastIndexed")).toLocaleString()}
    `;
    tooltip.style.display = "block";
    tooltip.style.left = `${event.originalEvent.clientX + 16}px`;
    tooltip.style.top = `${event.originalEvent.clientY + 12}px`;
  }

  function hideContextMenu() {
    contextMenu.style.display = "none";
    contextMenu.innerHTML = "";
  }

  function showContextMenu(event, node) {
    hideContextMenu();
    const targets = state.selectedNodeIds.size > 1
      ? state.graph.nodes.filter((entry) => state.selectedNodeIds.has(entry.data.id))
      : [node.data()];

    const actions = [
      {
        label: "Send to Copilot Chat",
        type: "send-to-chat",
        payload: {
          filePath: targets[0].filePath,
          filePaths: Array.from(new Set(targets.map((entry) => entry.filePath).filter(Boolean)))
        }
      },
      { label: "Focus on this node", type: "focus-file", payload: { filePath: node.data("filePath") } },
      { label: "Copy path", type: "copy-path", payload: { filePath: node.data("filePath") } },
      { label: "Show in Explorer", type: "show-in-explorer", payload: { filePath: node.data("filePath") } }
    ];

    for (const action of actions) {
      const button = document.createElement("button");
      button.textContent = action.label;
      button.addEventListener("click", () => {
        vscode.postMessage({ type: action.type, payload: action.payload });
        hideContextMenu();
      });
      contextMenu.appendChild(button);
    }

    contextMenu.style.display = "block";
    contextMenu.style.left = `${event.originalEvent.clientX}px`;
    contextMenu.style.top = `${event.originalEvent.clientY}px`;
  }

  function markCircularEdges(elements) {
    const reversePairs = new Set(elements.edges.map((edge) => `${edge.data.target}-${edge.data.source}-${edge.data.type}`));
    elements.edges.forEach((edge) => {
      if (reversePairs.has(`${edge.data.source}-${edge.data.target}-${edge.data.type}`) && edge.data.source !== edge.data.target) {
        edge.classes = `${edge.classes || ""} circular`.trim();
      }
    });
  }

  function buildElements() {
    const nodes = state.graph.nodes
      .filter((node) => state.mode === "function" || node.type === "file")
      .map((node) => ({
        data: {
          id: node.id,
          label: node.label,
          type: node.type,
          filePath: node.filePath,
          relativePath: node.relativePath,
          startLine: node.startLine,
          lastIndexed: node.lastIndexed
        },
        classes: [node.filePath === state.focusFile ? "current" : "", state.selectedNodeIds.has(node.id) ? "selected-custom" : ""].filter(Boolean).join(" ")
      }));

    const allowedIds = new Set(nodes.map((node) => node.data.id));
    const edges = state.graph.edges
      .filter((edge) => allowedIds.has(edge.sourceId) && allowedIds.has(edge.targetId))
      .map((edge) => ({
        data: {
          id: edge.id,
          source: edge.sourceId,
          target: edge.targetId,
          type: edge.type
        }
      }));

    const elements = { nodes, edges };
    markCircularEdges(elements);
    return elements;
  }

  function applySearch() {
    if (!state.cy) {
      return;
    }

    const query = state.search.trim().toLowerCase();
    state.cy.elements().removeClass("dimmed");
    if (!query) {
      return;
    }

    state.cy.nodes().forEach((node) => {
      const haystack = `${node.data("label")} ${node.data("relativePath")}`.toLowerCase();
      if (!haystack.includes(query)) {
        node.addClass("dimmed");
      }
    });

    state.cy.edges().forEach((edge) => {
      if (edge.source().hasClass("dimmed") && edge.target().hasClass("dimmed")) {
        edge.addClass("dimmed");
      }
    });
  }

  function applyFocus(nodeId) {
    if (!state.cy) {
      return;
    }

    state.cy.elements().removeClass("dimmed");
    if (!nodeId) {
      applySearch();
      return;
    }

    const center = state.cy.getElementById(nodeId);
    if (!center || center.empty()) {
      return;
    }

    const keep = new Set([nodeId]);
    let frontier = new Set([center]);
    for (let depth = 0; depth < 2; depth += 1) {
      const next = new Set();
      frontier.forEach((current) => {
        current.connectedEdges().forEach((edge) => {
          keep.add(edge.id());
          keep.add(edge.source().id());
          keep.add(edge.target().id());
          next.add(edge.source());
          next.add(edge.target());
        });
      });
      frontier = next;
    }

    state.cy.nodes().forEach((node) => {
      if (!keep.has(node.id())) {
        node.addClass("dimmed");
      }
    });
    state.cy.edges().forEach((edge) => {
      if (!keep.has(edge.id())) {
        edge.addClass("dimmed");
      }
    });
  }

  function updateGraphNotice() {
    if (!state.truncated || state.fullGraphLoaded) {
      graphNotice.classList.add("hidden");
      return;
    }

    graphNotice.classList.remove("hidden");
    graphNoticeText.textContent = `Showing a focused subgraph because the full graph exceeds ${state.maxNodes} nodes. Estimated full render memory: ${state.ramEstimateMb.toFixed(1)} MB.`;
  }

  function runLayout() {
    if (!state.cy) {
      return;
    }

    var layoutConfig = state.layout === "radial"
      ? {
          name: "concentric",
          concentric: function (node) {
            return node.data("filePath") === state.focusFile ? Number.MAX_SAFE_INTEGER : node.degree(true);
          },
          levelWidth: function () {
            return 2;
          }
        }
      : {
          name: "cose-bilkent",
          animate: false,
          fit: true,
          padding: 50
        };

    // Try worker-based layout first, fall back to Cytoscape built-in.
    var cyNodes = state.cy.nodes();
    var cyEdges = state.cy.edges();

    if (layoutWorker && cyNodes.length <= 250) {
      var workerNodes = cyNodes.map(function (n) {
        return { id: n.id(), label: n.data("label"), type: n.data("type") };
      });
      var workerEdges = cyEdges.map(function (e) {
        return { sourceId: e.data("source"), targetId: e.data("target"), type: e.data("type") };
      });

      computeLayoutInWorker(workerNodes, workerEdges).then(function (positions) {
        cyNodes.positions(function (node) {
          var pos = positions[node.id()];
          if (pos) {
            return { x: pos.x, y: pos.y };
          }
          return node.position();
        });
        // Run Cytoscape layout with the computed initial positions.
        state.cy.layout(layoutConfig).run();
      }).catch(function () {
        // Worker failed; fall back to Cytoscape-only layout.
        state.cy.layout(layoutConfig).run();
      });
    } else {
      state.cy.layout(layoutConfig).run();
    }
  }

  function renderGraph() {
    const container = document.getElementById("cy");
    const elements = buildElements();

    if (state.cy) {
      state.cy.destroy();
    }

    state.cy = cytoscape({
      container,
      elements,
      style: window.buildCodeIngestGraphStyles(),
      wheelSensitivity: 0.2
    });

    state.cy.on("tap", "node", (event) => {
      const node = event.target;
      if (event.originalEvent.ctrlKey || event.originalEvent.metaKey) {
        if (state.selectedNodeIds.has(node.id())) {
          state.selectedNodeIds.delete(node.id());
          node.removeClass("selected-custom");
        } else {
          state.selectedNodeIds.add(node.id());
          node.addClass("selected-custom");
        }
        return;
      }

      state.selectedNodeIds.clear();
      state.selectedNodeIds.add(node.id());
      state.cy.nodes().removeClass("selected-custom");
      node.addClass("selected-custom");
      vscode.postMessage({
        type: "open-file",
        payload: { filePath: node.data("filePath"), line: node.data("startLine") }
      });
    });

    state.cy.on("cxttap", "node", (event) => {
      showContextMenu(event, event.target);
    });

    state.cy.on("dbltap", "node", (event) => {
      const node = event.target;
      applyFocus(node.id());
      vscode.postMessage({ type: "expand-node", payload: { filePath: node.data("filePath") } });
    });

    state.cy.on("mouseover", "node", (event) => showTooltip(event, event.target));
    state.cy.on("mouseout", "node", hideTooltip);
    state.cy.on("tap", (event) => {
      if (event.target === state.cy) {
        hideContextMenu();
        applyFocus(undefined);
      }
    });

    state.cy.on("zoom", () => {
      const zoom = state.cy.zoom();
      let mode = "close";
      if (zoom < 0.3) mode = "far";
      else if (zoom < 0.8) mode = "medium";
      
      if (state.lastZoomMode !== mode) {
        state.lastZoomMode = mode;
        const nodes = state.cy.nodes();
        const edges = state.cy.edges();
        if (mode === "far") {
          nodes.addClass("zoom-far");
          nodes.removeClass("zoom-medium");
          edges.addClass("zoom-far");
        } else if (mode === "medium") {
          nodes.addClass("zoom-medium");
          nodes.removeClass("zoom-far");
          edges.removeClass("zoom-far");
        } else {
          nodes.removeClass("zoom-far zoom-medium");
          edges.removeClass("zoom-far");
        }
      }
    });

    applySearch();
    runLayout();
  }

  const toolbar = window.initCodeIngestToolbar({
    onLayoutChange(value) {
      state.layout = value || "cose";
      vscode.postMessage({ type: "layout-change", payload: { layout: state.layout } });
      runLayout();
    },
    onModeChange(value) {
      state.mode = value || "file";
      vscode.postMessage({ type: "graph-mode-change", payload: { mode: state.mode } });
    },
    onSearch(value) {
      state.search = value || "";
      applySearch();
    },
    onFocus() {
      if (!state.focusFile) {
        return;
      }
      vscode.postMessage({ type: "focus-file", payload: { filePath: state.focusFile } });
    },
    onFit() {
      if (state.cy) {
        state.cy.fit(undefined, 32);
      }
    },
    onExport() {
      if (!state.cy) {
        return;
      }
      vscode.postMessage({ type: "export-png-result", payload: { dataUrl: state.cy.png({ full: true, scale: 2 }) } });
    }
  });

  window.addEventListener("message", (event) => {
    const message = event.data || {};
    if (message.type === "load-graph") {
      if (message.payload.status && message.payload.status !== "ready" && message.payload.status !== "partial") {
        if (message.payload.status === "trust-locked") return showEmptyState("🔒", "Workspace Not Trusted", "Graph features are disabled in untrusted workspaces.");
        if (message.payload.status === "not-initialized") return showEmptyState("🔬", "Not Initialized", "Initialize the codebase from the Code-Ingest sidebar to view the graph.");
        if (message.payload.status === "initializing") return showEmptyState("⏳", "Indexing in Progress", "The graph is being built. Please wait...");
        if (message.payload.status === "error") return showEmptyState("⚠️", "Graph Error", "Failed to load graph data.");
      }
      if (!message.payload.nodes || message.payload.nodes.length === 0) {
        return showEmptyState("📭", "Empty Graph", "No nodes matched the current filters or the graph is empty.");
      }
      hideEmptyState();

      state.graph = message.payload;
      state.focusFile = message.payload.focusFile;
      state.layout = message.payload.layout || state.layout;
      state.mode = message.payload.nodeMode || state.mode;
      state.truncated = Boolean(message.payload.truncated);
      state.fullGraphLoaded = Boolean(message.payload.fullGraphLoaded);
      state.ramEstimateMb = Number(message.payload.ramEstimateMb || 0);
      state.focusOpacity = Number(message.payload.focusModeOpacity || 0.15);
      state.maxNodes = Number(message.payload.maxNodes || 500);
      state.lastIndexed = message.payload.stats?.lastIndexed;
      document.documentElement.style.setProperty("--code-ingest-focus-opacity", String(state.focusOpacity));
      toolbar.setLayout(state.layout);
      toolbar.setMode(state.mode);
      toolbar.setStats(`${state.graph.nodes.length} nodes | ${state.graph.edges.length} edges | ${state.lastIndexed ? new Date(state.lastIndexed).toLocaleString() : "Never"}`);
      updateGraphNotice();
      renderGraph();
    } else if (message.type === "request-export-png") {
      if (state.cy) {
        vscode.postMessage({ type: "export-png-result", payload: { dataUrl: state.cy.png({ full: true, scale: 2 }) } });
      }
    }
  });

  document.addEventListener("click", (event) => {
    if (!contextMenu.contains(event.target)) {
      hideContextMenu();
    }
  });

  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      hideContextMenu();
      hideTooltip();
    }
  });

  vscode.postMessage({ type: "ready" });
})();
