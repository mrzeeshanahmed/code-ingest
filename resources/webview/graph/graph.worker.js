/**
 * graph.worker.js — Layout and physics worker for Code-Ingest Canvas Graph View
 * 
 * This worker runs layout computations off the main webview thread so
 * large graph rendering stays responsive. It communicates with the main
 * thread via postMessage with structured transfer protocols.
 * 
 * Protocol:
 *   Inbound:  { type: "layout", payload: { nodes: [...], edges: [...] }, requestId: string }
 *   Outbound: { type: "layout-result", payload: { positions: {...} }, requestId: string }
 *   Outbound: { type: "error", payload: { message: string }, requestId: string }
 */

const MESSAGE_TYPES = new Set(["layout", "reset", "dispose"]);

self.onmessage = function (event) {
  const message = event.data;

  if (!message || typeof message !== "object" || !MESSAGE_TYPES.has(message.type)) {
    self.postMessage({
      type: "error",
      payload: { message: "Invalid message format" },
      requestId: message?.requestId ?? "unknown"
    });
    return;
  }

  switch (message.type) {
    case "layout":
      handleLayout(message);
      break;
    case "reset":
      resetState();
      break;
    case "dispose":
      self.close();
      break;
  }
};

/**
 * Simple force-directed layout engine.
 * For production, this should be replaced with a more sophisticated
 * algorithm (e.g., Fruchterman-Reingold or Kamada-Kawai).
 */
let nodePositions = {};
let edgeList = [];

function handleLayout(message) {
  try {
    const { nodes, edges } = message.payload;
    edgeList = edges;

    // Initialize positions if not already set.
    if (Object.keys(nodePositions).length === 0) {
      for (const node of nodes) {
        nodePositions[node.id] = {
          x: (Math.random() - 0.5) * 400,
          y: (Math.random() - 0.5) * 400
        };
      }
    }

    // Add positions for new nodes.
    for (const node of nodes) {
      if (!nodePositions[node.id]) {
        nodePositions[node.id] = {
          x: (Math.random() - 0.5) * 400,
          y: (Math.random() - 0.5) * 400
        };
      }
    }

    // Run force-directed iterations.
    const iterations = Math.min(100, Math.max(10, Math.floor(nodes.length / 5)));
    const repulsionStrength = 50;
    const attractionStrength = 0.01;
    const damping = 0.9;

    for (let iter = 0; iter < iterations; iter++) {
      const forces = {};
      for (const node of nodes) {
        forces[node.id] = { x: 0, y: 0 };
      }

      // Repulsion between all pairs.
      const nodeIds = nodes.map((n) => n.id);
      for (let i = 0; i < nodeIds.length; i++) {
        for (let j = i + 1; j < nodeIds.length; j++) {
          const a = nodePositions[nodeIds[i]];
          const b = nodePositions[nodeIds[j]];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          const force = repulsionStrength / (dist * dist);
          forces[nodeIds[i]].x += (dx / dist) * force;
          forces[nodeIds[i]].y += (dy / dist) * force;
          forces[nodeIds[j]].x -= (dx / dist) * force;
          forces[nodeIds[j]].y -= (dy / dist) * force;
        }
      }

      // Attraction along edges.
      for (const edge of edges) {
        const source = nodePositions[edge.sourceId];
        const target = nodePositions[edge.targetId];
        if (!source || !target) continue;
        const dx = target.x - source.x;
        const dy = target.y - source.y;
        forces[edge.sourceId].x += dx * attractionStrength;
        forces[edge.sourceId].y += dy * attractionStrength;
        forces[edge.targetId].x -= dx * attractionStrength;
        forces[edge.targetId].y -= dy * attractionStrength;
      }

      // Apply forces with damping.
      for (const node of nodes) {
        const pos = nodePositions[node.id];
        const force = forces[node.id];
        if (!pos || !force) continue;
        pos.x += force.x * damping;
        pos.y += force.y * damping;
      }
    }

    // Return computed positions.
    const result = {};
    for (const id of Object.keys(nodePositions)) {
      result[id] = {
        x: Math.round(nodePositions[id].x),
        y: Math.round(nodePositions[id].y)
      };
    }

    self.postMessage({
      type: "layout-result",
      payload: { positions: result },
      requestId: message.requestId
    });
  } catch (error) {
    self.postMessage({
      type: "error",
      payload: { message: error.message },
      requestId: message.requestId
    });
  }
}

function resetState() {
  nodePositions = {};
  edgeList = [];
}
