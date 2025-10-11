import * as crypto from "node:crypto";
import type { AggregatedMetrics, TelemetryEvent } from "../telemetryService";

const SENSITIVE_KEYS = new Set([
  "password",
  "secret",
  "token",
  "key",
  "credential",
  "email",
  "username",
  "path",
  "uri",
  "url"
]);

const SENSITIVE_VALUE_HINTS = [
  "password",
  "secret",
  "token",
  "key",
  "credential",
  "bearer",
  "authorization"
];

export class PrivacyManager {
  private readonly sensitivePatterns: RegExp[] = [
    /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    /\b[A-Za-z0-9]{20,}\b/g,
    /password|secret|key|token/gi,
    /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
    /[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}/g
  ];

  sanitizeEventData(event: TelemetryEvent): TelemetryEvent {
    const sanitizedProperties = this.sanitizeRecord(event.properties);
    const sanitizedMeasurements = this.sanitizeMeasurements(event.measurements);

    return {
      ...event,
      properties: sanitizedProperties,
      measurements: sanitizedMeasurements,
      timestamp: new Date(event.timestamp.getTime())
    };
  }

  generateAnonymousUserId(): string {
    const randomBytes = crypto.randomBytes(32);
    return crypto.createHash("sha256").update(randomBytes).digest("hex").slice(0, 32);
  }

  isDataSensitive(key: string, value: unknown): boolean {
    const lowerKey = key.toLowerCase();
    if (SENSITIVE_KEYS.has(lowerKey) || SENSITIVE_VALUE_HINTS.some((hint) => lowerKey.includes(hint))) {
      return true;
    }

    if (typeof value === "string") {
      return this.sensitivePatterns.some((pattern) => pattern.test(value));
    }

    if (typeof value === "object" && value !== null) {
      return Object.entries(value as Record<string, unknown>).some(([innerKey, innerValue]) =>
        this.isDataSensitive(innerKey, innerValue)
      );
    }

    return false;
  }

  redactSensitiveInformation(text: string): string {
    let redacted = text;
    for (const pattern of this.sensitivePatterns) {
      redacted = redacted.replace(pattern, "[REDACTED]");
    }
    return redacted;
  }

  aggregateMetrics(events: TelemetryEvent[]): AggregatedMetrics {
    const uniqueSessions = new Set<string>();
    const operationCounts: Record<string, number> = {};
    const featureUsageFrequency: Record<string, number> = {};
    const fileCountPerSession = new Map<string, number>();

    let totalOperationDuration = 0;
    let operationDurationSamples = 0;
    let errorCount = 0;
    let largestFileProcessed = 0;
    const memorySamples: number[] = [];
    const cpuSamples: number[] = [];

    for (const event of events) {
      uniqueSessions.add(event.sessionId);

      if (event.name.startsWith("operation.")) {
        const operationName = event.name.replace(/^operation\./u, "");
        operationCounts[operationName] = (operationCounts[operationName] ?? 0) + 1;
        const duration = event.measurements.duration ?? 0;
        if (Number.isFinite(duration) && duration > 0) {
          totalOperationDuration += duration;
          operationDurationSamples += 1;
        }
      }

      if (event.name.startsWith("error")) {
        errorCount += 1;
      }

      if (event.name.startsWith("feature.")) {
        const featureName = event.name.replace(/^feature\./u, "");
        featureUsageFrequency[featureName] = (featureUsageFrequency[featureName] ?? 0) + 1;
      }

      if (event.name === "pipeline.fileProcessed") {
        const currentCount = fileCountPerSession.get(event.sessionId) ?? 0;
        fileCountPerSession.set(event.sessionId, currentCount + 1);
      }

      if (typeof event.measurements.fileSizeBytes === "number") {
        largestFileProcessed = Math.max(largestFileProcessed, event.measurements.fileSizeBytes);
      }

      if (typeof event.measurements.memoryUsageMB === "number") {
        memorySamples.push(event.measurements.memoryUsageMB);
      }

      if (typeof event.measurements.cpuTimeMs === "number") {
        cpuSamples.push(event.measurements.cpuTimeMs);
      }
    }

    const totalOperations = Object.values(operationCounts).reduce((sum, value) => sum + value, 0);
    const averageOperationDuration = operationDurationSamples === 0
      ? 0
      : totalOperationDuration / operationDurationSamples;
    const errorRate = totalOperations === 0 ? 0 : errorCount / totalOperations;

    const averageMemoryUsage = memorySamples.length === 0
      ? 0
      : memorySamples.reduce((sum, sample) => sum + sample, 0) / memorySamples.length;
    const averageCpuUsage = cpuSamples.length === 0
      ? 0
      : cpuSamples.reduce((sum, sample) => sum + sample, 0) / cpuSamples.length;
    const mostFilesProcessedInSession = Math.max(0, ...fileCountPerSession.values());

    return {
      sessionCount: uniqueSessions.size,
      operationCounts,
      averageOperationDuration,
      errorRate,
      featureUsageFrequency,
      performanceProfile: {
        averageMemoryUsage,
        averageCpuUsage,
        largestFileProcessed,
        mostFilesProcessedInSession
      }
    };
  }

  validateDataPrivacy(event: TelemetryEvent): boolean {
    const serialized = JSON.stringify({
      name: event.name,
      properties: event.properties,
      measurements: event.measurements
    });

    return !this.sensitivePatterns.some((pattern) => pattern.test(serialized));
  }

  private sanitizeRecord(record: Record<string, string | number | boolean>): Record<string, string | number | boolean> {
    const sanitized: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(record)) {
      sanitized[key] = this.sanitizePrimitive(key, value);
    }
    return sanitized;
  }

  private sanitizeMeasurements(measurements: Record<string, number>): Record<string, number> {
    const sanitized: Record<string, number> = {};
    for (const [key, value] of Object.entries(measurements)) {
      if (Number.isFinite(value)) {
        sanitized[key] = value;
      }
    }
    return sanitized;
  }

  private sanitizePrimitive(key: string, value: string | number | boolean): string | number | boolean {
    if (typeof value === "number" || typeof value === "boolean") {
      return value;
    }

    if (this.isDataSensitive(key, value)) {
      return "[REDACTED]";
    }

    const redacted = this.redactSensitiveInformation(value);
    return redacted.length > 120 ? `${redacted.slice(0, 117)}...` : redacted;
  }
}
