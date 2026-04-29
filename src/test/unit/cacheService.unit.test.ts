import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import * as vscode from "vscode";

import type { ProcessedContent } from "../../services/contentProcessor";
import { CacheService, type CacheStats } from "../../services/cacheService";
import type { DigestResult } from "../../services/digestGenerator";
import type { TokenAnalysis } from "../../services/tokenAnalyzer";
import { setWorkspaceFolder } from "./testUtils";

type VSCodeMock = typeof vscode & {
  __reset(): void;
  workspace: typeof vscode.workspace & {
    getConfiguration: jest.Mock;
  };
};

describe("CacheService", () => {
  const vsMock = vscode as unknown as VSCodeMock;
  const mockConfiguration = {
    get: jest.fn((key: string, fallback?: unknown) => {
      switch (key) {
        case "cache.enabled":
          return true;
        case "cache.persistToDisk":
          return true;
        case "cache.compressionLevel":
          return 3;
        default:
          return fallback;
      }
    })
  };

  beforeEach(() => {
    vsMock.__reset();
    setWorkspaceFolder(path.join(os.tmpdir(), `cache-service-${Date.now()}`));
    vsMock.workspace.getConfiguration.mockReturnValue(mockConfiguration);
    mockConfiguration.get.mockClear();
  });

  afterEach(async () => {
    jest.useRealTimers();
  });

  it("stores and retrieves values within TTL", async () => {
    const service = new CacheService(
      { cleanupIntervalMs: 0, defaultOptions: { ttl: 10, persistToDisk: false } },
      { workspace: vsMock.workspace }
    );

    const payload = { answer: 42 };
    await service.set("alpha", payload);

    const fetched = await service.get<typeof payload>("alpha");
    expect(fetched).toEqual(payload);

    const stats = service.stats() as CacheStats;
    expect(stats.totalEntries).toBe(1);
    expect(stats.hitRate).toBeGreaterThan(0);

    await service.dispose();
  });

  it("evicts least recently used entries when exceeding max entries", async () => {
    const service = new CacheService(
      {
        cleanupIntervalMs: 0,
        defaultOptions: { maxEntries: 2, persistToDisk: false, ttl: 60 }
      },
      { workspace: vsMock.workspace }
    );

    await service.set("one", { value: 1 });
    await service.set("two", { value: 2 });
    await service.get("one");
    await service.set("three", { value: 3 });

    expect(await service.get("two")).toBeNull();
    expect(await service.get("one")).not.toBeNull();
    expect(await service.get("three")).not.toBeNull();

    await service.dispose();
  });

  it("expires entries after TTL elapses", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));

    const service = new CacheService(
      {
        cleanupIntervalMs: 0,
        defaultOptions: { ttl: 1, persistToDisk: false }
      },
      { workspace: vsMock.workspace }
    );

    await service.set("ephemeral", { value: "short-lived" });
    await jest.advanceTimersByTimeAsync(1_100);

    const result = await service.get("ephemeral");
    expect(result).toBeNull();

    await service.dispose();
  });

  it("persists entries to disk and restores on new instance", async () => {
    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "cache-persist-"));

    const first = new CacheService(
      {
        cleanupIntervalMs: 0,
        defaultOptions: { persistToDisk: true, ttl: 60 },
        diskOptions: {
          cacheDirectory: cacheDir,
          enableCompression: true,
          maxDiskSizeMB: 4,
          syncFrequency: "manual"
        }
      },
      { workspace: vsMock.workspace }
    );

    await first.set("persistent", { value: "saved" });
    await first.flushToDisk();
    await first.dispose();

    const second = new CacheService(
      {
        cleanupIntervalMs: 0,
        defaultOptions: { persistToDisk: true, ttl: 60 },
        diskOptions: {
          cacheDirectory: cacheDir,
          enableCompression: true,
          maxDiskSizeMB: 4,
          syncFrequency: "manual"
        }
      },
      { workspace: vsMock.workspace }
    );

    const restored = await second.get<{ value: string }>("persistent");
    expect(restored).toEqual({ value: "saved" });

    await second.clear();
    await second.dispose();
    await fs.rm(cacheDir, { recursive: true, force: true });
  });

  it("handles concurrent reads and writes without race conditions", async () => {
    const service = new CacheService(
      {
        cleanupIntervalMs: 0,
        defaultOptions: { maxEntries: 10, persistToDisk: false }
      },
      { workspace: vsMock.workspace }
    );

    await Promise.all(
      Array.from({ length: 5 }, async (_unused, index) => {
        const key = `key-${index}`;
        await service.set(key, { index });
        const [first, second] = await Promise.all([service.get(key), service.get(key)]);
        expect(first).toEqual({ index });
        expect(second).toEqual({ index });
      })
    );

    await service.dispose();
  });

  it("compresses large payloads above the configured threshold", async () => {
    const service = new CacheService(
      {
        cleanupIntervalMs: 0,
        defaultOptions: { persistToDisk: false, compressionEnabled: true }
      },
      { workspace: vsMock.workspace }
    );

    const largePayload = { blob: "x".repeat(16_384) };
    await service.set("large", largePayload);

    const entries = (service as unknown as { entries: Map<string, { compression: string }> }).entries;
    const entry = entries.get("large");
    expect(entry?.compression).toBe("deflate");

    const restored = await service.get<typeof largePayload>("large");
    expect(restored).toEqual(largePayload);

    await service.dispose();
  });

  it("caches specialized pipeline artifacts", async () => {
    const service = new CacheService({ cleanupIntervalMs: 0 }, { workspace: vsMock.workspace });

    const digest: DigestResult = {
      content: {
        files: [],
        summary: {
          overview: { totalFiles: 1, includedFiles: 1, skippedFiles: 0, binaryFiles: 0, totalTokens: 100 },
          tableOfContents: [],
          notes: []
        },
        metadata: {
          generatedAt: new Date(),
          workspaceRoot: "/workspace",
          totalFiles: 1,
          includedFiles: 1,
          skippedFiles: 0,
          binaryFiles: 0,
          tokenEstimate: 100,
          processingTime: 1,
          redactionApplied: false,
          generatorVersion: "test"
        }
      },
      statistics: { filesProcessed: 1, totalTokens: 100, processingTime: 1, warnings: [], errors: [] },
      redactionApplied: false,
      truncationApplied: false
    };
    await service.cacheDigest("workspace", digest, 30);
    expect(await service.getCachedDigest("workspace")).toEqual(digest);

    const processed: ProcessedContent = {
      content: "content",
      size: 7,
      encoding: "utf8",
      language: "typescript",
      isTruncated: false,
      processingTime: 0.5,
      metadata: { lines: 1, checksum: "abc123", createdAt: new Date().toISOString(), binary: false }
    };
    await service.cacheProcessedContent("file:///tmp/a.ts", processed);
    expect(await service.getCachedProcessedContent("file:///tmp/a.ts")).toEqual(processed);

    const analysis: TokenAnalysis = {
      tokens: 10,
      adapter: "mock",
      cacheHit: false,
      exceededBudget: false,
      warnings: [],
      budget: { limit: 100, warnAt: 80, warnRatio: 0.8 },
      metadata: { source: "unit-test" }
    };
    await service.cacheTokenAnalysis("hash", analysis);
    expect(await service.getCachedTokenAnalysis("hash")).toEqual(analysis);

    await service.dispose();
  });

  it("invalidates tampered entries via hash verification", async () => {
    const service = new CacheService(
      {
        cleanupIntervalMs: 0,
        defaultOptions: { persistToDisk: false }
      },
      { workspace: vsMock.workspace }
    );

    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {
      /* suppress expected warning */
    });

    await service.set("tamper", { safe: true });

    const entries = (service as unknown as { entries: Map<string, { serialized?: string }> }).entries;
    const entry = entries.get("tamper");
    expect(entry).toBeDefined();
    if (entry) {
      entry.serialized = JSON.stringify({ safe: false, hacked: true });
    }

    const result = await service.get("tamper");
    expect(result).toBeNull();
    expect(service.has("tamper")).toBe(false);

    await service.dispose();
    warnSpy.mockRestore();
  });
});