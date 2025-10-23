/**
 * @jest-environment jsdom
 */
/*
 * Follow instructions in copilot-instructions.md exactly.
 */

import { beforeAll, describe, expect, it, jest } from "@jest/globals";

describe("HandlerRegistry buffering regression", () => {
  /** @type {import('../../handlers/handlerRegistry.js').HandlerRegistry} */
  let HandlerRegistry;

  beforeAll(async () => {
    ({ HandlerRegistry } = await import("../../handlers/handlerRegistry.js"));
  });

  const createHandler = (collector) => ({
    canHandle: jest.fn(() => true),
    validate: jest.fn(() => ({ ok: true })),
    handle: jest.fn(),
    async process(messageType, payload) {
      collector.push({ messageType, payload });
    }
  });

  it("flushes restore and progress updates only after the registry becomes ready", async () => {
    const processed = [];
    const registry = new HandlerRegistry({ logger: console });
    const handler = createHandler(processed);

    registry.register(["restoredState", "progress"], handler);

    const pending = [
      registry.process("restoredState", { state: { tree: [] } }),
      registry.process("progress", { phase: "ingest", message: "Loading" })
    ];

    expect(processed).toHaveLength(0);
    expect(handler.canHandle).not.toHaveBeenCalled();

    registry.setReady();
    await Promise.all(pending);

    expect(handler.canHandle).toHaveBeenCalledTimes(2);
    expect(processed).toEqual([
      { messageType: "restoredState", payload: { state: { tree: [] } } },
      { messageType: "progress", payload: { phase: "ingest", message: "Loading" } }
    ]);
  });
});
