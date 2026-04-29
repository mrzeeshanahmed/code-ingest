/**
 * @jest-environment jsdom
 */
/*
 * Follow instructions in copilot-instructions.md exactly.
 */

describe("HandlerRegistry", () => {
  let HandlerRegistry;

  beforeAll(async () => {
    ({ HandlerRegistry } = await import("../handlerRegistry.js"));
  });

  beforeEach(() => {
    window.vscode = { postMessage: jest.fn() };
  });

  it("dispatches messages to registered handlers", async () => {
    const registry = new HandlerRegistry();
    const handler = {
      process: jest.fn().mockResolvedValue(undefined),
      canHandle: () => true,
      validate: jest.fn().mockReturnValue({ ok: true }),
      handle: jest.fn()
    };

    registry.register("foo", handler);
    registry.setReady();
    await registry.process("foo", { value: 1 });

    expect(handler.process).toHaveBeenCalledWith("foo", { value: 1 });
  });

  it("invokes fallback for unknown types", async () => {
    const fallback = jest.fn();
    const registry = new HandlerRegistry({ fallbackHandler: fallback });

    registry.setReady();
    await registry.process("unknown", {});

    expect(fallback).toHaveBeenCalledWith("unknown", {});
  });

  it("reports handler errors back to host", async () => {
    const registry = new HandlerRegistry();
    const handler = {
      canHandle: () => true,
      validate: jest.fn().mockReturnValue({ ok: true }),
      handle: jest.fn(),
      process: () => {
        throw new Error("boom");
      }
    };

    registry.register("boom", handler);
    registry.setReady();
    await expect(registry.process("boom", {})).rejects.toThrow("boom");

    expect(window.vscode.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "handler:error" })
    );
  });

  it("rejects handlers missing required interface methods", () => {
    const registry = new HandlerRegistry();

    expect(() => registry.register("missingValidate", {
      process: jest.fn(),
      canHandle: jest.fn(),
      handle: jest.fn()
    })).toThrow(/must implement validate/);

    expect(() => registry.register("missingHandle", {
      process: jest.fn(),
      canHandle: jest.fn(),
      validate: jest.fn()
    })).toThrow(/must implement validate/);
  });

  it("defaults canHandle when missing", () => {
    const warn = jest.fn();
    const registry = new HandlerRegistry({ logger: { info: jest.fn(), warn, error: jest.fn() } });
    const handler = {
      process: jest.fn(),
      validate: jest.fn(),
      handle: jest.fn()
    };

    expect(() => registry.register("missingCanHandle", handler)).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("does not implement canHandle"));

    const registered = registry.getHandler("missingCanHandle");
    expect(typeof registered.canHandle).toBe("function");
    expect(registered.canHandle("missingCanHandle")).toBe(true);
  });
});