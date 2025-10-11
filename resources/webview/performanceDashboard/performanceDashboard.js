class SimpleLineChart {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.maxPoints = options.maxPoints ?? 120;
    this.strokeStyle = options.strokeStyle ?? "#1e90ff";
    this.fillStyle = options.fillStyle ?? "rgba(30, 144, 255, 0.1)";
    this.gridStyle = options.gridStyle ?? "rgba(255, 255, 255, 0.08)";
    this.data = [];
    this.labels = [];
  }

  setData(points) {
    this.data = points.map((point) => point.value);
    this.labels = points.map((point) => point.label ?? "");
    this.draw();
  }

  pushPoint(point) {
    this.data.push(point.value);
    this.labels.push(point.label ?? "");
    if (this.data.length > this.maxPoints) {
      this.data.shift();
      this.labels.shift();
    }
    this.draw();
  }

  clear() {
    this.data = [];
    this.labels = [];
    this.draw();
  }

  draw() {
    const ctx = this.ctx;
    if (!ctx) {
      return;
    }
    const { width, height } = this.canvas;
    ctx.clearRect(0, 0, width, height);
    ctx.save();
    ctx.strokeStyle = this.gridStyle;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, height - 0.5);
    ctx.lineTo(width, height - 0.5);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0.5, 0);
    ctx.lineTo(0.5, height);
    ctx.stroke();

    if (this.data.length === 0) {
      ctx.restore();
      return;
    }

    const maxValue = Math.max(...this.data);
    const minValue = Math.min(...this.data);
    const valueRange = maxValue - minValue || 1;
    const pointSpacing = width / Math.max(this.data.length - 1, 1);

    ctx.lineWidth = 2;
    ctx.strokeStyle = this.strokeStyle;
    ctx.beginPath();

    this.data.forEach((value, index) => {
      const normalized = (value - minValue) / valueRange;
      const x = index * pointSpacing;
      const y = height - normalized * height;
      if (index === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    });

    ctx.stroke();
    ctx.restore();
  }
}

class PerformanceDashboard {
  constructor() {
    this.vscode = acquireVsCodeApi();
    this.isRealTimeEnabled = true;
    this.charts = {};
    this.lastUpdate = Date.now();
    this.performancePoints = [];
    this.memoryPoints = [];

    this.initializeEventListeners();
    this.initializeCharts();
    this.requestInitialData();
  }

  initializeEventListeners() {
    document.getElementById("refresh-btn")?.addEventListener("click", () => {
      this.requestMetricsUpdate();
    });

    document.getElementById("export-btn")?.addEventListener("click", () => {
      this.exportPerformanceReport();
    });

    document.getElementById("realtime-toggle")?.addEventListener("change", (event) => {
      const checked = Boolean(event.target?.checked);
      this.toggleRealTimeUpdates(checked);
    });

    window.addEventListener("message", (event) => {
      this.handleMessage(event.data);
    });
  }

  initializeCharts() {
    this.charts.performance = new SimpleLineChart(document.getElementById("performance-chart"), {
      strokeStyle: "#1e90ff",
      fillStyle: "rgba(30, 144, 255, 0.2)"
    });
    this.charts.memory = new SimpleLineChart(document.getElementById("memory-chart"), {
      strokeStyle: "#4ec9b0",
      fillStyle: "rgba(78, 201, 176, 0.2)"
    });
  }

  requestInitialData() {
    this.requestMetricsUpdate();
    this.vscode.postMessage({ type: "requestHistorical" });
  }

  requestMetricsUpdate() {
    this.vscode.postMessage({ type: "requestMetrics" });
  }

  exportPerformanceReport() {
    this.vscode.postMessage({ type: "exportReport" });
  }

  toggleRealTimeUpdates(enabled) {
    this.isRealTimeEnabled = enabled;
    this.vscode.postMessage({ type: "toggleRealTime", payload: enabled });
  }

  handleMessage(message) {
    if (!message || typeof message.type !== "string") {
      return;
    }

    switch (message.type) {
      case "metricsUpdate":
        this.updateDashboard(message.data);
        break;
      case "historicalData":
        this.updateCharts(message.data);
        break;
      case "systemAlert":
        this.showAlert(message.data);
        break;
      default:
        break;
    }
  }

  updateDashboard(metrics) {
    if (!metrics) {
      return;
    }
    const { realTime, session, insights, historical } = metrics;
    this.updateMetricCards(realTime, session);
    this.updateOperationsList(realTime.currentOperations);
    this.updateHealthIndicators(insights.alerts ?? []);
    this.updateBottlenecks(insights.bottlenecks ?? []);
    this.updateRecommendations(insights.recommendations ?? []);

    if (historical) {
      this.updateCharts(historical);
    }

    this.performancePoints.push({ value: session.averageOperationTime, label: new Date().toLocaleTimeString() });
    this.memoryPoints.push({ value: realTime.memoryUsage.heapUsed, label: new Date().toLocaleTimeString() });
    this.charts.performance.pushPoint(this.performancePoints.at(-1));
    this.charts.memory.pushPoint(this.memoryPoints.at(-1));
    this.lastUpdate = Date.now();
  }

  updateMetricCards(realTimeMetrics, sessionMetrics) {
    const activeOperations = realTimeMetrics.currentOperations ?? [];
    const memoryUsage = realTimeMetrics.memoryUsage ?? { heapUsed: 0 };

    const activeElement = document.getElementById("active-operations");
    if (activeElement) {
      activeElement.textContent = String(activeOperations.length);
    }

    const memoryElement = document.getElementById("memory-usage");
    if (memoryElement) {
      memoryElement.textContent = this.formatMemory(memoryUsage.heapUsed);
    }

    const operationsRate = document.getElementById("operations-rate");
    if (operationsRate) {
      const minutes = Math.max(sessionMetrics.duration / 60000, 1);
      const rate = sessionMetrics.operationsCompleted / minutes;
      operationsRate.textContent = `${rate.toFixed(1)}`;
    }

    const durationElement = document.getElementById("session-duration");
    if (durationElement) {
      durationElement.textContent = this.formatDuration(sessionMetrics.duration);
    }
  }

  updateOperationsList(operations) {
    const container = document.getElementById("operations-list");
    if (!container) {
      return;
    }
    container.textContent = "";

    operations.forEach((operation) => {
      const element = document.createElement("div");
      element.className = "operation-item";

      const header = document.createElement("header");
      const title = document.createElement("span");
      title.textContent = operation.name;
      const duration = document.createElement("span");
      duration.textContent = this.formatDuration(operation.duration ?? 0);
      header.appendChild(title);
      header.appendChild(duration);

      element.appendChild(header);

      if (typeof operation.progress === "number") {
        const progress = document.createElement("div");
        progress.textContent = `Progress: ${(operation.progress * 100).toFixed(0)}%`;
        element.appendChild(progress);
      }

      if (operation.metadata) {
        const meta = document.createElement("div");
        meta.textContent = JSON.stringify(operation.metadata);
        meta.className = "operation-meta";
        element.appendChild(meta);
      }

      container.appendChild(element);
    });
  }

  updateHealthIndicators(alerts) {
    const container = document.getElementById("health-indicators");
    if (!container) {
      return;
    }
    container.textContent = "";

    if (!alerts || alerts.length === 0) {
      const healthy = document.createElement("div");
      healthy.className = "health-indicator";
      healthy.textContent = "System healthy";
      container.appendChild(healthy);
      return;
    }

    alerts.slice(-10).forEach((alert) => {
      const element = document.createElement("div");
      element.className = `health-indicator alert ${alert.severity}`;
      const title = document.createElement("strong");
      title.textContent = alert.message;
      element.appendChild(title);
      if (alert.metadata) {
        const metadata = document.createElement("div");
        metadata.textContent = JSON.stringify(alert.metadata);
        element.appendChild(metadata);
      }
      container.appendChild(element);
    });
  }

  updateBottlenecks(bottlenecks) {
    const container = document.getElementById("bottlenecks-list");
    if (!container) {
      return;
    }
    container.textContent = "";

    if (!bottlenecks || bottlenecks.length === 0) {
      const empty = document.createElement("div");
      empty.className = "bottleneck-item";
      empty.textContent = "No bottlenecks detected.";
      container.appendChild(empty);
      return;
    }

    bottlenecks.slice(0, 6).forEach((bottleneck) => {
      const element = document.createElement("div");
      element.className = "bottleneck-item";

      const header = document.createElement("header");
      const name = document.createElement("span");
      name.textContent = `${bottleneck.operation} (${bottleneck.type})`;
      const severity = document.createElement("span");
      severity.textContent = bottleneck.severity;
      header.appendChild(name);
      header.appendChild(severity);

      const description = document.createElement("div");
      description.textContent = bottleneck.description;

      const impact = document.createElement("div");
      impact.textContent = `Impact: ${(bottleneck.impact * 100).toFixed(0)}%`;

      element.appendChild(header);
      element.appendChild(description);
      element.appendChild(impact);

      if (Array.isArray(bottleneck.suggestions)) {
        const list = document.createElement("ul");
        bottleneck.suggestions.slice(0, 3).forEach((suggestion) => {
          const item = document.createElement("li");
          item.textContent = suggestion;
          list.appendChild(item);
        });
        element.appendChild(list);
      }

      container.appendChild(element);
    });
  }

  updateRecommendations(recommendations) {
    const container = document.getElementById("recommendations-list");
    if (!container) {
      return;
    }
    container.textContent = "";

    if (!recommendations || recommendations.length === 0) {
      const empty = document.createElement("div");
      empty.className = "recommendation-item";
      empty.textContent = "No recommendations available.";
      container.appendChild(empty);
      return;
    }

    recommendations.slice(0, 6).forEach((recommendation) => {
      const element = document.createElement("div");
      element.className = "recommendation-item";

      const header = document.createElement("header");
      const title = document.createElement("span");
      title.textContent = recommendation.title;
      const priority = document.createElement("span");
      priority.textContent = recommendation.priority;
      header.appendChild(title);
      header.appendChild(priority);

      const description = document.createElement("div");
      description.textContent = recommendation.description;

      element.appendChild(header);
      element.appendChild(description);

      if (Array.isArray(recommendation.actionItems)) {
        const list = document.createElement("ul");
        recommendation.actionItems.slice(0, 3).forEach((action) => {
          const item = document.createElement("li");
          item.textContent = action;
          list.appendChild(item);
        });
        element.appendChild(list);
      }

      container.appendChild(element);
    });
  }

  updateCharts(historical) {
    if (!historical) {
      return;
    }
    if (historical.operationTrends) {
      const points = historical.operationTrends.slice(-120).map((entry) => ({
        value: entry.value,
        label: new Date(entry.timestamp).toLocaleTimeString()
      }));
      this.charts.performance.setData(points);
    }

    if (historical.memoryTrends) {
      const points = historical.memoryTrends.slice(-120).map((entry) => ({
        value: entry.value,
        label: new Date(entry.timestamp).toLocaleTimeString()
      }));
      this.charts.memory.setData(points);
    }
  }

  showAlert(alert) {
    if (!alert) {
      return;
    }
    const severity = alert.severity ?? "info";
    const message = alert.message ?? "System alert";
    const detail = alert.details ? `\n${alert.details}` : "";
  const notification = `Performance Alert (${severity.toUpperCase()}): ${message}${detail}`;
  console.log(notification);
  }

  formatMemory(bytes) {
    const mb = bytes / (1024 * 1024);
    if (!Number.isFinite(mb)) {
      return "-- MB";
    }
    return `${mb.toFixed(1)} MB`;
  }

  formatDuration(ms) {
    if (ms < 1_000) {
      return `${Math.round(ms)} ms`;
    }
    if (ms < 60_000) {
      return `${(ms / 1_000).toFixed(1)} s`;
    }
    return `${(ms / 60_000).toFixed(1)} m`;
  }
}

document.addEventListener("DOMContentLoaded", () => {
  window.__performanceDashboard = new PerformanceDashboard();
});
