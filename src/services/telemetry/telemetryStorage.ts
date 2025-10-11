import * as zlib from "node:zlib";
import * as vscode from "vscode";
import type { TelemetryEvent } from "../telemetryService";

function encodeEvents(events: TelemetryEvent[]): string {
  const payload = events.map((event) => ({
    ...event,
    timestamp: event.timestamp.toISOString()
  }));
  const json = JSON.stringify(payload);
  const compressed = zlib.deflateSync(Buffer.from(json, "utf8"));
  return compressed.toString("base64");
}

function decodeEvents(serialized: string): TelemetryEvent[] {
  const buffer = Buffer.from(serialized, "base64");
  const json = zlib.inflateSync(buffer).toString("utf8");
  const parsed = JSON.parse(json) as Array<Omit<TelemetryEvent, "timestamp"> & { timestamp: string }>;
  return parsed.map((event) => ({
    ...event,
    timestamp: new Date(event.timestamp)
  }));
}

export class TelemetryStorage {
  private readonly STORAGE_KEY = "codeIngest.telemetry.events";
  private readonly MAX_EVENTS = 1_000;

  constructor(private readonly context: vscode.ExtensionContext) {}

  async storeEvents(events: TelemetryEvent[]): Promise<void> {
    if (events.length === 0) {
      return;
    }

    const current = await this.loadEvents();
    const combined = [...current, ...events]
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
      .slice(0, this.MAX_EVENTS);

    const serialized = encodeEvents(combined);
    await this.context.globalState.update(this.STORAGE_KEY, serialized);
  }

  async loadEvents(): Promise<TelemetryEvent[]> {
    const serialized = this.context.globalState.get<string>(this.STORAGE_KEY);
    if (!serialized) {
      return [];
    }

    try {
      return decodeEvents(serialized);
    } catch {
      await this.context.globalState.update(this.STORAGE_KEY, undefined);
      return [];
    }
  }

  async clearEvents(): Promise<void> {
    await this.context.globalState.update(this.STORAGE_KEY, undefined);
  }

  async getStorageSize(): Promise<number> {
    const serialized = this.context.globalState.get<string>(this.STORAGE_KEY);
    return serialized ? Buffer.byteLength(serialized, "utf8") : 0;
  }
}
