import * as crypto from "node:crypto";
import * as os from "node:os";
import * as vscode from "vscode";

import { ConfigurationService } from "./configurationService";
import { ErrorReporter } from "./errorReporter";
import {
  PerformanceMonitor,
  type PerformanceMetrics as OperationMetrics,
  type PerformanceReport
} from "./performanceMonitor";
import { ErrorSeverity, type ErrorContext, type ErrorClassification } from "../utils/errorHandler";
import type { Logger } from "../utils/gitProcessManager";

export interface TelemetryEvent {
  name: string;
  properties: Record<string, string | number | boolean>;
  measurements: Record<string, number>;
  timestamp: Date;
  sessionId: string;
  userId: string;
}

export interface TelemetryConfiguration {
  enabled: boolean;
  enabledInDevelopment: boolean;
  enabledInTests: boolean;
  collectionInterval: number;
  maxEventsPerSession: number;
  maxEventAge: number;
  endpoint?: string;
}

export interface PerformanceProfile {
  totalOperations: number;
  averageOperationDuration: number;
  slowestOperation: string;
  memoryUsageAverage: number;
  operationDistribution: Record<string, number>;
  performanceGrade: "excellent" | "good" | "fair" | "poor";
}

export interface AggregatedMetrics {
  sessionCount: number;
  totalOperations: number;
  averageOperationDuration: number;
  errorRate: number;
  featureUsage: Record<string, number>;
  performanceProfile: PerformanceProfile;
}

interface ValidationResult {
  isValid: boolean;
  issues: string[];
}

interface SessionMetrics {
  sessionDuration: number;
  extensionVersion: string;
  vscodeVersion: string;
  platform: string;
  nodeVersion: string;
  totalMemoryGB: number;
  cpuCores: number;
}

interface PerformanceAggregation {
  totalOperations: number;
  averageOperationTime: number;
  slowestOperation: string;
  memoryUsageAverage: number;
  operationDistribution: Record<string, number>;
  performanceGrade: PerformanceProfile["performanceGrade"];
}

interface UsageMetrics {
  featuresUsed: Record<string, number>;
  outputFormatsUsed: Record<string, number>;
  averageFileCount: number;
  remoteRepoUsage: number;
  configurationComplexity: number;
}

interface ErrorMetrics {
  totalErrors: number;
  errorsByCategory: Record<string, number>;
  recoveryRate: number;
  criticalErrorCount: number;
}

interface TelemetryOperationSnapshot {
  totalOperations: number;
  totalDuration: number;
  successfulOperations: number;
  failedOperations: number;
  durations: number[];
  operationsByName: Map<string, { count: number; totalDuration: number }>;
}

const TELEMETRY_STORAGE_KEY = "codeIngest.telemetry.events";
const TELEMETRY_ENABLED_OVERRIDE_KEY = "codeIngest.telemetry.override";

const DEFAULT_CONFIG: TelemetryConfiguration = {
  enabled: false,
  enabledInDevelopment: false,
  enabledInTests: false,
  collectionInterval: 60_000,
  maxEventsPerSession: 500,
  maxEventAge: 7 * 24 * 60 * 60 * 1000
};

export class TelemetryService implements vscode.Disposable {
  private config: TelemetryConfiguration;
  private readonly eventBuffer: TelemetryEvent[] = [];
  private readonly sessionId: string;
  private readonly userId: string;
  private isEnabled: boolean;
  private flushTimer: NodeJS.Timeout | null = null;
  private readonly privacyManager = new PrivacyManager();
  private readonly storage: TelemetryStorage;
  private readonly consentManager: TelemetryConsentManager;
  private readonly validator = new TelemetryValidator();
  private readonly metricsCollector: AggregatedMetricsCollector;
  private readonly sessionStartTime = Date.now();
  private readonly featureUsage = new Map<string, number>();
  private readonly outputFormatUsage = new Map<string, number>();
  private operationSnapshot: TelemetryOperationSnapshot = {
    totalOperations: 0,
    totalDuration: 0,
    successfulOperations: 0,
    failedOperations: 0,
    durations: [],
    operationsByName: new Map()
  };

  constructor(
    private readonly configService: ConfigurationService,
    private readonly logger: Logger,
    private readonly performanceMonitor: PerformanceMonitor,
    private readonly errorReporter: ErrorReporter
  ) {
    this.storage = new TelemetryStorage(this.configService);
    this.consentManager = new TelemetryConsentManager(this.configService);
    this.sessionId = this.generateSessionId();
    this.userId = this.privacyManager.generateStableUserId();
    this.config = this.loadTelemetryConfiguration();
    this.isEnabled = this.shouldEnableTelemetry();
    this.metricsCollector = new AggregatedMetricsCollector(
      this.performanceMonitor,
      this.errorReporter,
      () => new Map(this.featureUsage),
      () => new Map(this.outputFormatUsage),
      () => ({ ...this.operationSnapshot }),
      this.sessionStartTime
    );

    if (this.isEnabled) {
      this.startFlushTimer();
    }

    void this.setupUserConsent();
  }

  trackEvent(
    name: string,
    properties?: Record<string, unknown>,
    measurements?: Record<string, number>
  ): void {
    if (!this.isTelemetryEnabled()) {
      return;
    }

    const sanitizedProps = this.privacyManager.sanitizeProperties(properties ?? {});
    const sanitizedMeasurements: Record<string, number> = {};
    if (measurements) {
      Object.entries(measurements).forEach(([key, value]) => {
        if (Number.isFinite(value)) {
          sanitizedMeasurements[key] = value;
        }
      });
    }

    const event: TelemetryEvent = {
      name,
      properties: sanitizedProps,
      measurements: sanitizedMeasurements,
      timestamp: new Date(),
      sessionId: this.sessionId,
      userId: this.userId
    };

    const validation = this.validator.validateEvent(event);
    if (!validation.isValid) {
      this.logger.warn("telemetry.event.rejected", { name, issues: validation.issues });
      return;
    }

    this.appendEvent(event);
  }

  trackOperation(
    operationName: string,
    duration: number,
    success: boolean,
    metadata?: Record<string, unknown>
  ): void {
    if (!this.isTelemetryEnabled()) {
      return;
    }

    const sanitizedMetadata = this.privacyManager.sanitizeProperties(metadata ?? {});
    this.trackEvent(
      `operation.${operationName}`,
      {
        outcome: success ? "success" : "failure",
        ...sanitizedMetadata
      },
      {
        duration
      }
    );

    this.operationSnapshot.totalOperations += 1;
    this.operationSnapshot.totalDuration += duration;
    if (success) {
      this.operationSnapshot.successfulOperations += 1;
    } else {
      this.operationSnapshot.failedOperations += 1;
    }
    this.operationSnapshot.durations.push(duration);

    const existing = this.operationSnapshot.operationsByName.get(operationName) ?? { count: 0, totalDuration: 0 };
    existing.count += 1;
    existing.totalDuration += duration;
    this.operationSnapshot.operationsByName.set(operationName, existing);
  }

  trackFeatureUsage(featureName: string, context?: Record<string, unknown>): void {
    if (!this.isTelemetryEnabled()) {
      return;
    }

    const current = this.featureUsage.get(featureName) ?? 0;
    this.featureUsage.set(featureName, current + 1);

    const sanitized = this.privacyManager.sanitizeProperties(context ?? {});
    this.trackEvent(`feature.${featureName}`, sanitized);
  }

  trackPerformanceMetric(metricName: string, value: number, unit: string): void {
    if (!this.isTelemetryEnabled()) {
      return;
    }

    this.trackEvent(
      `performance.${metricName}`,
      {
        unit
      },
      {
        value
      }
    );
  }

  recordOutputFormatUsage(format: string): void {
    if (!this.isTelemetryEnabled()) {
      return;
    }

    const normalized = format.toLowerCase();
    const current = this.outputFormatUsage.get(normalized) ?? 0;
    this.outputFormatUsage.set(normalized, current + 1);

    this.trackEvent("output.format", { format: normalized });
  }

  trackError(error: Error, context: ErrorContext, recovered: boolean): void {
    if (!this.isTelemetryEnabled()) {
      return;
    }

    const sanitized = this.privacyManager.sanitizeProperties({
      component: context.component,
      operation: context.operation,
      recoverable: context.recoverable ?? false,
      retryable: context.retryable ?? false,
      recovered
    });

    this.trackEvent(
      "error",
      {
        ...sanitized,
        userFacing: context.userFacing ?? false
      },
      {
        recovered: recovered ? 1 : 0
      }
    );

    this.operationSnapshot.failedOperations += 1;
  }

  setTelemetryEnabled(enabled: boolean): void {
    this.config.enabled = enabled;
    this.isEnabled = this.shouldEnableTelemetry(enabled);

    void this.configService.updateGlobalValue(TELEMETRY_ENABLED_OVERRIDE_KEY, enabled).catch((error) => {
      this.logger.warn("telemetry.config.updateFailed", { message: (error as Error).message });
    });

    if (this.isEnabled) {
      this.startFlushTimer();
    } else {
      this.stopFlushTimer();
      this.eventBuffer.length = 0;
    }
  }

  isTelemetryEnabled(): boolean {
    return this.isEnabled;
  }

  async exportUserData(): Promise<AggregatedMetrics> {
    const metrics = await this.metricsCollector.collectAggregatedMetrics(await this.storage.loadEvents());
    return metrics;
  }

  async deleteUserData(): Promise<void> {
    await this.storage.clearEvents();
    this.featureUsage.clear();
    this.outputFormatUsage.clear();
    this.operationSnapshot = {
      totalOperations: 0,
      totalDuration: 0,
      successfulOperations: 0,
      failedOperations: 0,
      durations: [],
      operationsByName: new Map()
    };
    this.eventBuffer.length = 0;
  }

  dispose(): void {
    this.stopFlushTimer();
  }

  private appendEvent(event: TelemetryEvent): void {
    if (this.eventBuffer.length >= this.config.maxEventsPerSession) {
      this.eventBuffer.shift();
    }

    this.eventBuffer.push(event);

    if (this.eventBuffer.length >= Math.max(1, this.config.maxEventsPerSession / 2)) {
      void this.flushBufferedEvents();
    }
  }

  private async flushBufferedEvents(): Promise<void> {
    if (!this.isTelemetryEnabled() || this.eventBuffer.length === 0) {
      return;
    }

    const now = Date.now();
    const freshEvents = this.eventBuffer.filter((event) => now - event.timestamp.getTime() <= this.config.maxEventAge);

    if (freshEvents.length === 0) {
      this.eventBuffer.length = 0;
      return;
    }

    try {
      await this.storage.storeEvents(freshEvents);
      this.eventBuffer.length = 0;
      if (this.config.endpoint) {
        await this.postEventsToEndpoint(freshEvents);
      }
    } catch (error) {
      this.logger.warn("telemetry.flush.failed", { message: (error as Error).message });
    }
  }

  private async postEventsToEndpoint(events: TelemetryEvent[]): Promise<void> {
    if (!this.config.endpoint || typeof fetch !== "function") {
      return;
    }

    try {
      const payload = {
        sessionId: this.sessionId,
        userId: this.userId,
        events: events.map((event) => ({
          ...event,
          timestamp: event.timestamp.toISOString()
        }))
      };

  const url = new URL(this.config.endpoint);
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        this.logger.warn("telemetry.endpoint.failed", { status: response.status, statusText: response.statusText });
      }
    } catch (error) {
      this.logger.warn("telemetry.endpoint.error", { message: (error as Error).message });
    }
  }

  private startFlushTimer(): void {
    if (this.flushTimer !== null || this.config.collectionInterval <= 0) {
      return;
    }

    this.flushTimer = setInterval(() => {
      void this.flushBufferedEvents();
    }, this.config.collectionInterval);

    if (typeof this.flushTimer.unref === "function") {
      this.flushTimer.unref();
    }
  }

  private stopFlushTimer(): void {
    if (this.flushTimer === null) {
      return;
    }

    clearInterval(this.flushTimer);
    this.flushTimer = null;
  }

  private loadTelemetryConfiguration(): TelemetryConfiguration {
    const config = vscode.workspace.getConfiguration("codeIngest.telemetry");

    const endpoint = config.get<string | null>("endpoint", null);

    const merged: TelemetryConfiguration = {
      enabled: config.get<boolean>("enabled", DEFAULT_CONFIG.enabled),
      enabledInDevelopment: config.get<boolean>("enabledInDevelopment", DEFAULT_CONFIG.enabledInDevelopment),
      enabledInTests: config.get<boolean>("enabledInTests", DEFAULT_CONFIG.enabledInTests),
      collectionInterval: config.get<number>("collectionInterval", DEFAULT_CONFIG.collectionInterval),
      maxEventsPerSession: config.get<number>("maxEventsPerSession", DEFAULT_CONFIG.maxEventsPerSession),
      maxEventAge: config.get<number>("maxEventAge", DEFAULT_CONFIG.maxEventAge)
    };

    if (endpoint && endpoint.trim().length > 0) {
      merged.endpoint = endpoint;
    }

    const override = this.configService.getGlobalValue<boolean>(TELEMETRY_ENABLED_OVERRIDE_KEY);
    if (typeof override === "boolean") {
      merged.enabled = override;
    }

    return merged;
  }

  private shouldEnableTelemetry(explicit?: boolean): boolean {
    const effectiveEnabled = typeof explicit === "boolean" ? explicit : this.config.enabled;
    if (!effectiveEnabled) {
      return false;
    }

    const isTestEnv = process.env.NODE_ENV === "test" || vscode.env.sessionId === "someValue.sessionId";
    if (isTestEnv && !this.config.enabledInTests) {
      return false;
    }

    const isDevEnv = this.detectDevelopmentEnvironment();
    if (isDevEnv && !this.config.enabledInDevelopment) {
      return false;
    }

    return true;
  }

  private detectDevelopmentEnvironment(): boolean {
    if (process.env.NODE_ENV === "development" || process.env.CODE_INGEST_DEV === "1") {
      return true;
    }

    const extension =
      vscode.extensions.getExtension("code-ingest.code-ingest") ??
      vscode.extensions.getExtension("mrzeeshanahmed.code-ingest") ??
      vscode.extensions.getExtension("publisher.code-ingest");

    if (!extension) {
      return false;
    }

    return /out|dist/.test(extension.extensionPath ?? "");
  }

  private generateSessionId(): string {
    return `telemetry-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  private async setupUserConsent(): Promise<void> {
    if (!this.config.enabled) {
      return;
    }

    try {
      const consented = await this.consentManager.checkAndRequestConsent();
      if (!consented) {
        this.isEnabled = false;
        this.stopFlushTimer();
      } else if (this.flushTimer === null) {
        this.startFlushTimer();
      }
    } catch (error) {
      this.logger.warn("telemetry.consent.failed", { message: (error as Error).message });
    }
  }
}

class PrivacyManager {
  private readonly sensitiveDataPatterns = [
    /[a-zA-Z0-9.%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    /\b[A-Za-z0-9]{20,}\b/g,
    /password|secret|key|token/i
  ];

  sanitizeProperties(properties: Record<string, unknown>): Record<string, string | number | boolean> {
    const sanitized: Record<string, string | number | boolean> = {};

    Object.entries(properties).forEach(([key, value]) => {
      if (this.isSensitiveKey(key)) {
        sanitized[key] = "[REDACTED]";
        return;
      }

      if (typeof value === "string") {
        sanitized[key] = this.sanitizeString(value);
        return;
      }

      if (typeof value === "number" || typeof value === "boolean") {
        sanitized[key] = value;
        return;
      }

      sanitized[key] = "[OBJECT]";
    });

    return sanitized;
  }

  generateStableUserId(): string {
    const machineInfo = [
      os.platform(),
      os.arch(),
      process.version,
      vscode.env.machineId
    ].join("|");

    return crypto.createHash("sha256").update(`${machineInfo}|code-ingest-salt`).digest("hex").substring(0, 16);
  }

  private isSensitiveKey(key: string): boolean {
    const sensitiveKeys = [
      "path",
      "filepath",
      "url",
      "username",
      "email",
      "password",
      "token",
      "key",
      "secret",
      "credential"
    ];

    return sensitiveKeys.some((sensitive) => key.toLowerCase().includes(sensitive));
  }

  private sanitizeString(value: string): string {
    let sanitized = value;
    this.sensitiveDataPatterns.forEach((pattern) => {
      sanitized = sanitized.replace(pattern, "[REDACTED]");
    });

    if (sanitized.length > 100) {
      sanitized = `${sanitized.substring(0, 100)}...`;
    }

    return sanitized;
  }
}

class AggregatedMetricsCollector {
  constructor(
    private readonly performanceMonitor: PerformanceMonitor,
    private readonly errorReporter: ErrorReporter,
    private readonly featureUsageAccessor: () => Map<string, number>,
    private readonly formatUsageAccessor: () => Map<string, number>,
    private readonly operationSnapshotAccessor: () => TelemetryOperationSnapshot,
    private readonly sessionStartTime: number
  ) {}

  async collectAggregatedMetrics(storedEvents: TelemetryEvent[]): Promise<AggregatedMetrics> {
  this.collectSessionMetrics();
  const performanceMetrics = this.collectPerformanceMetrics();
    const usageMetrics = this.collectUsageMetrics();
    const errorMetrics = this.collectErrorMetrics();
    const uniqueSessions = new Set(storedEvents.map((event) => event.sessionId));

    const totalOperations = performanceMetrics.totalOperations || usageMetrics.remoteRepoUsage || storedEvents.length;
    const averageOperationDuration = performanceMetrics.averageOperationTime;
    const errorRate = totalOperations === 0 ? 0 : errorMetrics.totalErrors / totalOperations;

    const aggregated: AggregatedMetrics = {
      sessionCount: Math.max(uniqueSessions.size, 1),
      totalOperations,
      averageOperationDuration,
      errorRate,
      featureUsage: usageMetrics.featuresUsed,
      performanceProfile: {
        totalOperations: performanceMetrics.totalOperations,
        averageOperationDuration: performanceMetrics.averageOperationTime,
        slowestOperation: performanceMetrics.slowestOperation,
        memoryUsageAverage: performanceMetrics.memoryUsageAverage,
        operationDistribution: performanceMetrics.operationDistribution,
        performanceGrade: performanceMetrics.performanceGrade
      }
    };

    return aggregated;
  }

  collectSessionMetrics(): SessionMetrics {
    const duration = Date.now() - this.sessionStartTime;
    const extension = this.getExtension();
    return {
      sessionDuration: duration,
      extensionVersion: extension?.packageJSON.version ?? "unknown",
      vscodeVersion: vscode.version,
      platform: os.platform(),
      nodeVersion: process.version,
      totalMemoryGB: Math.round(os.totalmem() / 1024 ** 3),
      cpuCores: os.cpus().length
    };
  }

  collectPerformanceMetrics(): PerformanceAggregation {
    const metrics = this.performanceMonitor.getMetricsHistory();
    const snapshot = this.operationSnapshotAccessor();
    const operationReport: PerformanceReport = this.performanceMonitor.generateReport();

    const totalOperations = metrics.length;
    const averageOperationTime = totalOperations === 0 ? 0 : snapshot.totalDuration / totalOperations;
    const slowestOperation = operationReport.overall.slowestOperation.operationType ?? "unknown";
    const memoryUsageAverage = metrics.length === 0
      ? 0
      : metrics.reduce((sum, metric) => sum + metric.memoryUsage.peak.heapUsed, 0) / metrics.length;

    const distribution: Record<string, number> = {};
    snapshot.operationsByName.forEach((value, key) => {
      distribution[key] = value.count;
    });

    const performanceGrade = this.calculatePerformanceGrade(metrics, snapshot);

    return {
      totalOperations,
      averageOperationTime,
      slowestOperation,
      memoryUsageAverage,
      operationDistribution: distribution,
      performanceGrade
    };
  }

  collectUsageMetrics(): UsageMetrics {
    const features = this.featureUsageAccessor();
    const formats = this.formatUsageAccessor();

    const aggregateFeatureUsage: Record<string, number> = {};
    features.forEach((value, key) => {
      aggregateFeatureUsage[key] = value;
    });

    const outputFormats: Record<string, number> = {};
    formats.forEach((value, key) => {
      outputFormats[key] = value;
    });

    return {
      featuresUsed: aggregateFeatureUsage,
      outputFormatsUsed: outputFormats,
      averageFileCount: 0,
      remoteRepoUsage: aggregateFeatureUsage["remote-ingestion"] ?? 0,
      configurationComplexity: Object.keys(aggregateFeatureUsage).length
    };
  }

  collectErrorMetrics(): ErrorMetrics {
    const errors = this.errorReporter.getErrorBuffer();

    const errorsByCategory = errors.reduce<Record<string, number>>((accumulator, report) => {
      const category = this.getErrorCategory(report.context.classification);
      accumulator[category] = (accumulator[category] ?? 0) + 1;
      return accumulator;
    }, {});

    const recovered = errors.filter((report) => report.context.recoverable ?? false).length;
    const criticalErrorCount = errors.filter((report) => report.classification.severity === ErrorSeverity.CRITICAL).length;

    return {
      totalErrors: errors.length,
      errorsByCategory,
      recoveryRate: errors.length === 0 ? 0 : recovered / errors.length,
      criticalErrorCount
    };
  }

  private calculatePerformanceGrade(
    metrics: OperationMetrics[],
    snapshot: TelemetryOperationSnapshot
  ): PerformanceProfile["performanceGrade"] {
    if (metrics.length === 0) {
      return "excellent";
    }

    const avgDuration = snapshot.totalDuration / Math.max(metrics.length, 1);
    if (avgDuration < 500) {
      return "excellent";
    }

    if (avgDuration < 1_000) {
      return "good";
    }

    if (avgDuration < 2_000) {
      return "fair";
    }

    return "poor";
  }

  private getExtension() {
    return (
      vscode.extensions.getExtension("code-ingest.code-ingest") ??
      vscode.extensions.getExtension("mrzeeshanahmed.code-ingest") ??
      vscode.extensions.getExtension("publisher.code-ingest") ??
      undefined
    );
  }

  private getErrorCategory(classification: ErrorClassification): string {
    return classification.category ?? "unknown";
  }
}

class TelemetryConsentManager {
  private readonly CONSENT_KEY = "codeIngest.telemetryConsent";
  private readonly SHOWN_CONSENT_KEY = "codeIngest.telemetryConsentShown";

  constructor(private readonly configService: ConfigurationService) {}

  async checkAndRequestConsent(): Promise<boolean> {
    const stored = this.getStoredConsent();
    if (stored !== null) {
      return stored;
    }

    if (this.hasShownConsentBefore()) {
      return false;
    }

    return this.showConsentDialog();
  }

  private async showConsentDialog(): Promise<boolean> {
    const message = [
      "Code Ingest would like to collect anonymous usage analytics to improve the extension.",
      "",
      "What we collect:",
      "- Performance metrics (operation times, memory usage)",
      "- Feature usage statistics (which features are used)",
      "- Error rates and recovery information",
      "- System information (VS Code version, platform)",
      "",
      "What we DON'T collect:",
      "- File contents or code",
      "- File paths or names",
      "- Personal information",
      "- Repository URLs or names",
      "",
      "You can change this setting anytime in VS Code preferences."
    ].join("\n");

    const choice = await vscode.window.showInformationMessage(
      "Help improve Code Ingest",
      {
        modal: true,
        detail: message
      },
      "Allow Analytics",
      "No Thanks",
      "Learn More"
    );

    this.markConsentShown();

    if (choice === "Learn More") {
      void vscode.env.openExternal(vscode.Uri.parse("https://github.com/your-org/code-ingest/blob/main/PRIVACY.md"));
      return false;
    }

    const consented = choice === "Allow Analytics";
    await this.storeConsent(consented);
    return consented;
  }

  private getStoredConsent(): boolean | null {
    const stored = this.configService.getGlobalValue<boolean>(this.CONSENT_KEY);
    if (typeof stored === "boolean") {
      return stored;
    }
    return null;
  }

  private async storeConsent(consented: boolean): Promise<void> {
    await this.configService.updateGlobalValue(this.CONSENT_KEY, consented);
  }

  private hasShownConsentBefore(): boolean {
    return Boolean(this.configService.getGlobalValue<boolean>(this.SHOWN_CONSENT_KEY));
  }

  private markConsentShown(): void {
    void this.configService.updateGlobalValue(this.SHOWN_CONSENT_KEY, true);
  }
}

class TelemetryStorage {
  private readonly STORAGE_KEY = TELEMETRY_STORAGE_KEY;
  private readonly MAX_STORED_EVENTS = 1_000;

  constructor(private readonly configService: ConfigurationService) {}

  async storeEvents(events: TelemetryEvent[]): Promise<void> {
    const existingEvents = await this.loadEvents();
    const allEvents = [...existingEvents, ...events];

    const sorted = allEvents
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
      .slice(0, this.MAX_STORED_EVENTS)
      .map((event) => ({
        ...event,
        timestamp: new Date(event.timestamp)
      }));

    await this.configService.updateGlobalValue(this.STORAGE_KEY, JSON.stringify(sorted));
  }

  async loadEvents(): Promise<TelemetryEvent[]> {
    const stored = this.configService.getGlobalValue<string>(this.STORAGE_KEY);
    if (!stored) {
      return [];
    }

    try {
      const parsed = JSON.parse(stored) as Array<Omit<TelemetryEvent, "timestamp"> & { timestamp: string | number | Date }>;
      return parsed.map((event) => ({
        ...event,
        timestamp: new Date(event.timestamp)
      }));
    } catch {
      return [];
    }
  }

  async clearEvents(): Promise<void> {
    await this.configService.updateGlobalValue(this.STORAGE_KEY, null);
  }

  async getStorageSize(): Promise<number> {
    const events = await this.loadEvents();
    return JSON.stringify(events).length;
  }
}

class TelemetryValidator {
  validateEvent(event: TelemetryEvent): ValidationResult {
    const issues: string[] = [];

    if (!event.name || typeof event.name !== "string") {
      issues.push("Event name is required and must be a string");
    }

    if (!event.sessionId || typeof event.sessionId !== "string") {
      issues.push("Session ID is required");
    }

    const serialized = JSON.stringify({
      ...event,
      timestamp: event.timestamp.toISOString()
    });

    if (this.containsSensitiveData(serialized)) {
      issues.push("Event contains potentially sensitive data");
    }

    if (serialized.length > 10_000) {
      issues.push("Event exceeds maximum size limit");
    }

    return {
      isValid: issues.length === 0,
      issues
    };
  }

  private containsSensitiveData(data: string): boolean {
    const sensitivePatterns = [
      /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/,
      /\/Users\/[^/]+/,
      /\/home\/[^/]+/,
      /[A-Za-z0-9]{20,}/
    ];

    return sensitivePatterns.some((pattern) => pattern.test(data));
  }
}
