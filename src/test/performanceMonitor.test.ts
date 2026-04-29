import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { performance } from "node:perf_hooks";
import * as fs from "node:fs/promises";
import * as vscode from "vscode";

import { PerformanceMonitor } from "../services/performanceMonitor";
import type { ConfigurationService } from "../services/configurationService";
import type { Logger } from "../utils/gitProcessManager";

jest.mock("node:fs/promises", () => ({
  readFile: jest.fn(),
  writeFile: jest.fn(),
  mkdir: jest.fn()
}));

const mockedFs = fs as unknown as jest.Mocked<typeof fs>;

describe("PerformanceMonitor", () => {
  const createLogger = (): Logger => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  });

  const createMemoryUsage = (heapUsedBytes: number): NodeJS.MemoryUsage => ({
    rss: 100 * 1024 * 1024,
    heapTotal: 120 * 1024 * 1024,
    heapUsed: heapUsedBytes,
    external: 10 * 1024 * 1024,
    arrayBuffers: 5 * 1024 * 1024
  });

  const advanceAllTimers = async (): Promise<void> => {
    jest.runOnlyPendingTimers();
    await Promise.resolve();
  };

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));

  mockedFs.readFile.mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }));
  mockedFs.writeFile.mockResolvedValue(undefined);
  mockedFs.mkdir.mockResolvedValue(undefined);

    (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
      get: jest.fn().mockReturnValue(2_048)
    });

    jest.spyOn(Math, "random").mockReturnValue(0.123456789);

    let now = 0;
    jest.spyOn(performance, "now").mockImplementation(() => {
      now += 50;
      return now;
    });
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
    mockedFs.readFile.mockReset();
    mockedFs.writeFile.mockReset();
    mockedFs.mkdir.mockReset();
    (vscode.workspace.getConfiguration as jest.Mock).mockReset();
  });

  it("collects metrics for successful async operations", async () => {
    let memoryUsage = createMemoryUsage(80 * 1024 * 1024);
    jest.spyOn(process, "memoryUsage").mockImplementation(() => ({ ...memoryUsage }));
    jest.spyOn(process, "cpuUsage").mockImplementation(() => ({ user: 500_000, system: 250_000 }));

    const logger = createLogger();
    const configService = { getExtensionPath: jest.fn().mockReturnValue("C:/ext") } as unknown as ConfigurationService;
    const monitor = new PerformanceMonitor(logger, configService);

    const resultPromise = monitor.measureAsync("file-scan", async () => {
      memoryUsage = createMemoryUsage(120 * 1024 * 1024);
      jest.advanceTimersByTime(1_000);
      return "ok";
    });

    await resultPromise;

    const history = monitor.getMetricsHistory();
    expect(history).toHaveLength(1);
    const metrics = history[0];

    expect(metrics.operationType).toBe("file-scan");
    expect(metrics.duration).toBeGreaterThan(0);
    expect(metrics.memoryUsage.peak.heapUsed).toBe(120 * 1024 * 1024);
    expect(metrics.resourceUsage.cpuTime).toBeCloseTo(750);

    await monitor.dispose();
    await advanceAllTimers();
  });

  it("returns an empty report when no operations have been recorded", async () => {
    jest.spyOn(process, "memoryUsage").mockImplementation(() => createMemoryUsage(80 * 1024 * 1024));
    jest.spyOn(process, "cpuUsage").mockImplementation(() => ({ user: 0, system: 0 }));

    const logger = createLogger();
    const configService = { getExtensionPath: jest.fn().mockReturnValue("C:/ext") } as unknown as ConfigurationService;
    const monitor = new PerformanceMonitor(logger, configService);

    const report = monitor.generateReport();

    expect(report.overall.totalOperations).toBe(0);
    expect(report.bottlenecks).toHaveLength(0);
    expect(report.overall.slowestOperation.operationId).toBe("none");

    await monitor.dispose();
    await advanceAllTimers();
  });

  it("captures error metadata when measured async operation fails", async () => {
    jest.spyOn(process, "memoryUsage").mockImplementation(() => createMemoryUsage(80 * 1024 * 1024));
    jest.spyOn(process, "cpuUsage").mockImplementation(() => ({ user: 100_000, system: 50_000 }));

    const logger = createLogger();
    const configService = { getExtensionPath: jest.fn().mockReturnValue("C:/ext") } as unknown as ConfigurationService;
    const monitor = new PerformanceMonitor(logger, configService);

    await expect(
      monitor.measureAsync("content-process", async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");

    const history = monitor.getMetricsHistory();
    expect(history).toHaveLength(1);
    expect(history[0].metadata.error).toBe("boom");

    await monitor.dispose();
    await advanceAllTimers();
  });

  it("provides aggregated session summary", async () => {
    let memoryUsage = createMemoryUsage(90 * 1024 * 1024);
    jest.spyOn(process, "memoryUsage").mockImplementation(() => ({ ...memoryUsage }));
    jest.spyOn(process, "cpuUsage").mockImplementation(() => ({ user: 150_000, system: 75_000 }));

    const logger = createLogger();
    const configService = { getExtensionPath: jest.fn().mockReturnValue("C:/ext") } as unknown as ConfigurationService;
    const monitor = new PerformanceMonitor(logger, configService);

    await monitor.measureAsync("file-scan", async () => {
      memoryUsage = createMemoryUsage(140 * 1024 * 1024);
      jest.advanceTimersByTime(1_200);
      return "done";
    });

    jest.advanceTimersByTime(800);

    const summary = monitor.getSessionSummary();

    expect(summary.sessionId).toMatch(/session-/);
    expect(summary.operationsCompleted).toBe(1);
    expect(summary.averageOperationTime).toBeGreaterThan(0);
    expect(summary.memoryPeak).toBe(140 * 1024 * 1024);
    expect(summary.errorsEncountered).toBe(0);
    expect(summary.duration).toBeGreaterThan(0);

    await monitor.dispose();
    await advanceAllTimers();
  });

  it("captures active operation snapshots", async () => {
    jest.spyOn(process, "memoryUsage").mockImplementation(() => createMemoryUsage(64 * 1024 * 1024));
    jest.spyOn(process, "cpuUsage").mockImplementation(() => ({ user: 120_000, system: 60_000 }));

    const logger = createLogger();
    const configService = { getExtensionPath: jest.fn().mockReturnValue("C:/ext") } as unknown as ConfigurationService;
    const monitor = new PerformanceMonitor(logger, configService);

    const operationId = monitor.startOperation("content-process", { source: "unit-test" });
    monitor.recordResourceUsage(operationId, { fileOperations: 3, networkRequests: 1 });

    const snapshots = monitor.getActiveOperationsSnapshot();
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].operationId).toBe(operationId);
    expect(snapshots[0].metadata.source).toBe("unit-test");
    expect(snapshots[0].resourceUsage.fileOperations).toBe(3);

    monitor.endOperation(operationId);

    const emptySnapshots = monitor.getActiveOperationsSnapshot();
    expect(emptySnapshots).toHaveLength(0);

    await monitor.dispose();
    await advanceAllTimers();
  });
});