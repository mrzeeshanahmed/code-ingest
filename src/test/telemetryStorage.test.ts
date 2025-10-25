import { describe, expect, jest, test } from "@jest/globals";
import type { ExtensionContext, Memento } from "vscode";

import { TelemetryStorage } from "../services/telemetry/telemetryStorage";
import type { TelemetryEvent } from "../services/telemetryService";

type GlobalState = Pick<Memento, "get" | "update">;

type TestContext = Pick<ExtensionContext, "globalState">;

const createEvent = (seq: number): TelemetryEvent => ({
  name: `event-${seq}`,
  properties: { seq },
  measurements: { duration: seq },
  timestamp: new Date(Date.now() + seq),
  sessionId: "session-id",
  userId: "user-id"
});

type UpdateMock = jest.MockedFunction<(key: string, value: string | undefined) => Promise<void>>;
type GetMock = jest.MockedFunction<(key: string, defaultValue?: string) => string | undefined>;

const createInMemoryContext = () => {
  const state = new Map<string, string | undefined>();

  const get: GetMock = jest.fn((key: string, defaultValue?: string) => {
    return state.has(key) ? state.get(key) : defaultValue;
  });

  const update: UpdateMock = jest.fn(async (key: string, value: string | undefined) => {
    if (value === undefined) {
      state.delete(key);
    } else {
      state.set(key, value);
    }
  });

  const globalState: GlobalState = {
    get,
    update
  };

  return {
    context: { globalState } as unknown as TestContext,
    getMock: get,
    updateMock: update,
    state
  };
};

describe("TelemetryStorage", () => {
  test("serializes concurrent store operations", async () => {
    const { context, updateMock, state } = createInMemoryContext();
    const storage = new TelemetryStorage(context as ExtensionContext);

    let concurrentUpdates = 0;
    let maxConcurrentUpdates = 0;
    updateMock.mockImplementation(async (key: string, value: string | undefined) => {
      concurrentUpdates += 1;
      maxConcurrentUpdates = Math.max(maxConcurrentUpdates, concurrentUpdates);
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (value === undefined) {
        state.delete(key);
      } else {
        state.set(key, value);
      }
      concurrentUpdates -= 1;
    });

    const batchA = [createEvent(1), createEvent(2), createEvent(3)];
    const batchB = [createEvent(4), createEvent(5), createEvent(6)];

    await Promise.all([storage.storeEvents(batchA), storage.storeEvents(batchB)]);

    expect(maxConcurrentUpdates).toBe(1);
    expect(updateMock).toHaveBeenCalledTimes(2);

    const stored = await storage.loadEvents();
    const names = stored.map((event) => event.name).sort();
    expect(names).toEqual([...batchA, ...batchB].map((event) => event.name).sort());
  });

  test("recovers from failed write and allows subsequent stores", async () => {
    const { context, updateMock, state } = createInMemoryContext();
    const storage = new TelemetryStorage(context as ExtensionContext);

    let callCount = 0;
    updateMock.mockImplementation(async (key: string, value: string | undefined) => {
      callCount += 1;
      if (callCount === 1) {
        throw new Error("update failed");
      }

      if (value === undefined) {
        state.delete(key);
      } else {
        state.set(key, value);
      }
    });

    await expect(storage.storeEvents([createEvent(1)])).rejects.toThrow("update failed");

    await storage.storeEvents([createEvent(2)]);

    expect(updateMock).toHaveBeenCalledTimes(2);

    const stored = await storage.loadEvents();
    expect(stored).toHaveLength(1);
    expect(stored[0].name).toBe("event-2");
  });
});
