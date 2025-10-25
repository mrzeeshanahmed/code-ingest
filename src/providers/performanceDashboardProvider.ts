import * as vscode from "vscode";

import { DiagnosticService } from "../services/diagnosticService";
import { PerformanceMonitor } from "../services/performanceMonitor";
import { MetricsCollector } from "../services/performance/metricsCollector";
import type { DashboardMetrics } from "../services/performance/types";
import { detectFallbackHtml, setWebviewHtml } from "./webviewHelpers";

interface WebviewMessage {
  type: string;
  payload?: unknown;
}

export class PerformanceDashboardProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "codeIngest.performanceDashboard";

  private webview: vscode.Webview | undefined;
  private updateInterval: NodeJS.Timeout | undefined;
  private readonly metricsCollector: MetricsCollector;
  private readonly disposables: vscode.Disposable[] = [];
  private isRealTimeEnabled = true;
  private readonly ensureResourcesReady: () => Promise<void>;
  private hasRenderedFallback = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly performanceMonitor: PerformanceMonitor,
    private readonly diagnosticService: DiagnosticService,
    metricsCollector?: MetricsCollector,
    ensureResourcesReady?: () => Promise<void>
  ) {
    this.metricsCollector = metricsCollector ?? new MetricsCollector(this.performanceMonitor, this.diagnosticService);
    this.ensureResourcesReady = ensureResourcesReady ?? (async () => {});

    this.disposables.push(
      this.performanceMonitor.onDidRecordMetrics(() => this.pushMetricsUpdate()),
      this.performanceMonitor.onDidChangeActiveOperations(() => this.pushMetricsUpdate())
    );
  }

  async resolveWebviewView(webviewView: vscode.WebviewView): Promise<void> {
    this.webview = webviewView.webview;
    this.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "out", "resources", "webview")]
    };

    try {
      await this.ensureResourcesReady();
      const html = setWebviewHtml(
        this.webview,
        this.context.extensionUri,
        "out/resources/webview/performanceDashboard/index.html"
      );
      this.handleInitialRender(html);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.webview.html = `<html><body><h2>Performance Dashboard</h2><p>Failed to load dashboard resources: ${message}</p></body></html>`;
      void vscode.window.showErrorMessage(
        `Code Ingest: Performance dashboard failed to load required assets. ${message}`
      );
      return;
    }

    const messageSubscription = this.webview.onDidReceiveMessage((message: WebviewMessage) => {
      void this.handleMessage(message);
    });

    const visibilitySubscription = webviewView.onDidChangeVisibility(() => {
      if (!this.isRealTimeEnabled) {
        return;
      }
      if (webviewView.visible) {
        this.startRealTimeUpdates();
        void this.pushMetricsUpdate();
      } else {
        this.stopRealTimeUpdates();
      }
    });

    webviewView.onDidDispose(() => {
      messageSubscription.dispose();
      visibilitySubscription.dispose();
      this.stopRealTimeUpdates();
      this.webview = undefined;
    });

    void this.pushMetricsUpdate();
    this.startRealTimeUpdates();
  }

  dispose(): void {
    this.stopRealTimeUpdates();
    this.disposables.forEach((disposable) => disposable.dispose());
    this.disposables.length = 0;
    this.metricsCollector.dispose();
  }

  private startRealTimeUpdates(): void {
    this.stopRealTimeUpdates();
    if (!this.isRealTimeEnabled) {
      return;
    }

    const interval = setInterval(() => {
      void this.pushMetricsUpdate();
    }, 1_000);

    if (typeof interval.unref === "function") {
      interval.unref();
    }

    this.updateInterval = interval;
  }

  private stopRealTimeUpdates(): void {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = undefined;
    }
  }

  private async collectMetrics(): Promise<DashboardMetrics> {
    return this.metricsCollector.getCurrentMetrics();
  }

  private async pushMetricsUpdate(): Promise<void> {
    if (!this.webview) {
      return;
    }
    try {
      const metrics = await this.collectMetrics();
      this.sendMetricsUpdate(metrics);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      void vscode.window.showWarningMessage(`Failed to update performance dashboard: ${message}`);
    }
  }

  private sendMetricsUpdate(metrics: DashboardMetrics): void {
    this.webview?.postMessage({ type: "metricsUpdate", data: metrics });
  }

  private async handleMessage(message: WebviewMessage): Promise<void> {
    if (!message || typeof message.type !== "string") {
      return;
    }

    switch (message.type) {
      case "requestMetrics": {
        const metrics = await this.collectMetrics();
        this.sendMetricsUpdate(metrics);
        break;
      }
      case "toggleRealTime": {
        const enabled = Boolean(message.payload);
        this.isRealTimeEnabled = enabled;
        if (enabled) {
          this.startRealTimeUpdates();
        } else {
          this.stopRealTimeUpdates();
        }
        break;
      }
      case "exportReport": {
        await this.exportPerformanceReport();
        break;
      }
      case "requestHistorical": {
        await this.sendHistoricalData();
        break;
      }
      default:
        break;
    }
  }

  private async exportPerformanceReport(): Promise<void> {
    const report = this.performanceMonitor.generateReport();
    const content = `${JSON.stringify(report, null, 2)}\n`;
    const document = await vscode.workspace.openTextDocument({ content, language: "json" });
    await vscode.window.showTextDocument(document, { preview: false });
  }

  private async sendHistoricalData(): Promise<void> {
    const metrics = await this.collectMetrics();
    this.webview?.postMessage({ type: "historicalData", data: metrics.historical });
  }

  private handleInitialRender(html: string): void {
    const detection = detectFallbackHtml(html);
    if (!detection.isFallback) {
      this.hasRenderedFallback = false;
      return;
    }

    if (this.hasRenderedFallback) {
      return;
    }

    this.hasRenderedFallback = true;
    const reason = detection.reason ?? "unknown";
    console.error("PerformanceDashboardProvider: Webview rendered fallback UI", { reason });
    void vscode.window.showErrorMessage(
      `Code Ingest: Performance dashboard assets missing (${reason}). Run "npm run build:webview" and try again.`
    );
  }
}
