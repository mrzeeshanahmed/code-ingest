import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";

import {
  PerformanceDashboardDataProvider,
  PerformanceReportGenerator,
  type PerformanceRecommendation
} from "../webview/performanceDashboard";
import type {
  ActiveOperationSnapshot,
  PerformanceBenchmark,
  PerformanceMetrics,
  PerformanceMonitor,
  PerformanceReport,
  PerformanceSessionSummary,
  OptimizationRecommendation
} from "../services/performanceMonitor";
import type { DiagnosticResult, DiagnosticService, SystemHealthReport } from "../services/diagnosticService";

const createMemoryUsage = (heapUsed: number): NodeJS.MemoryUsage => ({
  rss: heapUsed * 1.2,
  heapTotal: heapUsed * 1.1,
  heapUsed,
  external: 10_000,
  arrayBuffers: 5_000
});

const createPerformanceMetric = (overrides: Partial<PerformanceMetrics> = {}): PerformanceMetrics => ({
  operationId: "op-1",
  operationType: "file-scan",
  startTime: 0,
  endTime: 20,
  duration: 20,
  memoryUsage: {
    start: createMemoryUsage(60_000_000),
    end: createMemoryUsage(62_000_000),
    peak: createMemoryUsage(64_000_000)
  },
  resourceUsage: {
    cpuTime: 10,
    fileOperations: 2,
    networkRequests: 0
  },
  metadata: {
    completedAt: "2024-01-01T00:00:20.000Z"
  },
  ...overrides
});

const createBenchmark = (): PerformanceBenchmark => ({
  operation: "file-scan",
  baseline: 25,
  threshold: 75,
  samples: [20, 22, 18],
  percentiles: { p50: 20, p90: 25, p95: 27, p99: 30 },
  trend: "stable"
});

const createRecommendation = (): OptimizationRecommendation => ({
  category: "performance",
  priority: "high",
  title: "Improve throughput",
  description: "Process faster",
  implementationComplexity: "simple",
  estimatedImpact: 0.6,
  actionItems: ["Profile hot paths"],
  relatedOperations: ["file-scan"]
});

const createReport = (metric: PerformanceMetrics): PerformanceReport => ({
  sessionId: "session-123",
  timestamp: new Date("2024-01-01T00:00:30Z"),
  overall: {
    totalOperations: 1,
    totalDuration: metric.duration,
    averageDuration: metric.duration,
    slowestOperation: metric,
    fastestOperation: metric
  },
  byOperation: new Map([
    [
      "file-scan",
      {
        operation: "file-scan",
        count: 1,
        totalDuration: metric.duration,
        averageDuration: metric.duration,
        minDuration: metric.duration,
        maxDuration: metric.duration,
        durations: [metric.duration],
        lastMetrics: metric
      }
    ]
  ]),
  bottlenecks: [],
  recommendations: [createRecommendation()]
});

describe("Performance dashboard data provider", () => {
  let monitor: jest.Mocked<PerformanceMonitor>;
  let diagnosticService: jest.Mocked<DiagnosticService>;
  let provider: PerformanceDashboardDataProvider;
  let metric: PerformanceMetrics;
  let session: PerformanceSessionSummary;

  beforeEach(() => {
    metric = createPerformanceMetric();

    session = {
      sessionId: "session-123",
      startTime: Date.now() - 5_000,
      duration: 5_000,
      operationsCompleted: 1,
      averageOperationTime: metric.duration,
      memoryPeak: metric.memoryUsage.peak.heapUsed,
      errorsEncountered: 0
    };

    monitor = {
      generateReport: jest.fn(() => createReport(metric)),
      getMetricsHistory: jest.fn(() => [metric]),
      getBenchmarks: jest.fn(() => [createBenchmark()]),
      getSessionSummary: jest.fn(() => session),
      getActiveOperationsSnapshot: jest.fn(() => [
        {
          operationId: "op-active",
          operationType: "digest-generate",
          startedAt: Date.now() - 1_000,
          duration: 1_000,
          metadata: { label: "active" },
          resourceUsage: { fileOperations: 1, networkRequests: 0 }
        } as ActiveOperationSnapshot
      ])
    } as unknown as jest.Mocked<PerformanceMonitor>;

    const diagnostics: SystemHealthReport = {
      overall: "healthy",
      timestamp: new Date(),
      diagnostics: [
        {
          category: "performance",
          name: "operation-time",
          status: "pass",
          message: "All good"
        }
      ],
      summary: { passed: 1, warnings: 0, failed: 0 },
      recommendations: ["Consider refreshing baselines"]
    };

    diagnosticService = {
      runDiagnostics: jest.fn(async () => diagnostics)
    } as unknown as jest.Mocked<DiagnosticService>;

    jest.spyOn(process, "cpuUsage").mockImplementation(((previous?: NodeJS.CpuUsage) => {
      if (previous) {
        return { user: 50_000, system: 25_000 };
      }
      return { user: 100_000, system: 50_000 };
    }) as typeof process.cpuUsage);

    jest.spyOn(process, "memoryUsage").mockImplementation(() => createMemoryUsage(70_000_000));

    provider = new PerformanceDashboardDataProvider(monitor, diagnosticService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("collects dashboard data with recommendations", async () => {
    const data = await provider.getDashboardData();

    expect(data.currentSession.operationsCompleted).toBe(1);
    expect(data.historicalData.trends).toHaveLength(1);
    expect(data.recommendations).toHaveLength(2);
    expect((data.recommendations[0] as PerformanceRecommendation).title).toBe("Improve throughput");
    expect(data.benchmarks[0].operation).toBe("file-scan");
  });

  it("produces realtime updates with charts and session snapshot", async () => {
    const update = await provider.getRealtimeUpdate();

    expect(update.session.sessionId).toBe(session.sessionId);
    expect(update.metrics.activeOperations).toHaveLength(1);
    expect(Object.keys(update.charts)).toEqual(expect.arrayContaining(["performance", "memory", "error", "operation"]));
  });

  it("handles diagnostics failures gracefully", async () => {
    (diagnosticService.runDiagnostics as jest.Mock).mockImplementationOnce(() => Promise.reject(new Error("offline")));

    await expect(provider.getDashboardData()).resolves.toBeDefined();
    expect(monitor.generateReport).toHaveBeenCalled();
  });
});

describe("Performance report generator", () => {
  let monitor: jest.Mocked<PerformanceMonitor>;
  let diagnosticService: jest.Mocked<DiagnosticService>;
  let generator: PerformanceReportGenerator;
  let metric: PerformanceMetrics;

  beforeEach(() => {
    metric = createPerformanceMetric();

    monitor = {
      getMetricsHistory: jest.fn(() => [metric]),
      generateReport: jest.fn(() => createReport(metric))
    } as unknown as jest.Mocked<PerformanceMonitor>;

    const diagnostics: SystemHealthReport = {
      overall: "healthy",
      timestamp: new Date(),
      diagnostics: [
        {
          category: "performance",
          name: "operation-time",
          status: "pass",
          message: "ok"
        } as DiagnosticResult
      ],
      summary: { passed: 1, warnings: 0, failed: 0 },
      recommendations: ["Keep monitoring"]
    };

    diagnosticService = {
      runDiagnostics: jest.fn(async () => diagnostics)
    } as unknown as jest.Mocked<DiagnosticService>;

    generator = new PerformanceReportGenerator(monitor, diagnosticService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("generates JSON report", async () => {
    const json = await generator.generateReport("json");
    const parsed = JSON.parse(json) as Record<string, unknown>;
  expect(parsed.summary).toBeDefined();
  const summary = parsed.summary as { totalOperations: number };

    expect(parsed.performance).toBeDefined();
    expect(summary.totalOperations).toBe(1);
  });

  it("generates CSV report with header", async () => {
    const csv = await generator.generateReport("csv");
    const [header] = csv.split("\n");

    expect(header).toBe("Timestamp,Operation,Duration (ms),Status,Memory (MB)");
    expect(csv).toContain("file-scan");
  });
});
