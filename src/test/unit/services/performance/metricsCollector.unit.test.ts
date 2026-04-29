import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";

import { MetricsCollector } from "../../../../services/performance/metricsCollector";
import type {
  PerformanceMetrics,
  PerformanceMonitor,
  PerformanceReport
} from "../../../../services/performanceMonitor";
import type { DiagnosticService, SystemHealthReport } from "../../../../services/diagnosticService";

const createMemoryUsage = (): NodeJS.MemoryUsage => ({
  rss: 10_485_760,
  heapTotal: 5_242_880,
  heapUsed: 2_621_440,
  external: 0,
  arrayBuffers: 0
});

describe("MetricsCollector", () => {
  let performanceMonitor: jest.Mocked<PerformanceMonitor>;
  let diagnosticService: jest.Mocked<DiagnosticService>;
  let collector: MetricsCollector;
  let metricsHistory: PerformanceMetrics[];
  let report: PerformanceReport;

  beforeEach(async () => {
    jest.useFakeTimers();

    const now = Date.now();
    const memory = createMemoryUsage();
    metricsHistory = [
      {
        operationId: "op-1",
        operationType: "digest",
        startTime: now - 1_000,
        endTime: now,
        duration: 1_000,
        memoryUsage: {
          start: memory,
          end: memory,
          peak: { ...memory, heapUsed: memory.heapUsed + 1_048_576 }
        },
        resourceUsage: {
          cpuTime: 12,
          fileOperations: 4,
          networkRequests: 2
        },
        metadata: {
          startedAt: now - 2_000,
          completedAt: now,
          filesProcessed: 5
        }
      }
    ];

    report = {
      sessionId: "session-test",
      timestamp: new Date(now),
      overall: {
        totalOperations: 1,
        totalDuration: 1_000,
        averageDuration: 1_000,
        slowestOperation: metricsHistory[0],
        fastestOperation: metricsHistory[0]
      },
      byOperation: new Map(),
      bottlenecks: [
        {
          type: "cpu",
          severity: "medium",
          operation: "digest",
          description: "High CPU",
          impact: 0.5,
          suggestions: ["Optimize loops"],
          metrics: metricsHistory[0]
        }
      ],
      recommendations: [
        {
          category: "performance",
          priority: "high",
          title: "Optimize digest",
          description: "Digest operations are slow",
          implementationComplexity: "moderate",
          estimatedImpact: 0.6,
          actionItems: ["Profile hot paths"],
          relatedOperations: ["digest"]
        }
      ]
    } satisfies PerformanceReport;

    performanceMonitor = {
      startOperation: jest.fn().mockReturnValue("op-1"),
      endOperation: jest.fn().mockReturnValue(metricsHistory[0]),
      getSessionSummary: jest.fn().mockReturnValue({
        sessionId: "session-test",
        startTime: now - 30_000,
        duration: 30_000,
        operationsCompleted: 1,
        averageOperationTime: 1_000,
        memoryPeak: 3_670_016,
        errorsEncountered: 0
      }),
      getMetricsHistory: jest.fn().mockReturnValue(metricsHistory),
      generateReport: jest.fn().mockReturnValue(report),
      getBenchmarks: jest.fn().mockReturnValue([
        {
          operation: "digest",
          baseline: 500,
          threshold: 2_000,
          samples: [800, 1_200, 1_400],
          percentiles: {
            p50: 800,
            p90: 1_300,
            p95: 1_400,
            p99: 1_500
          },
          trend: "degrading"
        }
      ]),
      getActiveOperationsSnapshot: jest.fn().mockReturnValue([
        {
          operationId: "op-active",
          operationType: "scan",
          startedAt: now - 5_000,
          duration: 5_000,
          metadata: { scope: "workspace" },
          resourceUsage: {
            fileOperations: 3,
            networkRequests: 0
          }
        }
      ]),
      onDidRecordMetrics: jest.fn().mockReturnValue({ dispose: jest.fn() }),
      onDidChangeActiveOperations: jest.fn().mockReturnValue({ dispose: jest.fn() })
    } as unknown as jest.Mocked<PerformanceMonitor>;

    diagnosticService = {
      runDiagnostics: jest.fn<() => Promise<SystemHealthReport>>().mockResolvedValue({
        overall: "healthy",
        timestamp: new Date(now),
        diagnostics: [],
        summary: { passed: 1, warnings: 0, failed: 0 },
        recommendations: []
      } satisfies SystemHealthReport)
    } as unknown as jest.Mocked<DiagnosticService>;

    collector = new MetricsCollector(performanceMonitor, diagnosticService);
    await Promise.resolve();
    jest.advanceTimersByTime(1_100);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test("collects current dashboard metrics with session data", () => {
    const metrics = collector.getCurrentMetrics();

    expect(metrics.realTime.currentOperations).toHaveLength(1);
    expect(metrics.realTime.memoryUsage.heapUsed).toBeGreaterThan(0);
    expect(metrics.session.operationsCompleted).toBe(1);
    expect(metrics.insights.bottlenecks).toHaveLength(1);
    expect(metrics.insights.recommendations[0].title).toBe("Optimize digest");
  });

  test("provides historical trend data", () => {
    const trends = collector.getHistoricalTrends(1);
    expect(trends).toHaveLength(1);
    expect(trends[0].label).toBe("digest");
  });

  test("detects bottlenecks and recommendations", () => {
    const bottlenecks = collector.detectBottlenecks();
    const recommendations = collector.generateRecommendations();

    expect(bottlenecks).toHaveLength(1);
    expect(recommendations).toHaveLength(1);
  });
});