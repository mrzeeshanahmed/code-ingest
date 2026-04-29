import { beforeEach, describe, expect, it, jest } from "@jest/globals";

import type { DiagnosticResult } from "../services/diagnosticService";
import { DiagnosticService } from "../services/diagnosticService";
import type { ConfigurationService } from "../services/configurationService";
import type { PerformanceMonitor } from "../services/performanceMonitor";
import type { ErrorReporter } from "../services/errorReporter";
import type { GitProcessManager, Logger } from "../utils/gitProcessManager";
import type { SystemDiagnostics, ConfigurationDiagnostics, PerformanceDiagnostics, ConnectivityDiagnostics, DependencyDiagnostics } from "../services/diagnosticService";

const createPassResult = (overrides: Partial<DiagnosticResult> = {}): DiagnosticResult => ({
  category: "system",
  name: "test",
  status: "pass",
  message: "ok",
  ...overrides
});

const baseConfigurationService = {
  getRequiredVSCodeVersion: jest.fn(() => "1.90.0"),
  getConfig: jest.fn(() => ({
    maxFiles: 5000,
    maxDepth: 4,
    outputFormat: "markdown",
    binaryFilePolicy: "skip",
    redactionPatterns: []
  })),
  getExtensionPath: jest.fn(() => process.cwd())
} as unknown as ConfigurationService;

const basePerformanceMonitor = {
  generateReport: jest.fn(() => ({
    overall: { averageDuration: 0 },
    bottlenecks: []
  })),
  getMetricsHistory: jest.fn(() => [])
} as unknown as PerformanceMonitor;

const baseErrorReporter = {
  getErrorBuffer: jest.fn(() => [])
} as unknown as ErrorReporter;

const baseGitProcessManager = {
  executeGitCommand: jest.fn(async () => ({ stdout: "git version 2.42.0", stderr: "", exitCode: 0, command: "git --version", duration: 10, retryCount: 0 }))
} as unknown as GitProcessManager;

const baseLogger: Logger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
};

describe("DiagnosticService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const createService = (options: {
    systemDiagnostics: Partial<SystemDiagnostics>;
    configurationDiagnostics: Partial<ConfigurationDiagnostics>;
    performanceDiagnostics: Partial<PerformanceDiagnostics>;
    connectivityDiagnostics: Partial<ConnectivityDiagnostics>;
    dependencyDiagnostics: Partial<DependencyDiagnostics>;
  }): DiagnosticService => {
    const systemDiagnostics = {
      checkVSCodeVersion: jest.fn(async () => createPassResult({ name: "vscode", category: "system" })),
      checkNodeVersion: jest.fn(async () => createPassResult({ name: "node", category: "system" })),
      checkMemoryUsage: jest.fn(async () => createPassResult({ name: "memory", category: "system" })),
      checkDiskSpace: jest.fn(async () => createPassResult({ name: "disk", category: "system" })),
      ...options.systemDiagnostics
    } as SystemDiagnostics;

    const configurationDiagnostics = {
      validateConfiguration: jest.fn(async () => [createPassResult({ name: "config", category: "configuration" })]),
      ...options.configurationDiagnostics
    } as ConfigurationDiagnostics;

    const performanceDiagnostics = {
      analyzePerformance: jest.fn(async () => [createPassResult({ name: "perf", category: "performance" })]),
      ...options.performanceDiagnostics
    } as PerformanceDiagnostics;

    const connectivityDiagnostics = {
      checkGitAvailability: jest.fn(async () => createPassResult({ name: "git", category: "connectivity" })),
      checkNetworkConnectivity: jest.fn(async () => createPassResult({ name: "network", category: "connectivity" })),
      ...options.connectivityDiagnostics
    } as ConnectivityDiagnostics;

    const dependencyDiagnostics = {
      checkNodeDependencies: jest.fn(async () => createPassResult({ name: "dependencies", category: "dependencies" })),
      ...options.dependencyDiagnostics
    } as DependencyDiagnostics;

    return new DiagnosticService(
      baseConfigurationService,
      basePerformanceMonitor,
      baseErrorReporter,
      baseGitProcessManager,
      baseLogger,
      {
        systemDiagnostics,
        configurationDiagnostics,
        performanceDiagnostics,
        connectivityDiagnostics,
        dependencyDiagnostics
      }
    );
  };

  it("produces a healthy report when all diagnostics succeed", async () => {
    const service = createService({
      systemDiagnostics: {},
      configurationDiagnostics: {},
      performanceDiagnostics: {},
      connectivityDiagnostics: {},
      dependencyDiagnostics: {}
    });

    const report = await service.runDiagnostics();

    expect(report.overall).toBe("healthy");
  expect(report.summary).toEqual({ passed: 9, warnings: 0, failed: 0 });
  expect(report.diagnostics).toHaveLength(9);
    expect(report.recommendations).toHaveLength(0);
  });

  it("filters diagnostics by category", async () => {
    const service = createService({
      systemDiagnostics: {},
      configurationDiagnostics: {},
      performanceDiagnostics: {},
      connectivityDiagnostics: {},
      dependencyDiagnostics: {}
    });

    const report = await service.runDiagnostics(["system", "dependencies"]);

    const categories = report.diagnostics.map((diag) => diag.category);
    expect(new Set(categories)).toEqual(new Set(["system", "dependencies"]));
    expect(report.diagnostics).toHaveLength(5);
    expect(baseLogger.debug).toHaveBeenCalled();
  });

  it("captures command failures in the report", async () => {
    const service = createService({
      systemDiagnostics: {},
      configurationDiagnostics: {},
      performanceDiagnostics: {},
      connectivityDiagnostics: {},
      dependencyDiagnostics: {}
    });

    service.registerCommand({
      id: "custom.failing",
      title: "Failing",
      description: "Fails intentionally",
      category: "system",
      execute: async () => {
        throw new Error("boom");
      }
    });

    const report = await service.runDiagnostics(["system"]);

    expect(report.overall).toBe("critical");
    expect(report.summary.failed).toBeGreaterThan(0);
    const failure = report.diagnostics.find((diag) => diag.name === "custom.failing");
    expect(failure?.status).toBe("fail");
    expect(failure?.message).toContain("boom");
  });
});