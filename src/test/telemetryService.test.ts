import { beforeEach, describe, expect, jest, test } from "@jest/globals";
import * as vscode from "vscode";

import { TelemetryService, type TelemetryEvent } from "../services/telemetryService";
import { ConfigurationService } from "../services/configurationService";
import type { Logger } from "../utils/gitProcessManager";
import type { PerformanceMonitor, PerformanceMetrics as OperationMetrics, PerformanceReport } from "../services/performanceMonitor";
import type { ErrorReporter } from "../services/errorReporter";
import { ErrorSeverity, ErrorCategory, type ErrorClassification } from "../utils/errorHandler";

class InMemoryConfigurationService extends ConfigurationService {
  private readonly store = new Map<string, unknown>();

  override getGlobalValue<T>(key: string): T | undefined {
    return this.store.get(key) as T | undefined;
  }

  override async updateGlobalValue(key: string, value: unknown): Promise<void> {
    if (value === null || value === undefined) {
      this.store.delete(key);
      return;
    }

    this.store.set(key, value);
  }
}

describe("TelemetryService", () => {
  let configService: InMemoryConfigurationService;
  let logger: Logger;
  let performanceMonitor: PerformanceMonitor;
  let errorReporter: ErrorReporter;
  let telemetry: TelemetryService;

  const zeroMemory: NodeJS.MemoryUsage = {
    rss: 0,
    heapTotal: 0,
    heapUsed: 0,
    external: 0,
    arrayBuffers: 0
  };

  const createMetrics = (overrides: Partial<OperationMetrics> = {}): OperationMetrics => ({
    operationId: "op-1",
    operationType: "digest",
    startTime: 0,
    endTime: 100,
    duration: 1000,
    memoryUsage: {
      start: zeroMemory,
      end: zeroMemory,
      peak: { ...zeroMemory, heapUsed: 1024 }
    },
    resourceUsage: {
      cpuTime: 1,
      fileOperations: 0,
      networkRequests: 0
    },
    metadata: {},
    ...overrides
  });

  const createPerformanceReport = (metrics: OperationMetrics[]): PerformanceReport => ({
    sessionId: "session-1",
    timestamp: new Date(),
    overall: {
      totalOperations: metrics.length,
      totalDuration: metrics.reduce((sum, metric) => sum + metric.duration, 0),
      averageDuration: metrics.length === 0 ? 0 : metrics.reduce((sum, metric) => sum + metric.duration, 0) / metrics.length,
      slowestOperation: metrics[0] ?? createMetrics(),
      fastestOperation: metrics[0] ?? createMetrics()
    },
    byOperation: new Map(),
    bottlenecks: [],
    recommendations: []
  });

  const telemetryConfigValues: Record<string, unknown> = {
    enabled: true,
    enabledInDevelopment: true,
    enabledInTests: true,
    collectionInterval: 0,
    maxEventsPerSession: 10,
    maxEventAge: 10_000,
    endpoint: undefined
  };

  beforeEach(async () => {
    jest.useRealTimers();
    const mockedVSCode = vscode as typeof vscode & { __reset?: () => void };
    mockedVSCode.__reset?.();

    const getConfigurationMock = vscode.workspace.getConfiguration as unknown as jest.MockedFunction<typeof vscode.workspace.getConfiguration>;
    getConfigurationMock.mockImplementation((section?: string) => {
      if (section === "codeIngest.telemetry") {
        return {
          get: jest.fn((key: string, fallback: unknown) => telemetryConfigValues[key] ?? fallback),
          update: jest.fn(),
          has: jest.fn().mockReturnValue(false),
          inspect: jest.fn().mockReturnValue(undefined)
        } as unknown as vscode.WorkspaceConfiguration;
      }
      return {
        get: jest.fn(),
        update: jest.fn(),
        has: jest.fn().mockReturnValue(false),
        inspect: jest.fn().mockReturnValue(undefined)
      } as unknown as vscode.WorkspaceConfiguration;
    });

    configService = new InMemoryConfigurationService();
    await configService.updateGlobalValue("codeIngest.telemetryConsent", true);

    logger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn()
    };

    performanceMonitor = {
      getMetricsHistory: jest.fn().mockReturnValue([]),
      generateReport: jest.fn().mockReturnValue(createPerformanceReport([]))
    } as unknown as PerformanceMonitor;

    errorReporter = {
      getErrorBuffer: jest.fn().mockReturnValue([])
    } as unknown as ErrorReporter;

    telemetry = new TelemetryService(configService, logger, performanceMonitor, errorReporter);
  });

  test("sanitizes sensitive strings before storing events", async () => {
    telemetry.trackEvent("test", {
      email: "user@example.com",
      path: "/Users/test/file.ts",
      note: "a".repeat(150)
    });

  await (telemetry as unknown as { flushBufferedEvents: () => Promise<void> }).flushBufferedEvents();

  const events = await (telemetry as unknown as { storage: { loadEvents: () => Promise<TelemetryEvent[]> } }).storage.loadEvents();
    expect(events).toHaveLength(1);
    expect(events[0].properties.email).toBe("[REDACTED]");
    expect(events[0].properties.path).toBe("[REDACTED]");
  const noteValue = events[0].properties.note as string;
  expect(noteValue.length).toBeLessThanOrEqual(103);
  });

  test("aggregates usage, performance and error metrics", async () => {
    const metrics = [
      createMetrics({ operationId: "op-1", duration: 1200 }),
      createMetrics({ operationId: "op-2", duration: 800 })
    ];

    (performanceMonitor.getMetricsHistory as jest.Mock).mockReturnValue(metrics);
    (performanceMonitor.generateReport as jest.Mock).mockReturnValue(createPerformanceReport(metrics));

    const errorClassification: ErrorClassification = {
      category: ErrorCategory.SYSTEM,
      severity: ErrorSeverity.CRITICAL,
      userFriendlyMessage: "boom",
      technicalDetails: "boom",
      suggestedActions: [],
      isRecoverable: false,
      isRetryable: false
    };

    (errorReporter.getErrorBuffer as jest.Mock).mockReturnValue([
      {
        context: { classification: errorClassification, recoverable: false },
        classification: errorClassification
      }
    ]);

    telemetry.trackFeatureUsage("digest-generation", { filePath: "/Users/me/file" });
    telemetry.recordOutputFormatUsage("Markdown");
    telemetry.trackOperation("digest", 1200, true, { filePath: "/Users/me/file" });
    telemetry.trackOperation("digest", 800, false);
    telemetry.trackError(new Error("boom"), { component: "test", operation: "digest" }, false);

  await (telemetry as unknown as { flushBufferedEvents: () => Promise<void> }).flushBufferedEvents();

  const aggregated = await telemetry.exportUserData();

    expect(aggregated.sessionCount).toBeGreaterThanOrEqual(1);
    expect(aggregated.totalOperations).toBe(2);
    expect(aggregated.averageOperationDuration).toBeGreaterThan(0);
    expect(aggregated.errorRate).toBeGreaterThan(0);
    expect(aggregated.featureUsage["digest-generation"]).toBe(1);
    expect(aggregated.performanceProfile.totalOperations).toBe(2);
    expect(["fair", "good", "excellent", "poor"]).toContain(aggregated.performanceProfile.performanceGrade);
  });

  test("disabling telemetry stops event collection", async () => {
    telemetry.setTelemetryEnabled(false);
    telemetry.trackEvent("disabled", { foo: "bar" });

  await (telemetry as unknown as { flushBufferedEvents: () => Promise<void> }).flushBufferedEvents();

  const events = await (telemetry as unknown as { storage: { loadEvents: () => Promise<TelemetryEvent[]> } }).storage.loadEvents();
    expect(events).toHaveLength(0);
    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining("telemetry.event.rejected"), expect.anything());
  });
});
