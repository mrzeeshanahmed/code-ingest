import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import * as vscode from "vscode";

import { TelemetryService, type TelemetryEvent } from "../services/telemetryService";
import { ConfigurationService } from "../services/configurationService";

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
  let telemetry: TelemetryService;
  let context: vscode.ExtensionContext;
  let state: Map<string, unknown>;

  const telemetryConfigValues: Record<string, unknown> = {
  enabled: true,
  level: "all",
    enabledInDevelopment: true,
    enabledInTests: true,
    collectionInterval: 0,
    maxEventsPerSession: 25,
    maxEventsPerFlush: 25,
    endpoint: undefined
  };

  const createExtensionContext = () => {
    const internalState = new Map<string, unknown>();

    const globalState = {
      get: jest.fn(<T>(key: string, defaultValue?: T) => {
        return (internalState.has(key) ? (internalState.get(key) as T) : defaultValue) as T | undefined;
      }),
      update: jest.fn(async (key: string, value: unknown) => {
        if (value === undefined) {
          internalState.delete(key);
        } else {
          internalState.set(key, value);
        }
      })
    };

    const extensionContext = {
      globalState: globalState as unknown,
      subscriptions: [] as vscode.Disposable[],
      extensionMode: vscode.ExtensionMode.Production
    } as unknown as vscode.ExtensionContext;

    return { context: extensionContext, state: internalState, globalState };
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

    const contextResult = createExtensionContext();
    context = contextResult.context;
    state = contextResult.state;

    const consentSnapshot = {
      granted: true,
      version: "1.0",
      timestamp: new Date().toISOString(),
      level: "usage"
    };
    state.set("codeIngest.telemetry.userId", "user-12345");
    state.set("codeIngest.telemetry.lastConsent", JSON.stringify(consentSnapshot));

    configService = new InMemoryConfigurationService();
    telemetry = new TelemetryService(configService, context);
    await telemetry.initialize();
  });

  afterEach(() => {
    telemetry.dispose();
  });

  test("sanitizes sensitive strings before storing events", async () => {
    telemetry.trackEvent("test", {
      email: "user@example.com",
      path: "/Users/test/file.ts",
      note: "a".repeat(150)
    });

    await telemetry.flush();

    const events = await (telemetry as unknown as { storage: { loadEvents: () => Promise<TelemetryEvent[]> } }).storage.loadEvents();
    expect(events).toHaveLength(1);
    expect(events[0].properties.email).toBe("[REDACTED]");
    expect(events[0].properties.path).toBe("[REDACTED]");
    const noteValue = events[0].properties.note as string;
    expect(noteValue.length).toBeLessThanOrEqual(103);
  });

  test("aggregates usage, performance and error metrics", async () => {
    telemetry.trackFeatureUsage("digest-generation", { filePath: "/Users/me/file" });
    telemetry.trackOperationDuration("digest", 1_200, true);
    telemetry.trackOperationDuration("digest", 800, false);
    telemetry.trackError(new Error("boom"), { component: "test", operation: "digest" });
    telemetry.trackEvent("pipeline.fileProcessed", { filePath: "/repo/file.ts" }, {});
    telemetry.trackEvent("performance.snapshot", {}, { memoryUsageMB: 128, cpuTimeMs: 45, fileSizeBytes: 4096 });

    const aggregated = await telemetry.getAggregatedMetrics();

    expect(aggregated.sessionCount).toBe(1);
    expect(aggregated.operationCounts.digest).toBe(2);
    expect(aggregated.averageOperationDuration).toBeGreaterThan(0);
    expect(aggregated.errorRate).toBeGreaterThan(0);
    expect(aggregated.featureUsageFrequency["digest-generation"]).toBe(1);
    expect(aggregated.performanceProfile.averageMemoryUsage).toBeGreaterThan(0);
    expect(aggregated.performanceProfile.mostFilesProcessedInSession).toBe(1);
  });

  test("disabling telemetry stops event collection", async () => {
    await telemetry.setTelemetryEnabled(false);
    telemetry.trackEvent("disabled", { foo: "bar" });

    await telemetry.flush();

    const events = await (telemetry as unknown as { storage: { loadEvents: () => Promise<TelemetryEvent[]> } }).storage.loadEvents();
    expect(events).toHaveLength(0);
  });
});
