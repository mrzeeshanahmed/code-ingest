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
    await registry.process("foo", { value: 1 });

    expect(handler.process).toHaveBeenCalledWith("foo", { value: 1 });
  });

  it("invokes fallback for unknown types", async () => {
    const fallback = jest.fn();
    const registry = new HandlerRegistry({ fallbackHandler: fallback });

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
    await registry.process("boom", {});

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

    expect(() => registry.register("missingCanHandle", {
      process: jest.fn(),
      validate: jest.fn(),
      handle: jest.fn()
    })).toThrow(/must implement canHandle/);
  });
});
