import * as crypto from "node:crypto";
import * as vscode from "vscode";

import { ConfigurationService } from "./configurationService";
import { PrivacyManager } from "./telemetry/privacyManager";
import { ConsentManager, type TelemetryConsent } from "./telemetry/consentManager";
import { TelemetryStorage } from "./telemetry/telemetryStorage";

export type TelemetryLevel = "off" | "error" | "usage" | "all";

export interface TelemetryConfiguration {
  enabled: boolean;
  level: TelemetryLevel;
  enabledInDevelopment: boolean;
  collectionInterval: number;
  maxEventsPerSession: number;
  endpoint?: string;
  consentShown: boolean;
  userId: string;
  enabledInTests: boolean;
  maxEventsPerFlush: number;
}

export interface TelemetryEvent {
  name: string;
  properties: Record<string, string | number | boolean>;
  measurements: Record<string, number>;
  timestamp: Date;
  sessionId: string;
  userId: string;
}

export interface AggregatedMetrics {
  sessionCount: number;
  operationCounts: Record<string, number>;
  averageOperationDuration: number;
  errorRate: number;
  featureUsageFrequency: Record<string, number>;
  performanceProfile: {
    averageMemoryUsage: number;
    averageCpuUsage: number;
    largestFileProcessed: number;
    mostFilesProcessedInSession: number;
  };
}

interface PendingTelemetryEvent extends TelemetryEvent {
  classification: "error" | "usage" | "performance";
}

const DEFAULT_CONFIGURATION: TelemetryConfiguration = {
  enabled: false,
  level: "usage",
  enabledInDevelopment: false,
  collectionInterval: 60_000,
  maxEventsPerSession: 500,
  consentShown: false,
  userId: "",
  enabledInTests: false,
  maxEventsPerFlush: 100
};

const USER_ID_STORAGE_KEY = "codeIngest.telemetry.userId";
const LAST_CONSENT_KEY = "codeIngest.telemetry.lastConsent";

export class TelemetryService implements vscode.Disposable {
  private readonly privacyManager = new PrivacyManager();
  private readonly consentManager: ConsentManager;
  private readonly storage: TelemetryStorage;
  private readonly sessionId: string;
  private config: TelemetryConfiguration = { ...DEFAULT_CONFIGURATION };
  private userId = "";
  private enabled = false;
  private initialized = false;
  private flushTimer: NodeJS.Timeout | undefined;
  private readonly eventBuffer: PendingTelemetryEvent[] = [];
  private isFlushing = false;
  private configurationListener: vscode.Disposable | undefined;

  constructor(private readonly configService: ConfigurationService, private readonly context: vscode.ExtensionContext) {
    this.consentManager = new ConsentManager(configService, context);
    this.storage = new TelemetryStorage(context);
    this.sessionId = this.createSessionId();
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    this.config = this.loadConfigurationSnapshot();
    this.userId = await this.resolveUserId();
    this.config.userId = this.userId;

    const consentGranted = await this.ensureConsent();
    this.config.consentShown = consentGranted;
    this.enabled = this.computeTelemetryEnabled(consentGranted);

    this.registerConfigurationListener();
    if (this.enabled) {
      this.startFlushTimer();
    }

    this.initialized = true;
  }

  trackEvent(name: string, properties?: Record<string, unknown>, measurements?: Record<string, number>): void {
    if (!this.initialized || !this.enabled) {
      return;
    }

    const classification = this.classifyEvent(name);
    if (!this.shouldRecord(classification)) {
      return;
    }

    const sanitizedProperties = this.buildPropertySnapshot(properties ?? {});
    const sanitizedMeasurements = this.buildMeasurementSnapshot(measurements ?? {});

    const event: PendingTelemetryEvent = {
      name,
      properties: sanitizedProperties,
      measurements: sanitizedMeasurements,
      timestamp: new Date(),
      sessionId: this.sessionId,
      userId: this.userId,
      classification
    };

    const sanitized = this.privacyManager.sanitizeEventData(event);
    if (!this.privacyManager.validateDataPrivacy(sanitized)) {
      return;
    }

    this.eventBuffer.push({ ...sanitized, classification });
    if (this.eventBuffer.length >= this.config.maxEventsPerFlush || this.eventBuffer.length >= this.config.maxEventsPerSession) {
      void this.flush();
    }
  }

  trackFeatureUsage(featureName: string, context?: Record<string, unknown>): void {
    this.trackEvent(`feature.${featureName}`, {
      ...context,
      feature: featureName
    });
  }

  trackOperationDuration(operationName: string, duration: number, success: boolean): void {
    if (!Number.isFinite(duration) || duration < 0) {
      return;
    }
    this.trackEvent(
      `operation.${operationName}`,
      {
        success
      },
      {
        duration
      }
    );
  }

  trackError(error: Error, context: Record<string, unknown>): void {
    const baseProperties: Record<string, unknown> = {
      name: error.name,
      message: error.message,
      ...context
    };
    this.trackEvent("error.runtime", baseProperties);
  }

  async setTelemetryEnabled(enabled: boolean): Promise<void> {
    this.config.enabled = enabled;
    await this.configService.updateGlobalValue("codeIngest.telemetry.enabled", enabled);
    this.enabled = this.computeTelemetryEnabled(this.config.consentShown);

    if (this.enabled) {
      this.startFlushTimer();
    } else {
      this.stopFlushTimer();
      this.eventBuffer.length = 0;
    }
  }

  async flush(): Promise<void> {
    if (!this.initialized || !this.enabled) {
      this.eventBuffer.length = 0;
      return;
    }

    if (this.isFlushing || this.eventBuffer.length === 0) {
      return;
    }

    this.isFlushing = true;
    try {
      const eventsToFlush = this.eventBuffer.splice(0, this.config.maxEventsPerFlush).map((event) => ({
        name: event.name,
        properties: event.properties,
        measurements: event.measurements,
        timestamp: event.timestamp,
        sessionId: event.sessionId,
        userId: event.userId
      }));

      if (eventsToFlush.length > 0) {
        await this.storage.storeEvents(eventsToFlush);
      }
    } finally {
      this.isFlushing = false;
    }
  }

  async getAggregatedMetrics(): Promise<AggregatedMetrics> {
    await this.flush();
    const storedEvents = await this.storage.loadEvents();
    const pendingEvents = this.eventBuffer.map((event) => ({
      name: event.name,
      properties: event.properties,
      measurements: event.measurements,
      timestamp: event.timestamp,
      sessionId: event.sessionId,
      userId: event.userId
    }));
    return this.privacyManager.aggregateMetrics([...storedEvents, ...pendingEvents]);
  }

  dispose(): void {
    this.stopFlushTimer();
    this.configurationListener?.dispose();
    void this.flush();
  }

  private loadConfigurationSnapshot(): TelemetryConfiguration {
    const configuration = vscode.workspace.getConfiguration("codeIngest.telemetry");
    const enabled = configuration.get<boolean>("enabled", DEFAULT_CONFIGURATION.enabled);
    const level = configuration.get<TelemetryLevel>("level", DEFAULT_CONFIGURATION.level);
    const enabledInDevelopment = configuration.get<boolean>("enabledInDevelopment", DEFAULT_CONFIGURATION.enabledInDevelopment);
    const collectionInterval = configuration.get<number>("collectionInterval", DEFAULT_CONFIGURATION.collectionInterval);
    const maxEventsPerSession = configuration.get<number>("maxEventsPerSession", DEFAULT_CONFIGURATION.maxEventsPerSession);
    const maxEventsPerFlush = configuration.get<number>("maxEventsPerFlush", DEFAULT_CONFIGURATION.maxEventsPerFlush);
    const endpoint = configuration.get<string | undefined>("endpoint", DEFAULT_CONFIGURATION.endpoint);
    const enabledInTests = configuration.get<boolean>("enabledInTests", DEFAULT_CONFIGURATION.enabledInTests);

    const snapshot: TelemetryConfiguration = {
      enabled,
      level,
      enabledInDevelopment,
      collectionInterval: Math.max(15_000, collectionInterval),
      maxEventsPerSession: Math.max(10, maxEventsPerSession),
      consentShown: false,
      userId: "",
      enabledInTests,
      maxEventsPerFlush: Math.max(10, Math.min(maxEventsPerFlush, Math.max(10, maxEventsPerSession)))
    };

    const trimmedEndpoint = endpoint?.trim();
    if (trimmedEndpoint) {
      snapshot.endpoint = trimmedEndpoint;
    }

    return snapshot;
  }

  private async resolveUserId(): Promise<string> {
    const existing = this.context.globalState.get<string>(USER_ID_STORAGE_KEY);
    if (existing && existing.length >= 8) {
      return existing;
    }

    const generated = this.privacyManager.generateAnonymousUserId();
    await this.context.globalState.update(USER_ID_STORAGE_KEY, generated);
    return generated;
  }

  private async ensureConsent(): Promise<boolean> {
    const storedConsent = this.context.globalState.get<string>(LAST_CONSENT_KEY);
    if (storedConsent) {
      try {
        const parsed = JSON.parse(storedConsent) as TelemetryConsent & { timestamp: string };
        if (parsed.version === "1.0") {
          return parsed.granted;
        }
      } catch {
        // Ignore corrupted consent payloads and request consent again.
      }
    }

    const granted = await this.consentManager.checkAndRequestConsent();
    const consentSnapshot: TelemetryConsent = {
      granted,
      version: "1.0",
      timestamp: new Date(),
      level: granted ? this.config.level : "off"
    };
    await this.context.globalState.update(LAST_CONSENT_KEY, JSON.stringify(consentSnapshot));
    return granted;
  }

  private computeTelemetryEnabled(consentGranted: boolean): boolean {
    if (!consentGranted) {
      return false;
    }

    if (!this.config.enabled || this.config.level === "off") {
      return false;
    }

    const isDevelopment = this.context.extensionMode === vscode.ExtensionMode.Development;
    if (isDevelopment && !this.config.enabledInDevelopment) {
      return false;
    }

    const isTestEnvironment = process.env.NODE_ENV === "test";
    if (isTestEnvironment && !this.config.enabledInTests) {
      return false;
    }

    return true;
  }

  private registerConfigurationListener(): void {
    this.configurationListener?.dispose();
    this.configurationListener = vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration("codeIngest.telemetry")) {
        return;
      }

      this.config = this.loadConfigurationSnapshot();
      this.config.userId = this.userId;
      const consentGranted = this.config.consentShown || this.enabled;
      this.config.consentShown = consentGranted;
      this.enabled = this.computeTelemetryEnabled(consentGranted);

      if (this.enabled) {
        this.startFlushTimer();
      } else {
        this.stopFlushTimer();
      }
    });

    if (this.configurationListener) {
      this.context.subscriptions.push(this.configurationListener);
    }
  }

  private buildPropertySnapshot(properties: Record<string, unknown>): Record<string, string | number | boolean> {
    const sanitized: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(properties)) {
      if (value === undefined || value === null) {
        continue;
      }

      if (typeof value === "number" && Number.isFinite(value)) {
        sanitized[key] = value;
        continue;
      }

      if (typeof value === "boolean") {
        sanitized[key] = value;
        continue;
      }

      if (typeof value === "string") {
        sanitized[key] = value;
        continue;
      }

      sanitized[key] = Array.isArray(value) ? value.length : 1;
    }
    return sanitized;
  }

  private buildMeasurementSnapshot(measurements: Record<string, number>): Record<string, number> {
    const sanitized: Record<string, number> = {};
    for (const [key, value] of Object.entries(measurements)) {
      if (Number.isFinite(value)) {
        sanitized[key] = value;
      }
    }
    return sanitized;
  }

  private classifyEvent(name: string): "error" | "usage" | "performance" {
    if (name.startsWith("error")) {
      return "error";
    }

    if (name.startsWith("performance")) {
      return "performance";
    }

    return "usage";
  }

  private shouldRecord(classification: "error" | "usage" | "performance"): boolean {
    switch (this.config.level) {
      case "off":
        return false;
      case "error":
        return classification === "error";
      case "usage":
        return classification === "error" || classification === "usage";
      case "all":
        return true;
      default:
        return false;
    }
  }

  private startFlushTimer(): void {
    if (this.flushTimer || this.config.collectionInterval <= 0) {
      return;
    }

    this.flushTimer = setInterval(() => {
      void this.flush();
    }, this.config.collectionInterval);

    if (typeof this.flushTimer.unref === "function") {
      this.flushTimer.unref();
    }
  }

  private stopFlushTimer(): void {
    if (!this.flushTimer) {
      return;
    }

    clearInterval(this.flushTimer);
    this.flushTimer = undefined;
  }

  private createSessionId(): string {
    const random = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return `session-${random}`;
  }
}
