import * as os from "node:os";
import { performance } from "node:perf_hooks";

import { DiagnosticService } from "../diagnosticService";
import type {
  Bottleneck,
  PerformanceMetrics,
  PerformanceMonitor,
  PerformanceReport
} from "../performanceMonitor";
import type {
  ActiveOperation,
  DashboardMetrics,
  MemoryUsageSnapshot,
  OperationSummary,
  PerformanceAlert,
  PerformanceRecommendation,
  RegressionData,
  SystemMetrics,
  TrendData
} from "./types";

const SYSTEM_POLL_INTERVAL_MS = 1_000;
const DEFAULT_TREND_SPAN_HOURS = 6;
const MAX_ALERT_HISTORY = 50;

export interface OperationMetrics {
  name: string;
  startTime: number;
  duration?: number;
  memoryUsage: {
    start: MemoryUsageSnapshot;
    peak: MemoryUsageSnapshot;
    end?: MemoryUsageSnapshot;
  };
  status: "running" | "completed" | "failed";
  progress?: number;
  metadata?: Record<string, unknown>;
}

interface CpuSample {
  usage: NodeJS.CpuUsage;
  timestamp: number;
}

export class MetricsCollector {
  private readonly activeOperations = new Map<string, OperationMetrics>();
  private readonly completedOperations: OperationMetrics[] = [];
  private readonly systemMetrics: SystemMetrics[] = [];
  private readonly alerts: PerformanceAlert[] = [];
  private systemMonitor?: NodeJS.Timeout;
  private lastCpuSample: CpuSample = {
    usage: process.cpuUsage(),
    timestamp: Date.now()
  };
  private lastDiagnostics: string[] = [];
  private lastDiagnosticsTimestamp = 0;

  private readonly MAX_HISTORY = 1_000;
  private readonly DIAGNOSTIC_REFRESH_INTERVAL_MS = 60_000;

  constructor(
    private readonly performanceMonitor: PerformanceMonitor,
    private readonly diagnosticService: DiagnosticService
  ) {
    this.startSystemMonitoring();
    void this.refreshDiagnostics();
  }

  startOperation(name: string, metadata?: Record<string, unknown>): string {
    const operationId = this.performanceMonitor.startOperation(name, metadata ?? {});
    const startMemory = this.snapshotMemory();
    const operation: OperationMetrics = {
      name,
      startTime: performance.now(),
      status: "running",
      memoryUsage: {
        start: startMemory,
        peak: startMemory
      }
    };
    if (metadata) {
      operation.metadata = { ...metadata };
    }
    this.activeOperations.set(operationId, operation);
    return operationId;
  }

  updateOperationProgress(operationId: string, progress: number): void {
    const operation = this.activeOperations.get(operationId);
    if (!operation) {
      return;
    }
    operation.progress = Math.max(0, Math.min(progress, 1));
  }

  completeOperation(operationId: string, success: boolean): void {
    const operation = this.activeOperations.get(operationId);
    const completedMetrics = this.performanceMonitor.endOperation(operationId);

    if (!operation || !completedMetrics) {
      return;
    }

    const endSnapshot = this.snapshotMemory(completedMetrics.memoryUsage.end);
    const peakSnapshot = this.snapshotMemory(completedMetrics.memoryUsage.peak);

    operation.status = success ? "completed" : "failed";
    operation.duration = completedMetrics.duration;
    operation.memoryUsage = {
      start: this.snapshotMemory(completedMetrics.memoryUsage.start),
      peak: peakSnapshot,
      end: endSnapshot
    };
    operation.metadata = {
      ...(operation.metadata ?? {}),
      ...completedMetrics.metadata,
      success
    };

    this.activeOperations.delete(operationId);
    this.completedOperations.push(operation);
    if (this.completedOperations.length > this.MAX_HISTORY) {
      this.completedOperations.shift();
    }
  }

  getCurrentMetrics(): DashboardMetrics {
    const activeOperations = this.buildActiveOperations();
    const sessionSummary = this.performanceMonitor.getSessionSummary();
    const metricsHistory = this.performanceMonitor.getMetricsHistory();
    const lastMetric = metricsHistory.at(-1);
    const lastCompletedOperation = lastMetric ? this.toOperationSummary(lastMetric) : undefined;

    const report = this.performanceMonitor.generateReport();
    const bottlenecks = report.bottlenecks;
    const recommendations = this.generateRecommendationsFromReport(report);

    const systemSnapshot = this.systemMetrics.at(-1) ?? this.collectSystemMetrics();

    const historical = this.buildHistoricalTrends(metricsHistory);
    const alerts = this.computeAlerts(systemSnapshot, bottlenecks, report);

    return {
      realTime: {
        currentOperations: activeOperations,
        memoryUsage: systemSnapshot.memory,
        cpuUsage: systemSnapshot.cpuUsage,
        queuedOperations: this.estimateQueuedOperations(),
        ...(lastCompletedOperation ? { lastCompletedOperation } : {})
      },
      session: {
        startTime: new Date(sessionSummary.startTime),
        duration: sessionSummary.duration,
        operationsCompleted: sessionSummary.operationsCompleted,
        averageOperationTime: sessionSummary.averageOperationTime,
        memoryPeak: sessionSummary.memoryPeak,
        errorsEncountered: sessionSummary.errorsEncountered,
        filesProcessed: this.estimateFilesProcessed(metricsHistory)
      },
      historical,
      insights: {
        bottlenecks,
        recommendations,
        alerts
      }
    };
  }

  getHistoricalTrends(hours: number = DEFAULT_TREND_SPAN_HOURS): TrendData[] {
    const windowMs = hours * 60 * 60 * 1_000;
    const cutoff = Date.now() - windowMs;
    const history = this.performanceMonitor.getMetricsHistory();

    return history
      .filter((metric) => metric.metadata.startedAt ? new Date(metric.metadata.startedAt as string | number).getTime() >= cutoff : metric.endTime >= cutoff)
      .map((metric) => ({
        timestamp: this.resolveTimestamp(metric),
        value: metric.duration,
        label: metric.operationType,
        metadata: {
          cpu: metric.resourceUsage.cpuTime,
          memory: metric.memoryUsage.peak.heapUsed
        }
      }));
  }

  detectBottlenecks(): Bottleneck[] {
    return this.performanceMonitor.generateReport().bottlenecks;
  }

  generateRecommendations(): PerformanceRecommendation[] {
    return this.generateRecommendationsFromReport(this.performanceMonitor.generateReport());
  }

  private startSystemMonitoring(): void {
    if (this.systemMonitor) {
      clearInterval(this.systemMonitor);
    }

    const interval = setInterval(() => {
      const metrics = this.collectSystemMetrics();
      this.systemMetrics.push(metrics);
      if (this.systemMetrics.length > this.MAX_HISTORY) {
        this.systemMetrics.shift();
      }
    }, SYSTEM_POLL_INTERVAL_MS);

    if (typeof interval.unref === "function") {
      interval.unref();
    }

    this.systemMonitor = interval;
  }

  private collectSystemMetrics(): SystemMetrics {
    const currentCpu = process.cpuUsage();
    const now = Date.now();
    const elapsedMs = now - this.lastCpuSample.timestamp;
    const diff = process.cpuUsage(this.lastCpuSample.usage);
    const cpuTimeMs = (diff.user + diff.system) / 1_000;
    const cpuUsage = elapsedMs > 0 ? Math.min(100, Math.max(0, (cpuTimeMs / elapsedMs) * 100)) : 0;
    this.lastCpuSample = { usage: currentCpu, timestamp: now };

    const memory = this.snapshotMemory();
    const loadAverage = os.loadavg?.()[0] ?? undefined;

    const snapshot: SystemMetrics = {
      timestamp: now,
      cpuUsage: Number(cpuUsage.toFixed(2)),
      memory,
      loadAverage
    };

    return snapshot;
  }

  private snapshotMemory(source?: NodeJS.MemoryUsage): MemoryUsageSnapshot {
    const usage = source ?? process.memoryUsage();
    return {
      rss: usage.rss,
      heapTotal: usage.heapTotal,
      heapUsed: usage.heapUsed,
      external: usage.external,
      arrayBuffers: usage.arrayBuffers
    };
  }

  private buildActiveOperations(): ActiveOperation[] {
    const snapshots = this.performanceMonitor.getActiveOperationsSnapshot();
    const now = Date.now();

    return snapshots.map((snapshot) => {
      const operation = this.activeOperations.get(snapshot.operationId);
      const status = operation?.status ?? "running";
      const metadata = {
        ...snapshot.metadata,
        ...operation?.metadata
      };

      const descriptor: ActiveOperation = {
        id: snapshot.operationId,
        name: snapshot.operationType,
        status,
        startedAt: snapshot.startedAt,
        duration: Math.max(now - snapshot.startedAt, 0),
        metadata
      };

      if (typeof operation?.progress === "number") {
        descriptor.progress = operation.progress;
      }
      if (operation?.memoryUsage?.peak) {
        descriptor.memory = operation.memoryUsage.peak;
      }

      return descriptor;
    });
  }

  private buildHistoricalTrends(metricsHistory: PerformanceMetrics[]): DashboardMetrics["historical"] {
    const operationTrends = metricsHistory.map((metric) => ({
      timestamp: this.resolveTimestamp(metric),
      value: metric.duration,
      label: metric.operationType,
      metadata: {
        cpu: metric.resourceUsage.cpuTime,
        memory: metric.memoryUsage.peak.heapUsed
      }
    } satisfies TrendData));

    const memoryTrends = this.systemMetrics.map((metric) => ({
      timestamp: metric.timestamp,
      value: metric.memory.heapUsed,
      label: "heapUsed"
    } satisfies TrendData));

    const errorRates = this.computeErrorTrend(metricsHistory);
    const performanceRegressions = this.detectRegressions(metricsHistory, this.performanceMonitor.generateReport());

    return {
      operationTrends,
      memoryTrends,
      errorRates,
      performanceRegressions
    };
  }

  private computeErrorTrend(history: PerformanceMetrics[]): TrendData[] {
    const bucketSizeMs = 60_000;
    const buckets = new Map<number, { errors: number; total: number }>();

    history.forEach((metric) => {
      const timestamp = this.resolveTimestamp(metric);
      const bucket = Math.floor(timestamp / bucketSizeMs) * bucketSizeMs;
      const entry = buckets.get(bucket) ?? { errors: 0, total: 0 };
      entry.total += 1;
      if (typeof metric.metadata.error === "string") {
        entry.errors += 1;
      }
      buckets.set(bucket, entry);
    });

    return Array.from(buckets.entries())
      .sort(([a], [b]) => a - b)
      .map(([bucket, entry]) => ({
        timestamp: bucket,
        value: entry.total === 0 ? 0 : entry.errors / entry.total,
        label: "errorRate",
        metadata: { errors: entry.errors, total: entry.total }
      } satisfies TrendData));
  }

  private detectRegressions(history: PerformanceMetrics[], report: PerformanceReport): RegressionData[] {
    const regressions: RegressionData[] = [];
    const benchmarks = this.performanceMonitor.getBenchmarks();
    const byOperation = new Map<string, PerformanceMetrics[]>();

    history.forEach((metric) => {
      const existing = byOperation.get(metric.operationType) ?? [];
      existing.push(metric);
      byOperation.set(metric.operationType, existing);
    });

    benchmarks.forEach((benchmark) => {
      const operationHistory = byOperation.get(benchmark.operation) ?? [];
      if (operationHistory.length < 5) {
        return;
      }

      const recent = operationHistory.slice(-5);
      const average = recent.reduce((sum, metric) => sum + metric.duration, 0) / recent.length;
      if (average <= benchmark.baseline * 1.1) {
        return;
      }

      const change = average - benchmark.baseline;
      const severity: RegressionData["severity"] = change > benchmark.baseline ? "high" : change > benchmark.baseline * 0.5 ? "medium" : "low";
      const detectedAt = this.resolveTimestamp(recent[recent.length - 1]);

      regressions.push({
        operation: benchmark.operation,
        baseline: benchmark.baseline,
        current: average,
        change,
        severity,
        detectedAt,
        metadata: {
          threshold: benchmark.threshold,
          samples: recent.length,
          trend: benchmark.trend
        }
      });
    });

    report.bottlenecks.forEach((bottleneck) => {
      regressions.push({
        operation: bottleneck.operation,
        baseline: bottleneck.metrics.duration,
        current: bottleneck.metrics.duration,
        change: bottleneck.metrics.duration - bottleneck.metrics.duration * 0.9,
        severity: bottleneck.severity === "high" ? "high" : bottleneck.severity === "medium" ? "medium" : "low",
        detectedAt: this.resolveTimestamp(bottleneck.metrics),
        metadata: {
          type: bottleneck.type,
          impact: bottleneck.impact
        }
      });
    });

    return regressions.slice(-this.MAX_HISTORY);
  }

  private computeAlerts(systemMetrics: SystemMetrics, bottlenecks: Bottleneck[], report: PerformanceReport): PerformanceAlert[] {
    const alerts: PerformanceAlert[] = [];

    if (Date.now() - this.lastDiagnosticsTimestamp > this.DIAGNOSTIC_REFRESH_INTERVAL_MS) {
      void this.refreshDiagnostics();
    }

    if (systemMetrics.cpuUsage > 85) {
      alerts.push(this.createAlert("cpu-high", "cpu", systemMetrics.cpuUsage > 95 ? "critical" : "warning", `CPU usage at ${systemMetrics.cpuUsage.toFixed(1)}%`));
    }

    const heapUsedMb = systemMetrics.memory.heapUsed / (1024 * 1024);
    if (heapUsedMb > 1024) {
      alerts.push(this.createAlert("memory-high", "memory", heapUsedMb > 1536 ? "critical" : "warning", `Memory usage ${heapUsedMb.toFixed(0)} MB`));
    }

    const errorEntry = report.overall.totalOperations === 0 ? 0 : report.bottlenecks.filter((b) => b.severity === "high").length;
    if (errorEntry > 0) {
      alerts.push(
        this.createAlert(
          "bottleneck-high",
          "operation",
          "warning",
          "High severity bottlenecks detected",
          { count: errorEntry }
        )
      );
    }

    const diagnosticsMessages = this.lastDiagnostics.slice(-5);
    diagnosticsMessages.forEach((message, index) => {
      alerts.push({
        id: `diag-${index}-${systemMetrics.timestamp}`,
        category: "system",
        severity: "info",
        message,
        detectedAt: systemMetrics.timestamp
      });
    });

    this.alerts.push(...alerts);
    if (this.alerts.length > MAX_ALERT_HISTORY) {
      this.alerts.splice(0, this.alerts.length - MAX_ALERT_HISTORY);
    }

    return [...this.alerts];
  }

  private createAlert(
    idSuffix: string,
    category: PerformanceAlert["category"],
    severity: PerformanceAlert["severity"],
    message: string,
    metadata?: Record<string, unknown>
  ): PerformanceAlert {
    const detectedAt = Date.now();
    const alert: PerformanceAlert = {
      id: `${category}-${idSuffix}-${detectedAt}`,
      category,
      severity,
      message,
      detectedAt
    };

    if (metadata) {
      alert.metadata = metadata;
    }

    return alert;
  }

  private generateRecommendationsFromReport(report: PerformanceReport): PerformanceRecommendation[] {
    return report.recommendations.map((recommendation) => ({ ...recommendation }));
  }

  private async refreshDiagnostics(): Promise<void> {
    try {
      const report = await this.diagnosticService.runDiagnostics(["system"]);
      this.lastDiagnostics = report.diagnostics.map((diagnostic) => {
        const status = diagnostic.status.toUpperCase();
        return `${status}: ${diagnostic.message}`;
      });
      this.lastDiagnosticsTimestamp = Date.now();
    } catch (error) {
      this.lastDiagnosticsTimestamp = Date.now();
      this.lastDiagnostics.push(`DIAGNOSTICS_FAILED: ${(error as Error).message}`);
      if (this.lastDiagnostics.length > MAX_ALERT_HISTORY) {
        this.lastDiagnostics.splice(0, this.lastDiagnostics.length - MAX_ALERT_HISTORY);
      }
    }
  }

  private resolveTimestamp(metric: PerformanceMetrics): number {
    if (typeof metric.metadata.completedAt === "string" || typeof metric.metadata.completedAt === "number") {
      const value = new Date(metric.metadata.completedAt).getTime();
      if (!Number.isNaN(value)) {
        return value;
      }
    }
    return Math.round(metric.endTime);
  }

  private toOperationSummary(metric: PerformanceMetrics): OperationSummary {
    return {
      id: metric.operationId,
      name: metric.operationType,
      startedAt: typeof metric.metadata.startedAt === "number" ? metric.metadata.startedAt : Date.now(),
      duration: metric.duration,
      status: typeof metric.metadata.error === "string" ? "failed" : "completed",
      metadata: { ...metric.metadata }
    };
  }

  private estimateQueuedOperations(): number {
    // Placeholder logic: queued operations could be derived from metadata in the future.
    return 0;
  }

  private estimateFilesProcessed(metricsHistory: PerformanceMetrics[]): number {
    return metricsHistory.reduce((sum, metric) => {
      const value = metric.metadata?.filesProcessed;
      if (typeof value === "number" && Number.isFinite(value)) {
        return sum + value;
      }
      return sum;
    }, 0);
  }
}
