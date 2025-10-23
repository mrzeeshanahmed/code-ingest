/**
 * @jest-environment jsdom
 */
/*
 * Follow instructions in copilot-instructions.md exactly.
 */

describe("CommandRegistry", () => {
  let CommandRegistry;

  beforeAll(async () => {
    ({ CommandRegistry } = await import("../../commandRegistry.js"));
  });

  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  const createRegistry = () => {
    const posted = [];
    const acknowledgments = new Map();
    const acknowledgmentSystem = {
      waitForAcknowledgment(id) {
        const entry = {};
        entry.promise = new Promise((resolve, reject) => {
          entry.resolve = resolve;
          entry.reject = reject;
        });
        entry.promise.catch(() => {});
        acknowledgments.set(id, entry);
        return entry.promise;
      },
      handleAcknowledgment(id, payload) {
        const entry = acknowledgments.get(id);
        if (!entry) {
          return false;
        }
        entry.resolve(payload);
        acknowledgments.delete(id);
        return true;
      },
      reject(id, error) {
        const entry = acknowledgments.get(id);
        if (!entry) {
          return;
        }
        entry.reject(error);
        acknowledgments.delete(id);
      }
    };
    const envelope = {
      sessionToken: "test-token",
      createMessage(type, command, payload, metadata = {}) {
        return {
          id: `msg-${Math.random().toString(36).slice(2)}`,
          type,
          command,
          payload,
          ...metadata
        };
      },
      validateMessage: () => ({ ok: true })
    };

    const registry = new CommandRegistry({
      postMessage: (message) => posted.push(message),
      logger: console,
      acknowledgeTimeout: 50,
      envelope,
      acknowledgmentSystem
    });

    return { registry, posted };
  };

  it("queues acknowledged commands until the prior one completes", async () => {
    const { registry, posted } = createRegistry();

    registry.register("test.command", undefined, {
      requiresAck: true,
      rateLimitMs: 0,
      direction: "outbound"
    });

    const firstPromise = registry.execute("test.command", { seq: 1 });
    const secondPromise = registry.execute("test.command", { seq: 2 });

    await tick();

    expect(firstPromise).not.toBe(secondPromise);
    expect(posted).toHaveLength(1);
    expect(posted[0].payload).toEqual(expect.objectContaining({ seq: 1 }));

    registry.handleResponse({ id: posted[0].id, payload: { ok: true } });
    await expect(firstPromise).resolves.toEqual({ ok: true });

    await tick();

    expect(posted).toHaveLength(2);
    expect(posted[1].payload).toEqual(expect.objectContaining({ seq: 2 }));

    registry.handleResponse({ id: posted[1].id, payload: { ok: true } });
    await expect(secondPromise).resolves.toEqual({ ok: true });
  });

  it("continues processing queued commands when the first handler fails", async () => {
    const { registry, posted } = createRegistry();

    let attempt = 0;
    registry.register(
      "test.command",
      async () => {
        attempt += 1;
        if (attempt === 1) {
          throw new Error("boom");
        }
      },
      { requiresAck: true, rateLimitMs: 0, direction: "outbound" }
    );

    const firstPromise = registry.execute("test.command", { seq: 1 });
    const secondPromise = registry.execute("test.command", { seq: 2 });

    const [firstResult] = await Promise.allSettled([firstPromise]);
    expect(firstResult.status).toBe("rejected");
    expect(firstResult.reason).toBeInstanceOf(Error);
    expect(firstResult.reason.message).toBe("boom");

  await tick();

    expect(posted).toHaveLength(1);
    expect(posted[0].payload).toEqual(expect.objectContaining({ seq: 2 }));

    registry.handleResponse({ id: posted[0].id, payload: { ok: true } });
    await expect(secondPromise).resolves.toEqual({ ok: true });
  });
});
