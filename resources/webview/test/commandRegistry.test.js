/*
 * Follow instructions in copilot-instructions.md exactly.
 */

const { describe, expect, it, beforeEach } = require("@jest/globals");
const { CommandRegistry } = require("../commandRegistry.js");
const { COMMAND_MAP } = require("../commandMap.js");

describe("CommandRegistry policies", () => {
  let postMessage;
  let registry;

  beforeEach(() => {
    postMessage = jest.fn();
    registry = new CommandRegistry({
      postMessage,
      acknowledgeTimeout: 20
    });
  });

  it("dedupes identical outbound payloads when strategy is dedupe", async () => {
    const commandId = COMMAND_MAP.WEBVIEW_TO_HOST.GENERATE_DIGEST;
    registry.register(commandId, undefined, {
      requiresAck: true,
      policy: { strategy: "dedupe" }
    });

  const payload = { selectedFiles: ["a.ts", "b.ts"], outputFormat: "markdown" };

    const firstPromise = registry.execute(commandId, payload);
    const secondPromise = registry.execute(commandId, { ...payload });

    await Promise.resolve();
    expect(postMessage).toHaveBeenCalledTimes(1);
    const [message] = postMessage.mock.calls[0];
    expect(message.command).toBe(commandId);

    registry.handleResponse({
      id: message.id,
      type: "response",
      command: message.command,
      payload: { ok: true }
    });

    const [firstResult, secondResult] = await Promise.all([firstPromise, secondPromise]);
    expect(firstResult).toEqual({ ok: true });
    expect(secondResult).toEqual({ ok: true });
  });

  it("queues non-ack outbound commands when strategy is queue", async () => {
    const commandId = COMMAND_MAP.WEBVIEW_TO_HOST.REFRESH_TREE;
    registry.register(commandId, undefined, {
      policy: { strategy: "queue" }
    });

    const firstPromise = registry.execute(commandId, {});
    const secondPromise = registry.execute(commandId, {});

    const [firstResult, secondResult] = await Promise.all([firstPromise, secondPromise]);
    expect(firstResult).toEqual({ ok: true });
    expect(secondResult).toEqual({ ok: true });
    expect(postMessage).toHaveBeenCalledTimes(2);
  });
});