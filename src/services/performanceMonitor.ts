import * as fs from "node:fs/promises";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import * as vscode from "vscode";

import type { Logger } from "../utils/gitProcessManager";
import { ConfigurationService } from "./configurationService";

export type PerformanceMetadata = Record<string, unknown>;

export interface ActiveOperationSnapshot {
  operationId: string;
  operationType: string;
  startedAt: number;
  duration: number;
  metadata: PerformanceMetadata;
  resourceUsage: {
    fileOperations: number;
    networkRequests: number;
  };
}

export interface PerformanceSessionSummary {
  sessionId: string;
  startTime: number;
  duration: number;
  operationsCompleted: number;
  averageOperationTime: number;
  memoryPeak: number;
  errorsEncountered: number;
}

export interface PerformanceMetrics {
  operationId: string;
  operationType: string;
  startTime: number;
  endTime: number;
  duration: number;
  memoryUsage: {
    start: NodeJS.MemoryUsage;
    end: NodeJS.MemoryUsage;
    peak: NodeJS.MemoryUsage;
  };
  resourceUsage: {
    cpuTime: number;
    fileOperations: number;
    networkRequests: number;
  };
  metadata: PerformanceMetadata;
}

export interface PerformanceBenchmark {
  operation: string;
  baseline: number;
  threshold: number;
  samples: number[];
  percentiles: {
    p50: number;
    p90: number;
    p95: number;
    p99: number;
  };
  trend: "improving" | "degrading" | "stable";
}

export interface OperationStats {
  operation: string;
  count: number;
  totalDuration: number;
  averageDuration: number;
  minDuration: number;
  maxDuration: number;
  durations: number[];
  lastMetrics: PerformanceMetrics | null;
}

export interface PerformanceReport {
  sessionId: string;
  timestamp: Date;
  overall: {
    totalOperations: number;
    totalDuration: number;
    averageDuration: number;
    slowestOperation: PerformanceMetrics;
    fastestOperation: PerformanceMetrics;
  };
  byOperation: Map<string, OperationStats>;
  bottlenecks: Bottleneck[];
  recommendations: OptimizationRecommendation[];
}

export interface Bottleneck {
  type: "cpu" | "memory" | "io" | "network";
  severity: "low" | "medium" | "high";
  operation: string;
  description: string;
  impact: number;
  suggestions: string[];
  metrics: PerformanceMetrics;
}

export interface OptimizationRecommendation {
  category: "performance" | "memory" | "network" | "configuration";
  priority: "low" | "medium" | "high";
  title: string;
  description: string;
  implementationComplexity: "simple" | "moderate" | "complex";
  estimatedImpact: number;
  actionItems: string[];
  relatedOperations: string[];
}

interface ActiveOperation {
  operationType: string;
  startTime: number;
  startedAt: number;
  startMemory: NodeJS.MemoryUsage;
  metadata: PerformanceMetadata;
  peakMemory: NodeJS.MemoryUsage;
  resourceUsage: {
    fileOperations: number;
    networkRequests: number;
  };
  memoryCheckInterval?: NodeJS.Timeout;
}

const MEMORY_WARNING_CONFIG_KEY = "memoryWarningMB";
const DEFAULT_MEMORY_WARNING_MB = 1024;
const DEFAULT_MEMORY_POLL_INTERVAL_MS = 15_000;
const DEFAULT_OPERATION_MEMORY_POLL_INTERVAL_MS = 1_000;
const MAX_OPERATION_SAMPLES = 100;
const MAX_OPERATION_HISTORY = 1000;

const ZERO_MEMORY_USAGE: NodeJS.MemoryUsage = {
  rss: 0,
  heapTotal: 0,
  heapUsed: 0,
  external: 0,
  arrayBuffers: 0
};

export class PerformanceMonitor {
  private readonly activeOperations = new Map<string, ActiveOperation>();
  private completedMetrics: PerformanceMetrics[] = [];
  private readonly operationStats = new Map<string, OperationStats>();
  private readonly benchmarkManager: BenchmarkManager;
  private readonly bottleneckDetector = new BottleneckDetector();
  private readonly recommendationEngine = new OptimizationRecommendationEngine();
  private readonly maxHistorySize: number;
  private readonly sessionId: string;
  private sessionStart: number;
  private memoryMonitorInterval?: NodeJS.Timeout;
  private readonly metricsEmitter = new vscode.EventEmitter<PerformanceMetrics>();
  private readonly operationEmitter = new vscode.EventEmitter<void>();

  constructor(private readonly logger: Logger, private readonly configService: ConfigurationService) {
    this.sessionId = this.generateSessionId();
    this.sessionStart = Date.now();
    this.benchmarkManager = new BenchmarkManager(this.configService);
    this.maxHistorySize = MAX_OPERATION_HISTORY;
    void this.initializeBenchmarks();
    this.setupMemoryMonitoring();
  }

  startOperation(operationType: string, metadata: PerformanceMetadata = {}): string {
    const operationId = this.generateOperationId(operationType);
    const startTime = performance.now();
    const startedAt = Date.now();
    const startMemory = process.memoryUsage();

    const operation: ActiveOperation = {
      operationType,
      startTime,
      startedAt,
      startMemory,
      metadata: { ...metadata },
      peakMemory: startMemory,
      resourceUsage: {
        fileOperations: 0,
        networkRequests: 0
      }
    };

    const interval = setInterval(() => {
      const currentMemory = process.memoryUsage();
      if (currentMemory.heapUsed > operation.peakMemory.heapUsed) {
        operation.peakMemory = currentMemory;
      }
    }, DEFAULT_OPERATION_MEMORY_POLL_INTERVAL_MS);

    if (typeof interval.unref === "function") {
      interval.unref();
    }

    operation.memoryCheckInterval = interval;
    this.activeOperations.set(operationId, operation);
    this.operationEmitter.fire();

    this.logger.debug("performance.operation.start", { operationType, operationId });
    return operationId;
  }

  endOperation(operationId: string): PerformanceMetrics | null {
    const operation = this.activeOperations.get(operationId);
    if (!operation) {
      this.logger.warn("performance.operation.missing", { operationId });
      return null;
    }

    if (operation.memoryCheckInterval) {
      clearInterval(operation.memoryCheckInterval);
    }

    const endTime = performance.now();
    const endMemory = process.memoryUsage();
    const duration = endTime - operation.startTime;
    const cpuUsage = process.cpuUsage();
    const cpuTime = (cpuUsage.user + cpuUsage.system) / 1000;

    const metrics: PerformanceMetrics = {
      operationId,
      operationType: operation.operationType,
      startTime: operation.startTime,
      endTime,
      duration,
      memoryUsage: {
        start: operation.startMemory,
        end: endMemory,
        peak: operation.peakMemory
      },
      resourceUsage: {
        cpuTime,
        fileOperations: operation.resourceUsage.fileOperations,
        networkRequests: operation.resourceUsage.networkRequests
      },
      metadata: { ...operation.metadata }
    };

    metrics.metadata.startedAt ??= operation.startedAt;
    metrics.metadata.completedAt = new Date().toISOString();

    this.activeOperations.delete(operationId);
    this.recordMetrics(metrics);
  this.operationEmitter.fire();
    this.updateBenchmarks(metrics);

    this.logger.debug("performance.operation.end", {
      operationType: metrics.operationType,
      operationId,
      duration: Number(metrics.duration.toFixed(2))
    });

    return metrics;
  }

  measureAsync<T>(
    operationType: string,
    operation: () => Promise<T>,
    metadata?: PerformanceMetadata
  ): Promise<{ result: T; metrics: PerformanceMetrics }> {
    const operationId = this.startOperation(operationType, metadata ?? {});

    return operation()
      .then((result) => {
        const metrics = this.endOperation(operationId);
        if (!metrics) {
          throw new Error(`Metrics unavailable for operation ${operationId}`);
        }
        return { result, metrics };
      })
      .catch((error) => {
        const metrics = this.endOperation(operationId);
        if (metrics) {
          metrics.metadata.error = error instanceof Error ? error.message : String(error);
        }
        throw error;
      });
  }

  measureSync<T>(
    operationType: string,
    operation: () => T,
    metadata?: PerformanceMetadata
  ): { result: T; metrics: PerformanceMetrics } {
    const operationId = this.startOperation(operationType, metadata ?? {});

    try {
      const result = operation();
      const metrics = this.endOperation(operationId);
      if (!metrics) {
        throw new Error(`Metrics unavailable for operation ${operationId}`);
      }
      return { result, metrics };
    } catch (error) {
      const metrics = this.endOperation(operationId);
      if (metrics) {
        metrics.metadata.error = error instanceof Error ? error.message : String(error);
      }
      throw error;
    }
  }

  recordResourceUsage(
    operationId: string,
    usage: Partial<{ fileOperations: number; networkRequests: number }>
  ): void {
    const operation = this.activeOperations.get(operationId);
    if (!operation) {
      return;
    }

    if (typeof usage.fileOperations === "number") {
      operation.resourceUsage.fileOperations += usage.fileOperations;
    }

    if (typeof usage.networkRequests === "number") {
      operation.resourceUsage.networkRequests += usage.networkRequests;
    }
  }

  generateReport(): PerformanceReport {
    if (this.completedMetrics.length === 0) {
      const emptyMetrics = this.createEmptyMetrics();
      return {
        sessionId: this.sessionId,
        timestamp: new Date(),
        overall: {
          totalOperations: 0,
          totalDuration: 0,
          averageDuration: 0,
          slowestOperation: emptyMetrics,
          fastestOperation: emptyMetrics
        },
        byOperation: new Map(),
        bottlenecks: [],
        recommendations: []
      };
    }

    const totalOperations = this.completedMetrics.length;
    const totalDuration = this.completedMetrics.reduce((sum, metric) => sum + metric.duration, 0);
    const averageDuration = totalDuration / totalOperations;
    const slowestOperation = this.completedMetrics.reduce((prev, current) =>
      current.duration > prev.duration ? current : prev
    );
    const fastestOperation = this.completedMetrics.reduce((prev, current) =>
      current.duration < prev.duration ? current : prev
    );

    const byOperation = new Map<string, OperationStats>();
    this.operationStats.forEach((stats, operation) => {
      byOperation.set(operation, {
        operation,
        count: stats.count,
        totalDuration: stats.totalDuration,
        averageDuration: stats.averageDuration,
        minDuration: stats.minDuration,
        maxDuration: stats.maxDuration,
        durations: [...stats.durations],
        lastMetrics: stats.lastMetrics
      });
    });

    const bottlenecks = this.bottleneckDetector.detectBottlenecks(this.completedMetrics);

    const report: PerformanceReport = {
      sessionId: this.sessionId,
      timestamp: new Date(),
      overall: {
        totalOperations,
        totalDuration,
        averageDuration,
        slowestOperation,
        fastestOperation
      },
      byOperation,
      bottlenecks,
      recommendations: []
    };

    report.recommendations = this.recommendationEngine.generateRecommendations(report, bottlenecks);
    return report;
  }

  getMetricsHistory(): PerformanceMetrics[] {
    return [...this.completedMetrics];
  }

  getActiveOperationsSnapshot(): ActiveOperationSnapshot[] {
    if (this.activeOperations.size === 0) {
      return [];
    }

    const now = Date.now();
    return Array.from(this.activeOperations.entries()).map(([operationId, operation]) => ({
      operationId,
      operationType: operation.operationType,
      startedAt: operation.startedAt,
      duration: Math.max(now - operation.startedAt, 0),
      metadata: { ...operation.metadata },
      resourceUsage: {
        fileOperations: operation.resourceUsage.fileOperations,
        networkRequests: operation.resourceUsage.networkRequests
      }
    }));
  }

  getSessionSummary(): PerformanceSessionSummary {
    const operationsCompleted = this.completedMetrics.length;
    const totalDuration = this.completedMetrics.reduce((sum, metric) => sum + metric.duration, 0);
    const averageOperationTime = operationsCompleted === 0 ? 0 : totalDuration / operationsCompleted;
    const memoryPeak = this.completedMetrics.reduce((peak, metric) => {
      const metricPeak = metric.memoryUsage.peak.heapUsed;
      return metricPeak > peak ? metricPeak : peak;
    }, 0);

    const errorsEncountered = this.completedMetrics.reduce((count, metric) => {
      return typeof metric.metadata.error === "string" ? count + 1 : count;
    }, 0);

    return {
      sessionId: this.sessionId,
      startTime: this.sessionStart,
      duration: Date.now() - this.sessionStart,
      operationsCompleted,
      averageOperationTime,
      memoryPeak,
      errorsEncountered
    };
  }

  getBenchmarks(): PerformanceBenchmark[] {
    return this.benchmarkManager.getAllBenchmarks();
  }

  getSessionId(): string {
    return this.sessionId;
  }

  onDidRecordMetrics(listener: (metrics: PerformanceMetrics) => void): vscode.Disposable {
    return this.metricsEmitter.event(listener);
  }

  onDidChangeActiveOperations(listener: () => void): vscode.Disposable {
    return this.operationEmitter.event(listener);
  }

  reset(): void {
    this.activeOperations.forEach((operation) => {
      if (operation.memoryCheckInterval) {
        clearInterval(operation.memoryCheckInterval);
      }
    });
    this.activeOperations.clear();
    this.completedMetrics = [];
    this.operationStats.clear();
    this.sessionStart = Date.now();
  }

  async dispose(): Promise<void> {
    this.reset();
    if (this.memoryMonitorInterval) {
      clearInterval(this.memoryMonitorInterval);
    }
    this.metricsEmitter.dispose();
    this.operationEmitter.dispose();
    await this.benchmarkManager.saveBaselines();
  }

  private recordMetrics(metrics: PerformanceMetrics): void {
    this.completedMetrics.push(metrics);
    if (this.completedMetrics.length > this.maxHistorySize) {
      this.completedMetrics = this.completedMetrics.slice(-this.maxHistorySize);
    }

    this.updateOperationStats(metrics);
    this.checkPerformanceThresholds(metrics);
    this.metricsEmitter.fire(metrics);
  }

  private updateOperationStats(metrics: PerformanceMetrics): void {
    const current = this.operationStats.get(metrics.operationType);
    if (!current) {
      this.operationStats.set(metrics.operationType, {
        operation: metrics.operationType,
        count: 1,
        totalDuration: metrics.duration,
        averageDuration: metrics.duration,
        minDuration: metrics.duration,
        maxDuration: metrics.duration,
        durations: [metrics.duration],
        lastMetrics: metrics
      });
      return;
    }

    current.count += 1;
    current.totalDuration += metrics.duration;
    current.averageDuration = current.totalDuration / current.count;
    current.minDuration = Math.min(current.minDuration, metrics.duration);
    current.maxDuration = Math.max(current.maxDuration, metrics.duration);
    current.durations.push(metrics.duration);
    if (current.durations.length > MAX_OPERATION_SAMPLES) {
      current.durations = current.durations.slice(-MAX_OPERATION_SAMPLES);
    }
    current.lastMetrics = metrics;
  }

  private checkPerformanceThresholds(metrics: PerformanceMetrics): void {
    const benchmark = this.benchmarkManager.getBenchmark(metrics.operationType);
    if (benchmark && metrics.duration > benchmark.threshold) {
      this.logger.warn("performance.threshold.exceeded", {
        operationType: metrics.operationType,
        duration: metrics.duration,
        threshold: benchmark.threshold,
        operationId: metrics.operationId
      });
    }

    const memoryIncrease = metrics.memoryUsage.peak.heapUsed - metrics.memoryUsage.start.heapUsed;
    const memoryIncreaseMB = memoryIncrease / (1024 * 1024);
    if (memoryIncreaseMB > 100) {
      this.logger.warn("performance.memory.high", {
        operationType: metrics.operationType,
        operationId: metrics.operationId,
        memoryIncreaseMB: Number(memoryIncreaseMB.toFixed(2))
      });
    }
  }

  private updateBenchmarks(metrics: PerformanceMetrics): void {
    this.benchmarkManager.updateBenchmark(metrics.operationType, metrics);
  }

  private async initializeBenchmarks(): Promise<void> {
    try {
      await this.benchmarkManager.loadBaselines();
    } catch (error) {
      this.logger.warn("performance.benchmarks.loadFailed", {
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private setupMemoryMonitoring(): void {
    const performanceConfig = vscode.workspace.getConfiguration("codeIngest.performance");
    const thresholdMB = performanceConfig.get<number>(MEMORY_WARNING_CONFIG_KEY, DEFAULT_MEMORY_WARNING_MB);

    const interval = setInterval(() => {
      const memory = process.memoryUsage();
      const usedMB = memory.heapUsed / (1024 * 1024);
      if (usedMB > thresholdMB) {
        this.logger.warn("performance.process.memoryThreshold", {
          heapUsedMB: Number(usedMB.toFixed(2)),
          thresholdMB
        });
      }
    }, DEFAULT_MEMORY_POLL_INTERVAL_MS);

    if (typeof interval.unref === "function") {
      interval.unref();
    }

    this.memoryMonitorInterval = interval;
  }

  private createEmptyMetrics(): PerformanceMetrics {
    return {
      operationId: "none",
      operationType: "none",
      startTime: 0,
      endTime: 0,
      duration: 0,
      memoryUsage: {
        start: ZERO_MEMORY_USAGE,
        end: ZERO_MEMORY_USAGE,
        peak: ZERO_MEMORY_USAGE
      },
      resourceUsage: {
        cpuTime: 0,
        fileOperations: 0,
        networkRequests: 0
      },
      metadata: {}
    };
  }

  private generateSessionId(): string {
    return `session-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  private generateOperationId(operationType: string): string {
    return `${operationType}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }
}

export class BenchmarkManager {
  private readonly benchmarks = new Map<string, PerformanceBenchmark>();
  private readonly baselinePath: string;

  constructor(private readonly configService: ConfigurationService) {
    this.baselinePath = path.join(
      this.configService.getExtensionPath(),
      "benchmarks",
      "performance-baseline.json"
    );
  }

  async loadBaselines(): Promise<void> {
    try {
      const data = await fs.readFile(this.baselinePath, "utf8");
      const baselines = JSON.parse(data) as Record<string, { baseline: number; threshold: number; percentiles?: PerformanceBenchmark["percentiles"]; trend?: PerformanceBenchmark["trend"] }>;

      Object.entries(baselines).forEach(([operation, baseline]) => {
        this.benchmarks.set(operation, {
          operation,
          baseline: baseline.baseline,
          threshold: baseline.threshold,
          samples: [],
          percentiles: baseline.percentiles ?? { p50: 0, p90: 0, p95: 0, p99: 0 },
          trend: baseline.trend ?? "stable"
        });
      });
    } catch {
      this.initializeDefaultBenchmarks();
    }
  }

  updateBenchmark(operationType: string, metrics: PerformanceMetrics): void {
    let benchmark = this.benchmarks.get(operationType);
    if (!benchmark) {
      benchmark = {
        operation: operationType,
        baseline: metrics.duration,
        threshold: metrics.duration * 3,
        samples: [],
        percentiles: { p50: 0, p90: 0, p95: 0, p99: 0 },
        trend: "stable"
      };
      this.benchmarks.set(operationType, benchmark);
    }

    benchmark.samples.push(metrics.duration);
    if (benchmark.samples.length > 100) {
      benchmark.samples = benchmark.samples.slice(-100);
    }

    this.updatePercentiles(benchmark);
    this.updateTrend(benchmark);
  }

  getBenchmark(operation: string): PerformanceBenchmark | undefined {
    return this.benchmarks.get(operation);
  }

  getAllBenchmarks(): PerformanceBenchmark[] {
    return Array.from(this.benchmarks.values());
  }

  async saveBaselines(): Promise<void> {
    const baselineData: Record<string, unknown> = {};

    this.benchmarks.forEach((benchmark, operation) => {
      baselineData[operation] = {
        baseline: benchmark.baseline,
        threshold: benchmark.threshold,
        percentiles: benchmark.percentiles,
        trend: benchmark.trend
      };
    });

    try {
      await fs.mkdir(path.dirname(this.baselinePath), { recursive: true });
      await fs.writeFile(this.baselinePath, JSON.stringify(baselineData, null, 2), "utf8");
    } catch (error) {
      console.error("performance.baselines.saveFailed", error);
    }
  }

  private initializeDefaultBenchmarks(): void {
    const defaultBenchmarks: Record<string, { baseline: number; threshold: number }> = {
      "file-scan": { baseline: 1_000, threshold: 5_000 },
      "content-process": { baseline: 500, threshold: 2_000 },
      "digest-generate": { baseline: 2_000, threshold: 10_000 },
      "remote-clone": { baseline: 10_000, threshold: 60_000 },
      "git-operation": { baseline: 1_000, threshold: 5_000 }
    };

    Object.entries(defaultBenchmarks).forEach(([operation, config]) => {
      this.benchmarks.set(operation, {
        operation,
        baseline: config.baseline,
        threshold: config.threshold,
        samples: [],
        percentiles: { p50: 0, p90: 0, p95: 0, p99: 0 },
        trend: "stable"
      });
    });
  }

  private updatePercentiles(benchmark: PerformanceBenchmark): void {
    if (benchmark.samples.length === 0) {
      return;
    }

    const sorted = [...benchmark.samples].sort((a, b) => a - b);
    const pick = (percent: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * percent))];

    benchmark.percentiles = {
      p50: pick(0.5),
      p90: pick(0.9),
      p95: pick(0.95),
      p99: pick(0.99)
    };
  }

  private updateTrend(benchmark: PerformanceBenchmark): void {
    if (benchmark.samples.length < 10) {
      benchmark.trend = "stable";
      return;
    }

    const recentSamples = benchmark.samples.slice(-10);
    const olderSamples = benchmark.samples.slice(-20, -10);
    if (olderSamples.length === 0) {
      benchmark.trend = "stable";
      return;
    }

    const average = (values: number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length;
    const recentAverage = average(recentSamples);
    const olderAverage = average(olderSamples);

    if (olderAverage === 0) {
      benchmark.trend = "stable";
      return;
    }

    const changePercent = ((recentAverage - olderAverage) / olderAverage) * 100;

    if (changePercent > 10) {
      benchmark.trend = "degrading";
    } else if (changePercent < -10) {
      benchmark.trend = "improving";
    } else {
      benchmark.trend = "stable";
    }
  }
}

class BottleneckDetector {
  detectBottlenecks(metrics: PerformanceMetrics[]): Bottleneck[] {
    if (metrics.length === 0) {
      return [];
    }

    const byOperation = new Map<string, PerformanceMetrics[]>();
    metrics.forEach((metric) => {
      const existing = byOperation.get(metric.operationType) ?? [];
      existing.push(metric);
      byOperation.set(metric.operationType, existing);
    });

    const bottlenecks: Bottleneck[] = [];
    byOperation.forEach((operationMetrics, operationType) => {
      bottlenecks.push(...this.analyzeOperationBottlenecks(operationType, operationMetrics));
    });

    return bottlenecks.sort((a, b) => b.impact - a.impact);
  }

  private analyzeOperationBottlenecks(operationType: string, metrics: PerformanceMetrics[]): Bottleneck[] {
    const bottlenecks: Bottleneck[] = [];

    const longOperations = metrics.filter((metric) => metric.duration > 5_000);
    if (longOperations.length > 0) {
      const longest = longOperations.reduce((prev, current) => (current.duration > prev.duration ? current : prev));
      const avgDuration = longOperations.reduce((sum, metric) => sum + metric.duration, 0) / longOperations.length;
      const severity: Bottleneck["severity"] = avgDuration > 30_000 ? "high" : avgDuration > 10_000 ? "medium" : "low";

      bottlenecks.push({
        type: "cpu",
        severity,
        operation: operationType,
        description: `${operationType} operations are taking too long`,
        impact: Math.min(longOperations.length / metrics.length, 1),
        suggestions: [
          "Consider implementing parallel processing",
          "Add progress indicators for long operations",
          "Implement operation cancellation",
          "Optimize algorithms for better performance"
        ],
        metrics: longest
      });
    }

    const memoryIntensive = metrics.filter((metric) => {
      const increase = metric.memoryUsage.peak.heapUsed - metric.memoryUsage.start.heapUsed;
      return increase > 100 * 1024 * 1024;
    });

    if (memoryIntensive.length > 0) {
      const worst = memoryIntensive.reduce((prev, current) => {
        const prevIncrease = prev.memoryUsage.peak.heapUsed - prev.memoryUsage.start.heapUsed;
        const currentIncrease = current.memoryUsage.peak.heapUsed - current.memoryUsage.start.heapUsed;
        return currentIncrease > prevIncrease ? current : prev;
      });

      bottlenecks.push({
        type: "memory",
        severity: "medium",
        operation: operationType,
        description: `${operationType} uses excessive memory`,
        impact: memoryIntensive.length / metrics.length,
        suggestions: [
          "Implement streaming for large files",
          "Use pagination for large datasets",
          "Release references to unused objects",
          "Consider using workers for memory-intensive tasks"
        ],
        metrics: worst
      });
    }

    const ioIntensive = metrics.filter((metric) => metric.resourceUsage.fileOperations > 100);
    if (ioIntensive.length > 0) {
      const worst = ioIntensive.reduce((prev, current) =>
        current.resourceUsage.fileOperations > prev.resourceUsage.fileOperations ? current : prev
      );

      bottlenecks.push({
        type: "io",
        severity: "medium",
        operation: operationType,
        description: `${operationType} performs many file operations`,
        impact: ioIntensive.length / metrics.length,
        suggestions: [
          "Batch file operations",
          "Implement file system caching",
          "Use asynchronous I/O operations",
          "Consider using memory mapping for large files"
        ],
        metrics: worst
      });
    }

    const networkIntensive = metrics.filter((metric) => metric.resourceUsage.networkRequests > 10);
    if (networkIntensive.length > 0) {
      const worst = networkIntensive.reduce((prev, current) =>
        current.resourceUsage.networkRequests > prev.resourceUsage.networkRequests ? current : prev
      );

      bottlenecks.push({
        type: "network",
        severity: "medium",
        operation: operationType,
        description: `${operationType} makes many network requests`,
        impact: networkIntensive.length / metrics.length,
        suggestions: [
          "Batch network requests",
          "Implement request caching",
          "Use connection pooling",
          "Add retry logic with exponential backoff"
        ],
        metrics: worst
      });
    }

    return bottlenecks;
  }
}

class OptimizationRecommendationEngine {
  generateRecommendations(report: PerformanceReport, bottlenecks: Bottleneck[]): OptimizationRecommendation[] {
    const recommendations: OptimizationRecommendation[] = [];

    recommendations.push(...this.analyzeOverallPatterns(report));
    recommendations.push(...this.analyzeBottlenecks(bottlenecks));
    recommendations.push(...this.analyzeConfiguration(report));

    const priorityWeight = { high: 3, medium: 2, low: 1 } as const;

    return recommendations
      .sort((a, b) => {
        const priorityDifference = priorityWeight[b.priority] - priorityWeight[a.priority];
        if (priorityDifference !== 0) {
          return priorityDifference;
        }
        return b.estimatedImpact - a.estimatedImpact;
      })
      .slice(0, 10);
  }

  private analyzeOverallPatterns(report: PerformanceReport): OptimizationRecommendation[] {
    const recommendations: OptimizationRecommendation[] = [];

    if (report.overall.averageDuration > 5_000) {
      recommendations.push({
        category: "performance",
        priority: "high",
        title: "Overall performance optimization",
        description: "Operations are taking longer than expected on average.",
        implementationComplexity: "moderate",
        estimatedImpact: 0.7,
        actionItems: [
          "Profile individual operations to identify bottlenecks",
          "Implement parallel processing where possible",
          "Add caching for frequently accessed data",
          "Optimize algorithm complexity"
        ],
        relatedOperations: Array.from(report.byOperation.keys())
      });
    }

    report.byOperation.forEach((stats, operation) => {
      const variance = this.calculateVariance(stats.durations);
      if (variance > stats.averageDuration * 0.5) {
        recommendations.push({
          category: "performance",
          priority: "medium",
          title: `Inconsistent performance in ${operation}`,
          description: "Operation performance varies significantly between executions.",
          implementationComplexity: "moderate",
          estimatedImpact: 0.4,
          actionItems: [
            "Investigate causes of performance variation",
            "Implement more consistent algorithms",
            "Add performance monitoring and alerting",
            "Consider warming up caches before operations"
          ],
          relatedOperations: [operation]
        });
      }
    });

    return recommendations;
  }

  private analyzeBottlenecks(bottlenecks: Bottleneck[]): OptimizationRecommendation[] {
    if (bottlenecks.length === 0) {
      return [];
    }

    const recommendations: OptimizationRecommendation[] = [];
    const byType = new Map<Bottleneck["type"], Bottleneck[]>();

    bottlenecks.forEach((bottleneck) => {
      const existing = byType.get(bottleneck.type) ?? [];
      existing.push(bottleneck);
      byType.set(bottleneck.type, existing);
    });

    byType.forEach((typeBottlenecks, type) => {
      const highSeverityCount = typeBottlenecks.filter((bottleneck) => bottleneck.severity === "high").length;
      if (highSeverityCount === 0) {
        return;
      }

      const estimatedImpact = typeBottlenecks.reduce((sum, bottleneck) => sum + bottleneck.impact, 0) / typeBottlenecks.length;

      recommendations.push({
        category: type === "cpu" ? "performance" : (type as OptimizationRecommendation["category"]),
        priority: "high",
        title: `Address ${type.toUpperCase()} bottlenecks`,
        description: `Multiple operations are experiencing ${type} bottlenecks.`,
        implementationComplexity: "moderate",
        estimatedImpact,
        actionItems: this.getBottleneckActionItems(type),
        relatedOperations: typeBottlenecks.map((bottleneck) => bottleneck.operation)
      });
    });

    return recommendations;
  }

  private analyzeConfiguration(report: PerformanceReport): OptimizationRecommendation[] {
    const recommendations: OptimizationRecommendation[] = [];

    const highMemoryOperations = report.bottlenecks.filter((bottleneck) => bottleneck.type === "memory");
    if (highMemoryOperations.length > 0) {
      recommendations.push({
        category: "configuration",
        priority: "medium",
        title: "Tune memory-related configuration",
        description: "Several operations exceed the memory comfort threshold.",
        implementationComplexity: "simple",
        estimatedImpact: 0.3,
        actionItems: [
          "Review include/exclude patterns to reduce memory pressure",
          "Limit concurrent operations in configuration",
          "Enable streaming options where available"
        ],
        relatedOperations: highMemoryOperations.map((bottleneck) => bottleneck.operation)
      });
    }

    const longRunningOperations = report.bottlenecks.filter((bottleneck) => bottleneck.type === "cpu");
    if (longRunningOperations.length > 0) {
      recommendations.push({
        category: "configuration",
        priority: "medium",
        title: "Adjust performance thresholds",
        description: "Update performance thresholds to reflect observed production values and avoid noise.",
        implementationComplexity: "simple",
        estimatedImpact: 0.2,
        actionItems: [
          "Review and adjust performance baselines",
          "Align thresholds with target hardware",
          "Automate benchmark refresh after major releases"
        ],
        relatedOperations: longRunningOperations.map((bottleneck) => bottleneck.operation)
      });
    }

    return recommendations;
  }

  private getBottleneckActionItems(type: Bottleneck["type"]): string[] {
    const actionItems: Record<Bottleneck["type"], string[]> = {
      cpu: [
        "Optimize algorithms and data structures",
        "Implement parallel processing",
        "Use worker threads for CPU-intensive tasks",
        "Add operation cancellation and timeouts"
      ],
      memory: [
        "Implement streaming for large data",
        "Use object pooling for frequently created objects",
        "Release references to unused objects",
        "Monitor and set memory limits"
      ],
      io: [
        "Batch file system operations",
        "Implement caching strategies",
        "Use asynchronous I/O operations",
        "Optimize file access patterns"
      ],
      network: [
        "Implement request batching",
        "Add connection pooling",
        "Use caching for API responses",
        "Implement retry logic with exponential backoff"
      ]
    };

    return actionItems[type];
  }

  private calculateVariance(values: number[]): number {
    if (values.length === 0) {
      return 0;
    }

    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const squaredDifferences = values.map((value) => Math.pow(value - mean, 2));
    return squaredDifferences.reduce((sum, value) => sum + value, 0) / values.length;
  }
}