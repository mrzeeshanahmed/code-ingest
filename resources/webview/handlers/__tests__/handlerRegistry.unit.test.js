/**
 * @jest-environment jsdom
 */
/*
 * Follow instructions in copilot-instructions.md exactly.
 */

describe("HandlerRegistry readiness", () => {
  let HandlerRegistry;

  beforeAll(async () => {
    ({ HandlerRegistry } = await import("../handlerRegistry.js"));
  });

  const createHandler = (collector) => ({
    canHandle: () => true,
    validate: () => ({ ok: true }),
    handle: jest.fn(),
    async process(_type, payload) {
      collector.push(payload);
    }
  });

  it("buffers messages until setReady is called", async () => {
    const processed = [];
    const registry = new HandlerRegistry({ logger: console });
    registry.register("test", createHandler(processed));

    const pending = registry.process("test", { value: 1 });

    expect(processed).toHaveLength(0);

    registry.setReady();
    await pending;

    expect(processed).toEqual([{ value: 1 }]);
  });

  it("drains buffered messages in the original order", async () => {
    const processed = [];
    const registry = new HandlerRegistry({ logger: console });
    registry.register("test", createHandler(processed));

    const pending = [
      registry.process("test", { value: 1 }),
      registry.process("test", { value: 2 }),
      registry.process("test", { value: 3 })
    ];

    registry.setReady();
    await Promise.all(pending);

    expect(processed).toEqual([{ value: 1 }, { value: 2 }, { value: 3 }]);
  });

  it("throws and reports when handler registration is malformed", () => {
    const errorSpy = jest.fn();
    const postMessage = jest.fn();
    window.vscode = { postMessage };

    const registry = new HandlerRegistry({ logger: { info: jest.fn(), warn: jest.fn(), error: errorSpy } });
    const malformedHandler = {
      process: jest.fn()
    };

    expect(() => registry.register("bad", malformedHandler)).toThrow(/validate/);
    expect(errorSpy).toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "handler:error" }));
    delete window.vscode;
  });

  it("propagates and reports errors when flushing buffered messages", async () => {
    const postMessage = jest.fn();
    window.vscode = { postMessage };
    const registry = new HandlerRegistry({ logger: console });
    registry.register("error", {
      canHandle: () => true,
      validate: () => ({ ok: true }),
      handle: jest.fn(),
      async process() {
        throw new Error("flush-fail");
      }
    });

    const pending = registry.process("error", { foo: "bar" });

    registry.setReady();
    await expect(pending).rejects.toThrow("flush-fail");
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "handler:error" }));
    delete window.vscode;
  });
});
