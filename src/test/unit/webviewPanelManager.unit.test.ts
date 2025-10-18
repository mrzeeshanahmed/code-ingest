import { describe, expect, it, beforeEach, afterEach, jest } from "@jest/globals";
import * as vscode from "vscode";
import { WebviewPanelManager } from "../../webview/webviewPanelManager";
import { CodeIngestPanel } from "../../providers/codeIngestPanel";
import { Diagnostics } from "../../services/diagnostics";
import type { PerformanceMetrics, PerformanceMonitor } from "../../services/performanceMonitor";

describe("WebviewPanelManager", () => {
  const extensionUri = vscode.Uri.parse("file:///test-extension");
  let restoreSpy: jest.SpiedFunction<typeof CodeIngestPanel.restoreState>;
  let ensureResourcesReady: jest.MockedFunction<() => Promise<void>>;
  let diagnostics: Diagnostics;
  let performanceMonitor: {
    measureSync: jest.MockedFunction<
      (operation: string, operationFn: () => unknown, metadata?: Record<string, unknown>) => {
        result: unknown;
        metrics: PerformanceMetrics;
      }
    >;
  };

  const createMetrics = (): PerformanceMetrics => ({
    operationId: "test",
    operationType: "test",
    startTime: 0,
    endTime: 0,
    duration: 0,
    memoryUsage: {
      start: { rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 },
      end: { rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 },
      peak: { rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 }
    },
    resourceUsage: { cpuTime: 0, fileOperations: 0, networkRequests: 0 },
    metadata: {}
  });

  beforeEach(() => {
    restoreSpy = jest.spyOn(CodeIngestPanel, "restoreState").mockReturnValue(false);
    ensureResourcesReady = jest.fn(async () => {});
    diagnostics = new Diagnostics();
    performanceMonitor = {
      measureSync: jest.fn((_, operationFn) => ({ result: operationFn(), metrics: createMetrics() }))
    };
  });

  afterEach(() => {
    restoreSpy.mockRestore();
  });

  it("stores state without emitting when emit option is false", () => {
    const manager = new WebviewPanelManager(
      extensionUri,
      ensureResourcesReady,
      diagnostics,
      performanceMonitor as unknown as PerformanceMonitor
    );
    manager.setStateSnapshot({ foo: "bar" }, { emit: false });

    expect(restoreSpy).not.toHaveBeenCalled();
    expect(manager.getStateSnapshot()).toEqual({ foo: "bar" });
  });

  it("attempts to restore immediately when emit option is omitted", () => {
    const manager = new WebviewPanelManager(
      extensionUri,
      ensureResourcesReady,
      diagnostics,
      performanceMonitor as unknown as PerformanceMonitor
    );
    manager.setStateSnapshot({ foo: "bar" });

    expect(restoreSpy).toHaveBeenCalledTimes(1);
    expect(restoreSpy).toHaveBeenCalledWith({ foo: "bar" });
  });

  it("restores the stored state when requested", () => {
    const manager = new WebviewPanelManager(
      extensionUri,
      ensureResourcesReady,
      diagnostics,
      performanceMonitor as unknown as PerformanceMonitor
    );
    manager.setStateSnapshot({ foo: "bar" }, { emit: false });

    restoreSpy.mockReturnValueOnce(true);
    expect(manager.tryRestoreState()).toBe(true);
    expect(restoreSpy).toHaveBeenCalledWith({ foo: "bar" });
  });
});
