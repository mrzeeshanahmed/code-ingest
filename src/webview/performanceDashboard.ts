import * as path from "node:path";
import * as vscode from "vscode";

import {
  type ActiveOperationSnapshot,
  type PerformanceBenchmark,
  type PerformanceMetrics,
  type PerformanceMonitor,
  type PerformanceReport,
  type PerformanceSessionSummary,
  type OptimizationRecommendation
} from "../services/performanceMonitor";
import type { DiagnosticResult, DiagnosticService, SystemHealthReport } from "../services/diagnosticService";

export interface PerformanceDashboardData {
  currentSession: SessionMetrics;
  historicalData: HistoricalMetrics;
  realTimeMetrics: RealTimeMetrics;
  recommendations: PerformanceRecommendation[];
  benchmarks: BenchmarkComparison[];
}

export interface SessionMetrics {
  sessionId: string;
  startTime: Date;
  duration: number;
  operationsCompleted: number;
  averageOperationTime: number;
  memoryPeak: number;
  errorsEncountered: number;
}

export interface HistoricalMetrics {
  sessions: SessionSummary[];
  trends: PerformanceTrend[];
  aggregatedStats: AggregatedStats;
  operationBreakdown: OperationBreakdown[];
}

export interface RealTimeMetrics {
  cpuUsage: number;
  memoryUsage: NodeJS.MemoryUsage;
  activeOperations: ActiveOperation[];
  queuedOperations: number;
  lastOperation?: OperationSummary;
}

export interface SessionSummary {
  sessionId: string;
  startTime: Date;
  duration: number;
  operations: number;
  averageOperationTime: number;
  memoryPeak: number;
  errorRate: number;
}

export interface PerformanceTrend {
  timestamp: string;
  averageOperationTime: number;
  peakMemoryMB: number;
  errorRate: number;
  operations: number;
}

export interface AggregatedStats {
  totalOperations: number;
  totalDuration: number;
  averageDuration: number;
  successRate: number;
  errorRate: number;
  peakMemoryMB: number;
  operationsPerMinute: number;
}

export interface OperationBreakdown {
  operation: string;
  count: number;
  averageDuration: number;
}

export interface ActiveOperation {
  id: string;
  name: string;
  startTime: number;
  duration: number;
  metadata: Record<string, unknown>;
  resourceUsage: {
    fileOperations: number;
    networkRequests: number;
  };
  progress?: number;
}

export interface OperationSummary {
  id: string;
  name: string;
  duration: number;
  success: boolean;
  timestamp: number;
  memoryUsageMB: number;
}

export interface PerformanceRecommendation {
  title: string;
  description: string;
  priority: "high" | "medium" | "low";
  category: "performance" | "memory" | "network" | "configuration" | "diagnostics";
  impact: number;
  actionItems: string[];
  relatedOperations: string[];
}

export interface BenchmarkComparison {
  operation: string;
  baseline: number;
  averageDuration: number;
  threshold: number;
  trend: "improving" | "degrading" | "stable";
  percentiles: {
    p50: number;
    p90: number;
    p95: number;
    p99: number;
  };
}

interface DashboardRealtimeUpdate {
  metrics: RealTimeMetrics;
  charts: ChartUpdatePayload;
  session: SessionMetrics;
}

interface ChartUpdatePayload {
  performance?: ChartDataLike;
  memory?: ChartDataLike;
  error?: ChartDataLike;
  operation?: ChartDataLike;
}

interface ChartDataLike {
  labels: string[];
  datasets: Array<Record<string, unknown>>;
}

const MS_IN_SECOND = 1000;
const MS_IN_MINUTE = 60 * MS_IN_SECOND;
const BYTES_IN_MB = 1024 * 1024;

export class PerformanceDashboardDataProvider {
  private lastCpuUsage?: NodeJS.CpuUsage;
  private lastCpuTimestamp?: number;

  constructor(
    private readonly performanceMonitor: PerformanceMonitor,
    private readonly diagnosticService: DiagnosticService
  ) {}

  async getDashboardData(): Promise<PerformanceDashboardData> {
    const [report, history, benchmarks, diagnostics] = await Promise.all([
      Promise.resolve(this.performanceMonitor.generateReport()),
      Promise.resolve(this.performanceMonitor.getMetricsHistory()),
      Promise.resolve(this.performanceMonitor.getBenchmarks()),
      this.safeRunDiagnostics()
    ]);

    const sessionSummary = this.performanceMonitor.getSessionSummary();
    const currentSession = this.buildSessionMetrics(sessionSummary);
    const historicalData = this.buildHistoricalMetrics(history, currentSession, report);
    const realTimeMetrics = await this.getRealTimeMetrics(history, sessionSummary);
    const recommendations = this.buildRecommendations(report.recommendations, diagnostics);
    const benchmarkComparisons = this.buildBenchmarkComparisons(benchmarks, report);

    return {
      currentSession,
      historicalData,
      realTimeMetrics,
      recommendations,
      benchmarks: benchmarkComparisons
    };
  }

  async getRealtimeUpdate(): Promise<DashboardRealtimeUpdate> {
    const history = this.performanceMonitor.getMetricsHistory();
    const session = this.performanceMonitor.getSessionSummary();
    const metrics = await this.getRealTimeMetrics(history, session);
    const charts = this.buildRealtimeCharts(history);
    const sessionMetrics = this.buildSessionMetrics(session);
    return { metrics, charts, session: sessionMetrics };
  }

  private async getRealTimeMetrics(
    history: PerformanceMetrics[],
    session: PerformanceSessionSummary
  ): Promise<RealTimeMetrics> {
    const cpuUsage = this.calculateCpuUsage();
    const memoryUsage = process.memoryUsage();
    const activeOperations = this.performanceMonitor.getActiveOperationsSnapshot().map((operation) => this.toActiveOperation(operation));
    const lastMetric = history.at(-1);

    const lastOperation: OperationSummary | undefined = lastMetric
      ? {
          id: lastMetric.operationId,
          name: lastMetric.operationType,
          duration: lastMetric.duration,
          success: typeof lastMetric.metadata.error !== "string",
          timestamp: this.resolveTimestamp(lastMetric),
          memoryUsageMB: lastMetric.memoryUsage.peak.heapUsed / BYTES_IN_MB
        }
      : undefined;

    const base: RealTimeMetrics = {
      cpuUsage,
      memoryUsage,
      activeOperations,
      queuedOperations: Math.max(session.operationsCompleted - history.length, 0)
    };

    if (lastOperation) {
      base.lastOperation = lastOperation;
    }

    return base;
  }

  private buildRealtimeCharts(history: PerformanceMetrics[]): ChartUpdatePayload {
    if (history.length === 0) {
      return {};
    }

    const labels = history.map((metric, index) => this.formatTimestamp(metric, index));
    const operationBreakdown = this.computeOperationBreakdown(history);

    return {
      performance: {
        labels,
        datasets: [
          {
            label: "Average Operation Time (ms)",
            data: history.map((metric) => metric.duration),
            borderColor: "rgb(75, 192, 192)",
            backgroundColor: "rgba(75, 192, 192, 0.1)",
            tension: 0.1
          }
        ]
      },
      memory: {
        labels,
        datasets: [
          {
            label: "Peak Memory (MB)",
            data: history.map((metric) => metric.memoryUsage.peak.heapUsed / BYTES_IN_MB),
            borderColor: "rgb(255, 99, 132)",
            backgroundColor: "rgba(255, 99, 132, 0.1)",
            tension: 0.1
          }
        ]
      },
      error: {
        labels,
        datasets: [
          {
            label: "Error Rate (%)",
            data: this.computeErrorRates(history),
            backgroundColor: "rgba(255, 99, 132, 0.5)",
            borderColor: "rgb(255, 99, 132)",
            borderWidth: 1
          }
        ]
      },
      operation: {
        labels: operationBreakdown.map((item) => item.operation),
        datasets: [
          {
            data: operationBreakdown.map((item) => item.count),
            backgroundColor: ["#FF6384", "#36A2EB", "#FFCE56", "#4BC0C0", "#9966FF", "#FF9F40"]
          }
        ]
      }
    };
  }

  private buildSessionMetrics(summary: PerformanceSessionSummary): SessionMetrics {
    return {
      sessionId: summary.sessionId,
      startTime: new Date(summary.startTime),
      duration: summary.duration,
      operationsCompleted: summary.operationsCompleted,
      averageOperationTime: summary.averageOperationTime,
      memoryPeak: summary.memoryPeak,
      errorsEncountered: summary.errorsEncountered
    };
  }

  private buildHistoricalMetrics(
    history: PerformanceMetrics[],
    currentSession: SessionMetrics,
    report: PerformanceReport
  ): HistoricalMetrics {
    const aggregatedStats = this.computeAggregatedStats(history, currentSession);
    const trends = history.map((metric, index) => ({
      timestamp: this.formatTimestamp(metric, index),
      averageOperationTime: metric.duration,
      peakMemoryMB: metric.memoryUsage.peak.heapUsed / BYTES_IN_MB,
      errorRate: this.computeCumulativeErrorRate(history, index),
      operations: 1
    }));

    const operationBreakdown = this.computeOperationBreakdown(history, report);

    return {
      sessions: [
        {
          sessionId: currentSession.sessionId,
          startTime: currentSession.startTime,
          duration: currentSession.duration,
          operations: currentSession.operationsCompleted,
          averageOperationTime: currentSession.averageOperationTime,
          memoryPeak: currentSession.memoryPeak,
          errorRate: aggregatedStats.errorRate
        }
      ],
      trends,
      aggregatedStats,
      operationBreakdown
    };
  }

  private buildRecommendations(
    recommendations: OptimizationRecommendation[],
    diagnostics: SystemHealthReport | undefined
  ): PerformanceRecommendation[] {
    const mapped = recommendations.map<PerformanceRecommendation>((recommendation) => ({
      title: recommendation.title,
      description: recommendation.description,
      priority: recommendation.priority,
      category: recommendation.category,
      impact: recommendation.estimatedImpact,
      actionItems: [...recommendation.actionItems],
      relatedOperations: [...recommendation.relatedOperations]
    }));

    if (!diagnostics) {
      return mapped;
    }

    diagnostics.recommendations.forEach((suggestion) => {
      mapped.push({
        title: "Diagnostics Recommendation",
        description: suggestion,
        priority: "medium",
        category: "diagnostics",
        impact: 0.3,
        actionItems: [suggestion],
        relatedOperations: []
      });
    });

    return mapped;
  }

  private buildBenchmarkComparisons(
    benchmarks: PerformanceBenchmark[],
    report: PerformanceReport
  ): BenchmarkComparison[] {
    const byOperation = report.byOperation;

    return benchmarks.map((benchmark) => {
      const stats = byOperation.get(benchmark.operation);
      return {
        operation: benchmark.operation,
        baseline: benchmark.baseline,
        averageDuration: stats?.averageDuration ?? benchmark.baseline,
        threshold: benchmark.threshold,
        trend: benchmark.trend,
        percentiles: benchmark.percentiles
      };
    });
  }

  private computeAggregatedStats(history: PerformanceMetrics[], currentSession: SessionMetrics): AggregatedStats {
    if (history.length === 0) {
      return {
        totalOperations: 0,
        totalDuration: 0,
        averageDuration: 0,
        successRate: 1,
        errorRate: 0,
        peakMemoryMB: 0,
        operationsPerMinute: currentSession.duration === 0 ? 0 : 0
      };
    }

    const totalOperations = history.length;
    const totalDuration = history.reduce((sum, metric) => sum + metric.duration, 0);
    const errors = history.filter((metric) => typeof metric.metadata.error === "string").length;
    const successRate = totalOperations === 0 ? 1 : (totalOperations - errors) / totalOperations;
    const errorRate = totalOperations === 0 ? 0 : errors / totalOperations;
    const peakMemoryMB = history.reduce((peak, metric) => {
      const current = metric.memoryUsage.peak.heapUsed / BYTES_IN_MB;
      return current > peak ? current : peak;
    }, 0);
    const operationsPerMinute = currentSession.duration === 0
      ? 0
      : totalOperations / (currentSession.duration / MS_IN_MINUTE);

    return {
      totalOperations,
      totalDuration,
      averageDuration: totalDuration / totalOperations,
      successRate,
      errorRate,
      peakMemoryMB,
      operationsPerMinute
    };
  }

  private computeOperationBreakdown(
    history: PerformanceMetrics[],
    report?: PerformanceReport
  ): OperationBreakdown[] {
    const counts = new Map<string, { count: number; total: number }>();

    history.forEach((metric) => {
      const entry = counts.get(metric.operationType) ?? { count: 0, total: 0 };
      entry.count += 1;
      entry.total += metric.duration;
      counts.set(metric.operationType, entry);
    });

    if (report) {
      report.byOperation.forEach((stats, operation) => {
        const entry = counts.get(operation) ?? { count: 0, total: 0 };
        entry.count = Math.max(entry.count, stats.count);
        entry.total = Math.max(entry.total, stats.totalDuration);
        counts.set(operation, entry);
      });
    }

    return Array.from(counts.entries()).map(([operation, value]) => ({
      operation,
      count: value.count,
      averageDuration: value.count === 0 ? 0 : value.total / value.count
    }));
  }

  private computeErrorRates(history: PerformanceMetrics[]): number[] {
    return history.map((metric, index) => this.computeCumulativeErrorRate(history, index) * 100);
  }

  private computeCumulativeErrorRate(history: PerformanceMetrics[], index: number): number {
    const slice = history.slice(0, index + 1);
    if (slice.length === 0) {
      return 0;
    }
    const errors = slice.filter((metric) => typeof metric.metadata.error === "string").length;
    return errors / slice.length;
  }

  private formatTimestamp(metric: PerformanceMetrics, index: number): string {
    const completedAt = metric.metadata.completedAt;
    if (typeof completedAt === "string") {
      return completedAt;
    }
    return `Operation ${index + 1}`;
  }

  private resolveTimestamp(metric: PerformanceMetrics): number {
    const completedAt = metric.metadata.completedAt;
    if (typeof completedAt === "string") {
      const parsed = Date.parse(completedAt);
      return Number.isNaN(parsed) ? Date.now() : parsed;
    }
    return Date.now();
  }

  private toActiveOperation(operation: ActiveOperationSnapshot): ActiveOperation {
    return {
      id: operation.operationId,
      name: operation.operationType,
      startTime: operation.startedAt,
      duration: Math.max(Date.now() - operation.startedAt, 0),
      metadata: { ...operation.metadata },
      resourceUsage: {
        fileOperations: operation.resourceUsage.fileOperations,
        networkRequests: operation.resourceUsage.networkRequests
      }
    };
  }

  private calculateCpuUsage(): number {
    const now = Date.now();
    if (!this.lastCpuUsage || !this.lastCpuTimestamp) {
      this.lastCpuUsage = process.cpuUsage();
      this.lastCpuTimestamp = now;
      return 0;
    }

    const diff = process.cpuUsage(this.lastCpuUsage);
    const elapsedMs = now - this.lastCpuTimestamp;
    this.lastCpuUsage = process.cpuUsage();
    this.lastCpuTimestamp = now;

    if (elapsedMs <= 0) {
      return 0;
    }

    const totalMicros = diff.user + diff.system;
    const cpuPercent = (totalMicros / 1000) / elapsedMs * 100;
    return Math.max(0, Math.min(100, Number(cpuPercent.toFixed(2))));
  }

  private async safeRunDiagnostics(): Promise<SystemHealthReport | undefined> {
    try {
      return await this.diagnosticService.runDiagnostics(["performance"]);
    } catch (error) {
      console.warn("performance.dashboard.diagnosticsFailed", error);
      return undefined;
    }
  }
}

export class PerformanceDashboard {
  private panel: vscode.WebviewPanel | undefined;
  private updateInterval: NodeJS.Timeout | undefined;
  private readonly UPDATE_INTERVAL = 1_000;
  private readonly dataProvider: PerformanceDashboardDataProvider;
  private readonly reportGenerator: PerformanceReportGenerator;

  constructor(
    performanceMonitor: PerformanceMonitor,
    diagnosticService: DiagnosticService,
    private readonly context: vscode.ExtensionContext,
    dataProvider?: PerformanceDashboardDataProvider,
    reportGenerator?: PerformanceReportGenerator
  ) {
    this.dataProvider = dataProvider ?? new PerformanceDashboardDataProvider(performanceMonitor, diagnosticService);
    this.reportGenerator = reportGenerator ?? new PerformanceReportGenerator(performanceMonitor, diagnosticService);
  }

  async show(): Promise<void> {
    if (this.panel) {
      this.panel.reveal();
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      "performanceDashboard",
      "Code Ingest Performance Dashboard",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.file(path.join(this.context.extensionPath, "resources"))]
      }
    );

    this.panel.webview.html = await this.generateDashboardHTML(this.panel);
    this.setupMessageHandling(this.panel);
    this.startRealTimeUpdates();

    this.panel.onDidDispose(() => {
      this.stopRealTimeUpdates();
      this.panel = undefined;
    });
  }

  private async generateDashboardHTML(panel: vscode.WebviewPanel): Promise<string> {
    const data = await this.dataProvider.getDashboardData();
    const chartJsUri = panel.webview.asWebviewUri(
      vscode.Uri.file(path.join(this.context.extensionPath, "resources", "chart.min.js"))
    );

    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Performance Dashboard</title>
        <script src="${chartJsUri}"></script>
        <style>${this.getDashboardCSS()}</style>
      </head>
      <body>
        <div class="dashboard-container">
          <header class="dashboard-header">
            <h1>Code Ingest Performance Dashboard</h1>
            <div class="header-controls">
              <button id="refreshBtn" class="btn btn-primary">Refresh</button>
              <button id="exportBtn" class="btn btn-secondary">Export Report</button>
            </div>
          </header>

          <div class="metrics-grid">
            <div class="metric-card">
              <h3>Current Session</h3>
              <div class="metric-value" id="sessionDuration">${this.formatDuration(data.currentSession.duration)}</div>
              <div class="metric-label">Session Duration</div>
            </div>

            <div class="metric-card">
              <h3>Operations Completed</h3>
              <div class="metric-value" id="operationsCompleted">${data.currentSession.operationsCompleted}</div>
              <div class="metric-label">Total Operations</div>
            </div>

            <div class="metric-card">
              <h3>Average Time</h3>
              <div class="metric-value" id="averageTime">${this.formatDuration(data.currentSession.averageOperationTime)}</div>
              <div class="metric-label">Per Operation</div>
            </div>

            <div class="metric-card">
              <h3>Memory Peak</h3>
              <div class="metric-value" id="memoryPeak">${this.formatBytes(data.currentSession.memoryPeak)}</div>
              <div class="metric-label">Peak Usage</div>
            </div>
          </div>

          <div class="charts-container">
            <div class="chart-panel">
              <h3>Operation Performance Over Time</h3>
              <canvas id="performanceChart" width="400" height="200"></canvas>
            </div>

            <div class="chart-panel">
              <h3>Memory Usage</h3>
              <canvas id="memoryChart" width="400" height="200"></canvas>
            </div>

            <div class="chart-panel">
              <h3>Operation Distribution</h3>
              <canvas id="operationChart" width="400" height="200"></canvas>
            </div>

            <div class="chart-panel">
              <h3>Error Rate Trend</h3>
              <canvas id="errorChart" width="400" height="200"></canvas>
            </div>
          </div>

          <div class="recommendations-panel">
            <h3>Performance Recommendations</h3>
            <div id="recommendations">
              ${this.renderRecommendations(data.recommendations)}
            </div>
          </div>

          <div class="active-operations">
            <h3>Active Operations</h3>
            <div id="activeOperations">
              ${this.renderActiveOperations(data.realTimeMetrics.activeOperations)}
            </div>
            <div id="resourceMetrics" class="resource-metrics">
              ${this.renderResourceMetrics(data.realTimeMetrics)}
            </div>
          </div>
        </div>

        <script>
          ${this.getDashboardJS(data)}
        </script>
      </body>
      </html>
    `;
  }

  private getDashboardCSS(): string {
    return `
      body {
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        margin: 0;
        padding: 20px;
        background-color: var(--vscode-editor-background);
        color: var(--vscode-editor-foreground);
      }

      .dashboard-container {
        max-width: 1200px;
        margin: 0 auto;
      }

      .dashboard-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 30px;
        padding-bottom: 20px;
        border-bottom: 1px solid var(--vscode-panel-border);
      }

      .header-controls {
        display: flex;
        gap: 10px;
      }

      .btn {
        padding: 8px 16px;
        border: none;
        border-radius: 4px;
        cursor: pointer;
        font-size: 14px;
      }

      .btn-primary {
        background-color: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
      }

      .btn-secondary {
        background-color: var(--vscode-button-secondaryBackground);
        color: var(--vscode-button-secondaryForeground);
      }

      .metrics-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
        gap: 20px;
        margin-bottom: 30px;
      }

      .metric-card {
        background: var(--vscode-panel-background);
        border: 1px solid var(--vscode-panel-border);
        border-radius: 8px;
        padding: 20px;
        text-align: center;
      }

      .metric-value {
        font-size: 2rem;
        font-weight: bold;
        color: var(--vscode-charts-blue);
        margin: 10px 0;
      }

      .metric-label {
        color: var(--vscode-descriptionForeground);
        font-size: 0.9rem;
      }

      .charts-container {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(500px, 1fr));
        gap: 20px;
        margin-bottom: 30px;
      }

      .chart-panel {
        background: var(--vscode-panel-background);
        border: 1px solid var(--vscode-panel-border);
        border-radius: 8px;
        padding: 20px;
      }

      .recommendations-panel, .active-operations {
        background: var(--vscode-panel-background);
        border: 1px solid var(--vscode-panel-border);
        border-radius: 8px;
        padding: 20px;
        margin-bottom: 20px;
      }

      .resource-metrics {
        margin-top: 16px;
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
        gap: 12px;
        font-size: 0.95rem;
        color: var(--vscode-descriptionForeground);
      }

      .recommendation {
        padding: 10px;
        margin: 10px 0;
        border-left: 4px solid var(--vscode-charts-orange);
        background: var(--vscode-textCodeBlock-background);
      }

      .recommendation.high-priority {
        border-left-color: var(--vscode-charts-red);
      }

      .recommendation.medium-priority {
        border-left-color: var(--vscode-charts-yellow);
      }

      .recommendation.low-priority {
        border-left-color: var(--vscode-charts-green);
      }

      .active-operation {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 8px 0;
        border-bottom: 1px solid var(--vscode-panel-border);
      }

      .operation-name {
        font-weight: 500;
      }

      .operation-duration {
        color: var(--vscode-descriptionForeground);
        font-size: 0.9rem;
      }

      .operation-progress {
        width: 100px;
        height: 4px;
        background: var(--vscode-progressBar-background);
        border-radius: 2px;
        overflow: hidden;
      }

      .operation-progress-fill {
        height: 100%;
        background: var(--vscode-charts-blue);
        transition: width 0.3s ease;
      }
    `;
  }

  private getDashboardJS(data: PerformanceDashboardData): string {
    const distribution = this.prepareOperationDistributionData(data);
    return `
      const vscode = acquireVsCodeApi();
      const initialData = ${JSON.stringify({
        trends: data.historicalData.trends,
        memory: data.historicalData.trends.map((trend) => trend.peakMemoryMB),
        errorRates: data.historicalData.trends.map((trend) => trend.errorRate * 100),
        labels: data.historicalData.trends.map((trend) => trend.timestamp),
        operationDistribution: distribution
      })};

      const charts = {};

      const performanceCtx = document.getElementById('performanceChart').getContext('2d');
      charts.performance = new Chart(performanceCtx, {
        type: 'line',
        data: {
          labels: initialData.labels,
          datasets: [{
            label: 'Average Operation Time (ms)',
            data: initialData.trends.map((trend) => trend.averageOperationTime),
            borderColor: 'rgb(75, 192, 192)',
            backgroundColor: 'rgba(75, 192, 192, 0.1)',
            tension: 0.1
          }]
        }
      });

      const memoryCtx = document.getElementById('memoryChart').getContext('2d');
      charts.memory = new Chart(memoryCtx, {
        type: 'line',
        data: {
          labels: initialData.labels,
          datasets: [{
            label: 'Peak Memory (MB)',
            data: initialData.memory,
            borderColor: 'rgb(255, 99, 132)',
            backgroundColor: 'rgba(255, 99, 132, 0.1)',
            tension: 0.1
          }]
        }
      });

      const operationCtx = document.getElementById('operationChart').getContext('2d');
      charts.operation = new Chart(operationCtx, {
        type: 'doughnut',
        data: {
          labels: initialData.operationDistribution.labels,
          datasets: [{
            data: initialData.operationDistribution.values,
            backgroundColor: ['#FF6384', '#36A2EB', '#FFCE56', '#4BC0C0', '#9966FF', '#FF9F40']
          }]
        },
        options: {
          plugins: {
            legend: {
              position: 'bottom'
            }
          }
        }
      });

      const errorCtx = document.getElementById('errorChart').getContext('2d');
      charts.error = new Chart(errorCtx, {
        type: 'bar',
        data: {
          labels: initialData.labels,
          datasets: [{
            label: 'Error Rate (%)',
            data: initialData.errorRates,
            backgroundColor: 'rgba(255, 99, 132, 0.5)',
            borderColor: 'rgb(255, 99, 132)',
            borderWidth: 1
          }]
        },
        options: {
          scales: {
            y: {
              beginAtZero: true,
              max: 100
            }
          }
        }
      });

      document.getElementById('refreshBtn').addEventListener('click', () => {
        vscode.postMessage({ type: 'refresh' });
      });

      document.getElementById('exportBtn').addEventListener('click', () => {
        vscode.postMessage({ type: 'export' });
      });

      window.addEventListener('message', (event) => {
        const message = event.data;
        if (!message) {
          return;
        }

        switch (message.type) {
          case 'updateMetrics':
            updateRealTimeMetrics(message.data);
            break;
          case 'updateCharts':
            updateCharts(message.data);
            break;
          case 'refreshData':
            applyFullRefresh(message.data);
            break;
        }
      });

      function applyFullRefresh(data) {
        if (data.currentSession) {
          document.getElementById('sessionDuration').textContent = formatDuration(data.currentSession.duration);
          document.getElementById('operationsCompleted').textContent = data.currentSession.operationsCompleted;
          document.getElementById('averageTime').textContent = formatDuration(data.currentSession.averageOperationTime);
          document.getElementById('memoryPeak').textContent = formatBytes(data.currentSession.memoryPeak);
        }

        if (data.recommendationsHtml) {
          document.getElementById('recommendations').innerHTML = data.recommendationsHtml;
        }

        if (data.activeOperationsHtml) {
          document.getElementById('activeOperations').innerHTML = data.activeOperationsHtml;
        }

        if (data.resourceMetricsHtml) {
          document.getElementById('resourceMetrics').innerHTML = data.resourceMetricsHtml;
        }

        if (data.charts) {
          updateCharts(data.charts);
        }
      }

      function updateRealTimeMetrics(data) {
        document.getElementById('sessionDuration').textContent = formatDuration(data.sessionDuration);
        document.getElementById('operationsCompleted').textContent = data.operationsCompleted;
        document.getElementById('averageTime').textContent = formatDuration(data.averageOperationTime);
        document.getElementById('memoryPeak').textContent = formatBytes(data.memoryPeak);
        document.getElementById('activeOperations').innerHTML = data.activeOperationsHtml;
        if (data.resourceMetricsHtml) {
          document.getElementById('resourceMetrics').innerHTML = data.resourceMetricsHtml;
        }
      }

      function updateCharts(data) {
        Object.keys(data).forEach((key) => {
          if (!charts[key]) {
            return;
          }
          charts[key].data = data[key];
          charts[key].update('none');
        });
      }

      function formatDuration(ms) {
        if (ms < 1000) return ms.toFixed(0) + 'ms';
        if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
        return (ms / 60000).toFixed(1) + 'm';
      }

      function formatBytes(bytes) {
        const units = ['B', 'KB', 'MB', 'GB'];
        let size = bytes;
        let unitIndex = 0;
        while (size >= 1024 && unitIndex < units.length - 1) {
          size /= 1024;
          unitIndex++;
        }
        return size.toFixed(1) + ' ' + units[unitIndex];
      }
    `;
  }

  private prepareOperationDistributionData(data: PerformanceDashboardData): { labels: string[]; values: number[] } {
    const breakdown = data.historicalData.operationBreakdown;
    if (breakdown.length === 0) {
      return { labels: ["No data"], values: [1] };
    }

    return {
      labels: breakdown.map((item) => item.operation),
      values: breakdown.map((item) => item.count)
    };
  }

  private renderRecommendations(recommendations: PerformanceRecommendation[]): string {
    if (recommendations.length === 0) {
      return "<p>No recommendations at this time.</p>";
    }

    return recommendations
      .map((recommendation) => `
        <div class="recommendation ${recommendation.priority}-priority">
          <h4>${this.escapeHtml(recommendation.title)}</h4>
          <p>${this.escapeHtml(recommendation.description)}</p>
          <ul>
            ${recommendation.actionItems.map((item) => `<li>${this.escapeHtml(item)}</li>`).join("")}
          </ul>
        </div>
      `)
      .join("");
  }

  private renderActiveOperations(operations: ActiveOperation[]): string {
    if (operations.length === 0) {
      return "<p>No active operations</p>";
    }

    return operations
      .map((operation) => `
        <div class="active-operation">
          <span class="operation-name">${this.escapeHtml(operation.name)}</span>
          <span class="operation-duration">${this.formatDuration(Date.now() - operation.startTime)}</span>
          <div class="operation-progress">
            <div class="operation-progress-fill" style="width: ${operation.progress ?? 0}%"></div>
          </div>
        </div>
      `)
      .join("");
  }

  private renderResourceMetrics(realTime: RealTimeMetrics): string {
    const cpu = `${realTime.cpuUsage.toFixed(1)}%`;
    const memory = this.formatBytes(realTime.memoryUsage.heapUsed);
    const queued = realTime.queuedOperations;

    const lastOperation = realTime.lastOperation
      ? `${this.escapeHtml(realTime.lastOperation.name)} – ${this.formatDuration(realTime.lastOperation.duration)}`
      : "None";

    return `
      <div><strong>CPU Usage:</strong> ${cpu}</div>
      <div><strong>Memory Heap Used:</strong> ${this.escapeHtml(memory)}</div>
      <div><strong>Queued Operations:</strong> ${queued}</div>
      <div><strong>Last Operation:</strong> ${this.escapeHtml(lastOperation)}</div>
    `;
  }

  private setupMessageHandling(panel: vscode.WebviewPanel): void {
    panel.webview.onDidReceiveMessage(async (message) => {
      switch (message.type) {
        case "refresh":
          await this.handleRefreshRequest(panel);
          break;
        case "export":
          await this.reportGenerator.exportReport();
          break;
        default:
          break;
      }
    });
  }

  private async handleRefreshRequest(panel: vscode.WebviewPanel): Promise<void> {
    try {
      const [data, realtime] = await Promise.all([
        this.dataProvider.getDashboardData(),
        this.dataProvider.getRealtimeUpdate()
      ]);
      await panel.webview.postMessage({
        type: "refreshData",
        data: {
          currentSession: data.currentSession,
          recommendationsHtml: this.renderRecommendations(data.recommendations),
          activeOperationsHtml: this.renderActiveOperations(realtime.metrics.activeOperations),
          resourceMetricsHtml: this.renderResourceMetrics(realtime.metrics),
          charts: realtime.charts
        }
      });
    } catch (error) {
      console.error("performance.dashboard.refreshFailed", error);
      void vscode.window.showErrorMessage("Unable to refresh performance dashboard");
    }
  }

  private startRealTimeUpdates(): void {
    if (this.updateInterval || !this.panel) {
      return;
    }

    this.updateInterval = setInterval(async () => {
      if (!this.panel) {
        return;
      }

      try {
        const update = await this.dataProvider.getRealtimeUpdate();
        await this.panel.webview.postMessage({
          type: "updateMetrics",
          data: {
            sessionDuration: update.session.duration,
            operationsCompleted: update.session.operationsCompleted,
            averageOperationTime: update.session.averageOperationTime,
            memoryPeak: update.session.memoryPeak,
            activeOperationsHtml: this.renderActiveOperations(update.metrics.activeOperations),
            resourceMetricsHtml: this.renderResourceMetrics(update.metrics)
          }
        });

        await this.panel.webview.postMessage({
          type: "updateCharts",
          data: update.charts
        });
      } catch (error) {
        console.error("performance.dashboard.realtimeUpdateFailed", error);
      }
    }, this.UPDATE_INTERVAL);

    if (typeof this.updateInterval.unref === "function") {
      this.updateInterval.unref();
    }
  }

  private stopRealTimeUpdates(): void {
    if (!this.updateInterval) {
      return;
    }
    clearInterval(this.updateInterval);
    this.updateInterval = undefined;
  }

  private escapeHtml(value: string): string {
    return value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  private formatDuration(ms: number): string {
    if (ms < MS_IN_SECOND) {
      return `${ms.toFixed(0)}ms`;
    }
    if (ms < MS_IN_MINUTE) {
      return `${(ms / MS_IN_SECOND).toFixed(1)}s`;
    }
    return `${(ms / MS_IN_MINUTE).toFixed(1)}m`;
  }

  private formatBytes(bytes: number): string {
    const units = ["B", "KB", "MB", "GB"];
    let size = bytes;
    let unitIndex = 0;
    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex += 1;
    }
    return `${size.toFixed(1)} ${units[unitIndex]}`;
  }
}

export class PerformanceReportGenerator {
  constructor(
    private readonly performanceMonitor: PerformanceMonitor,
    private readonly diagnosticService: DiagnosticService
  ) {}

  async generateReport(format: "html" | "json" | "csv" = "html"): Promise<string> {
    const data = await this.collectReportData();

    switch (format) {
      case "json":
        return JSON.stringify(data, null, 2);
      case "csv":
        return this.generateCSVReport(data);
      default:
        return this.generateHTMLReport(data);
    }
  }

  async exportReport(): Promise<void> {
    const selection = await vscode.window.showQuickPick(
      ["HTML Report", "JSON Data", "CSV Data"],
      { placeHolder: "Select export format" }
    );

    if (!selection) {
      return;
    }

    const formatMapping: Record<string, "html" | "json" | "csv"> = {
      "html report": "html",
      "json data": "json",
      "csv data": "csv"
    };
    const formatKey = selection.toLowerCase();
    const format = formatMapping[formatKey];
    const report = await this.generateReport(format);

    const timestamp = new Date().toISOString().replace(/[:]/g, "-").split(".")[0];
    const fileName = `code-ingest-performance-${timestamp}.${format}`;

    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(fileName),
      filters: {
        HTML: ["html"],
        JSON: ["json"],
        CSV: ["csv"]
      }
    });

    if (!uri) {
      return;
    }

    await vscode.workspace.fs.writeFile(uri, Buffer.from(report, "utf8"));
    void vscode.window.showInformationMessage(`Performance report exported to ${uri.fsPath}`);
  }

  private async collectReportData(): Promise<Record<string, unknown>> {
    const history = this.performanceMonitor.getMetricsHistory();
    const report = this.performanceMonitor.generateReport();
    const diagnostics = await this.diagnosticService.runDiagnostics(["performance"]);

    const totalOperations = history.length;
    const totalDuration = history.reduce((sum, metric) => sum + metric.duration, 0);
    const errors = history.filter((metric) => typeof metric.metadata.error === "string").length;

    return {
      generatedAt: new Date().toISOString(),
      summary: {
        totalSessions: 1,
        totalOperations,
        averageDuration: totalOperations === 0 ? 0 : totalDuration / totalOperations,
        errorRate: totalOperations === 0 ? 0 : errors / totalOperations
      },
      performance: {
        operations: history.map((metric) => ({
          operationId: metric.operationId,
          operationType: metric.operationType,
          duration: metric.duration,
          memoryUsageMB: metric.memoryUsage.peak.heapUsed / BYTES_IN_MB,
          error: metric.metadata.error ?? null,
          completedAt: metric.metadata.completedAt ?? null
        })),
        report
      },
      diagnostics: diagnostics.diagnostics,
      recommendations: diagnostics.recommendations
    };
  }

  private generateHTMLReport(data: Record<string, unknown>): string {
    const summary = data.summary as {
      totalOperations: number;
      averageDuration: number;
      errorRate: number;
    };
    const diagnostics = data.diagnostics as DiagnosticResult[];
    const recommendations = data.recommendations as string[];

    return `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Code Ingest Performance Report</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 40px; }
          .header { border-bottom: 2px solid #333; padding-bottom: 20px; }
          .metric-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; margin: 20px 0; }
          .metric-box { border: 1px solid #ddd; padding: 20px; text-align: center; }
          .metric-value { font-size: 2em; font-weight: bold; color: #0066cc; }
          .diagnostic-item { margin: 10px 0; padding: 10px; border-left: 4px solid #ccc; }
        </style>
      </head>
      <body>
        <div class="header">
          <h1>Code Ingest Performance Report</h1>
          <p>Generated: ${this.escapeHtml(String(data.generatedAt))}</p>
        </div>

        <h2>Performance Summary</h2>
        <div class="metric-grid">
          <div class="metric-box">
            <div class="metric-value">${summary.totalOperations}</div>
            <div>Total Operations</div>
          </div>
          <div class="metric-box">
            <div class="metric-value">${(summary.averageDuration / MS_IN_SECOND).toFixed(1)}s</div>
            <div>Average Duration</div>
          </div>
          <div class="metric-box">
            <div class="metric-value">${(summary.errorRate * 100).toFixed(1)}%</div>
            <div>Error Rate</div>
          </div>
        </div>

        <h2>Diagnostic Results</h2>
        ${diagnostics
          .map((diag) => `
            <div class="diagnostic-item">
              <strong>${this.escapeHtml(diag.name)}</strong>: ${this.escapeHtml(diag.message)}
              ${diag.suggestion ? `<br><em>Suggestion: ${this.escapeHtml(diag.suggestion)}</em>` : ""}
            </div>
          `)
          .join("")}

        <h2>Recommendations</h2>
        <ul>
          ${recommendations.map((rec) => `<li>${this.escapeHtml(rec)}</li>`).join("")}
        </ul>
      </body>
      </html>
    `;
  }

  private generateCSVReport(data: Record<string, unknown>): string {
    const performance = data.performance as {
      operations: Array<{ completedAt?: string | null; operationType: string; duration: number; memoryUsageMB: number; error: unknown }>;
    };

    const headers = ["Timestamp", "Operation", "Duration (ms)", "Status", "Memory (MB)"];
    const rows = performance.operations.map((operation) => [
      operation.completedAt ?? "",
      operation.operationType,
      operation.duration,
      operation.error ? "Failed" : "Success",
      operation.memoryUsageMB.toFixed(2)
    ]);

    return [headers, ...rows].map((row) => row.join(",")).join("\n");
  }

  private escapeHtml(value: string): string {
    return value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }
}
