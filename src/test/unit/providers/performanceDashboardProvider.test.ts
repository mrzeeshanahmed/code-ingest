import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { TextEncoder } from "util";
import { PerformanceDashboardProvider } from "../../../providers/performanceDashboardProvider";
import type { ExtensionContext, Webview, WebviewView } from "vscode";
import type { DiagnosticService } from "../../../services/diagnosticService";
import type { PerformanceMonitor, PerformanceReport } from "../../../services/performanceMonitor";
import type { MetricsCollector } from "../../../services/performance/metricsCollector";
import type { DashboardMetrics } from "../../../services/performance/types";

jest.mock("vscode", () => {
  const encode = (value: string): Uint8Array => new TextEncoder().encode(value);
  const template = `<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src {{CSP_SOURCE}}; script-src 'nonce-{{NONCE}}';"><link rel="stylesheet" href="{{STYLE_URI}}"></head><body><div class="dashboard-container"></div><script nonce="{{NONCE}}" src="{{SCRIPT_URI}}"></script></body></html>`;

  const workspace = {
    fs: {
      readFile: jest.fn<(uri: unknown) => Promise<Uint8Array>>().mockResolvedValue(encode(template))
    },
    openTextDocument: jest
      .fn<(uri: unknown) => Promise<{ uri: { toString: () => string } }>>()
      .mockResolvedValue({ uri: { toString: () => "in-memory" } })
  };

  const window = {
    showWarningMessage: jest.fn<(message: string) => Promise<void> | void>(),
    showTextDocument: jest.fn<(doc: unknown) => Promise<void>>().mockResolvedValue(undefined)
  };

  const Uri = {
    joinPath: (
      ...segments: Array<{ fsPath?: string; toString?: () => string } | string>
    ) => {
      const path = segments
        .map((segment) => (typeof segment === "string" ? segment : segment?.fsPath ?? ""))
        .filter(Boolean)
        .join("/");
      return {
        fsPath: path,
        toString: () => path
      };
    }
  };

  return {
    Uri,
    workspace,
    window
  };
});

type WorkspaceMock = {
  fs: { readFile: jest.Mock<(uri: unknown) => Promise<Uint8Array>> };
  openTextDocument: jest.Mock<(uri: unknown) => Promise<{ uri: { toString: () => string } }>>;
};

type WindowMock = {
  showWarningMessage: jest.Mock<(message: string) => Promise<void> | void>;
  showTextDocument: jest.Mock<(doc: unknown) => Promise<void>>;
};

const { workspace, window: vscodeWindow } = jest.requireMock("vscode") as {
  workspace: WorkspaceMock;
  window: WindowMock;
};

function createSampleMetrics(): DashboardMetrics {
  const startedAt = Date.now() - 5_000;
  return {
    realTime: {
      currentOperations: [
        {
          id: "op-1",
          name: "scan",
          status: "running",
          startedAt,
          duration: 5_000,
          metadata: { mode: "full" },
          memory: {
            rss: 1_000_000,
            heapTotal: 500_000,
            heapUsed: 400_000,
            external: 0,
            arrayBuffers: 0
          }
        }
      ],
      memoryUsage: {
        rss: 1_000_000,
        heapTotal: 500_000,
        heapUsed: 400_000,
        external: 0,
        arrayBuffers: 0
      },
      cpuUsage: 42,
      queuedOperations: 0,
      lastCompletedOperation: {
        id: "op-0",
        name: "digest",
        startedAt,
        duration: 2_000,
        status: "completed",
        metadata: { success: true }
      }
    },
    session: {
      startTime: new Date(Date.now() - 60_000),
      duration: 60_000,
      operationsCompleted: 4,
      averageOperationTime: 1_500,
      memoryPeak: 800_000,
      errorsEncountered: 0,
      filesProcessed: 12
    },
    historical: {
      operationTrends: [
        { timestamp: Date.now() - 60_000, value: 1_200, label: "digest" }
      ],
      memoryTrends: [
        { timestamp: Date.now() - 60_000, value: 350_000, label: "heap" }
      ],
      errorRates: [
        { timestamp: Date.now() - 60_000, value: 0, label: "errorRate" }
      ],
      performanceRegressions: []
    },
    insights: {
      bottlenecks: [
        {
          type: "cpu",
          severity: "medium",
          operation: "digest",
          description: "Digest operations running slow",
          impact: 0.3,
          suggestions: ["Optimize file batching"],
          metrics: {
            operationId: "hist-1",
            operationType: "digest",
            startTime: 0,
            endTime: 0,
            duration: 1_000,
            memoryUsage: {
              start: {
                rss: 0,
                heapTotal: 0,
                heapUsed: 0,
                external: 0,
                arrayBuffers: 0
              },
              end: {
                rss: 0,
                heapTotal: 0,
                heapUsed: 0,
                external: 0,
                arrayBuffers: 0
              },
              peak: {
                rss: 0,
                heapTotal: 0,
                heapUsed: 0,
                external: 0,
                arrayBuffers: 0
              }
            },
            resourceUsage: {
              cpuTime: 0,
              fileOperations: 0,
              networkRequests: 0
            },
            metadata: {}
          }
        }
      ],
      recommendations: [
        {
          category: "performance",
          priority: "high",
          title: "Enable caching",
          description: "Caching can improve digest throughput",
          implementationComplexity: "moderate",
          estimatedImpact: 0.5,
          actionItems: ["Implement LRU cache"],
          relatedOperations: ["digest"]
        }
      ],
      alerts: [
        {
          id: "alert-1",
          category: "cpu",
          severity: "warning",
          message: "CPU usage > 80%",
          detectedAt: Date.now()
        }
      ]
    }
  };
}

describe("PerformanceDashboardProvider", () => {
  let performanceMonitor: jest.Mocked<PerformanceMonitor>;
  let diagnosticService: jest.Mocked<DiagnosticService>;
  let metricsCollector: jest.Mocked<MetricsCollector>;
  let context: ExtensionContext;
  let webview: Webview;
  let webviewView: WebviewView;
  let model: PerformanceDashboardProvider;
  let messageListener: ((message: unknown) => void) | undefined;
  let disposeCallbacks: Array<() => void>;
  let visibilityListeners: Array<() => void>;

  beforeEach(() => {
    jest.useFakeTimers();

    const metrics = createSampleMetrics();

    metricsCollector = {
      getCurrentMetrics: jest.fn().mockReturnValue(metrics)
    } as unknown as jest.Mocked<MetricsCollector>;

    const report: PerformanceReport = {
      sessionId: "session-test",
      timestamp: new Date(),
      overall: {
        totalOperations: 4,
        totalDuration: 6_000,
        averageDuration: 1_500,
        slowestOperation: metrics.insights.bottlenecks[0].metrics,
        fastestOperation: metrics.insights.bottlenecks[0].metrics
      },
      byOperation: new Map(),
      bottlenecks: metrics.insights.bottlenecks,
      recommendations: metrics.insights.recommendations
    };

    performanceMonitor = {
      generateReport: jest.fn().mockReturnValue(report),
      onDidRecordMetrics: jest.fn().mockReturnValue({ dispose: jest.fn() }),
      onDidChangeActiveOperations: jest.fn().mockReturnValue({ dispose: jest.fn() })
    } as unknown as jest.Mocked<PerformanceMonitor>;

    diagnosticService = {
      runDiagnostics: jest.fn()
    } as unknown as jest.Mocked<DiagnosticService>;

    context = {
      extensionUri: { fsPath: "/tmp/code-ingest", toString: () => "/tmp/code-ingest" }
    } as unknown as ExtensionContext;

    disposeCallbacks = [];
    visibilityListeners = [];

    webview = {
      options: {},
      html: "",
      cspSource: "vscode-resource:",
      asWebviewUri: jest.fn((uri: { toString?: () => string } | string) => ({
        toString: () => (typeof uri === "string" ? uri : uri.toString?.() ?? "")
      })),
      postMessage: jest.fn<(message: unknown) => Promise<boolean>>().mockResolvedValue(true),
      onDidReceiveMessage: jest.fn((listener: (message: unknown) => void) => {
        messageListener = listener;
        return { dispose: jest.fn() };
      })
    } as unknown as Webview;

    webviewView = {
      webview,
      visible: true,
      onDidChangeVisibility: jest.fn((callback: () => void) => {
        visibilityListeners.push(callback);
        return { dispose: jest.fn() };
      }),
      onDidDispose: (callback: () => void) => {
        disposeCallbacks.push(callback);
      }
    } as unknown as WebviewView;

    model = new PerformanceDashboardProvider(context, performanceMonitor, diagnosticService, metricsCollector);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  async function resolveView(): Promise<void> {
    await model.resolveWebviewView(webviewView);
    await Promise.resolve();
  }

  test("loads metrics and posts initial update", async () => {
    await resolveView();

    expect(workspace.fs.readFile).toHaveBeenCalled();
    expect(metricsCollector.getCurrentMetrics).toHaveBeenCalled();
    expect(webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "metricsUpdate" }));
  });

  test("sends periodic updates when real-time is enabled", async () => {
    await resolveView();
    jest.advanceTimersByTime(1_100);
    await Promise.resolve();
    expect(webview.postMessage).toHaveBeenCalledTimes(2);
  });

  test("responds to historical data requests", async () => {
    await resolveView();
    messageListener?.({ type: "requestHistorical" });
    await Promise.resolve();
    expect(webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "historicalData" }));
  });

  test("exports reports on demand", async () => {
    await resolveView();
    await model["handleMessage"]({ type: "exportReport" });
    expect(performanceMonitor.generateReport).toHaveBeenCalled();
    expect(workspace.openTextDocument).toHaveBeenCalled();
  expect(vscodeWindow.showTextDocument).toHaveBeenCalled();
  });

  test("stops real-time updates when disposed", async () => {
    await resolveView();
    jest.advanceTimersByTime(1_100);
    await Promise.resolve();
    const callsBeforeDispose = (webview.postMessage as jest.Mock).mock.calls.length;
    disposeCallbacks.forEach((callback) => callback());
    jest.advanceTimersByTime(2_000);
    await Promise.resolve();
    expect((webview.postMessage as jest.Mock).mock.calls.length).toBe(callsBeforeDispose);
  });
});
