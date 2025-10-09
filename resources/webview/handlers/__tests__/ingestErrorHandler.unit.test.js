/**
 * @jest-environment jsdom
 */
/*
 * Follow instructions in copilot-instructions.md exactly.
 */

describe("IngestErrorHandler", () => {
  let IngestErrorHandler;
  let createMockStore;
  let createMockUIRenderer;

  beforeAll(async () => {
    ({ IngestErrorHandler } = await import("../ingestErrorHandler.js"));
    ({ createMockStore, createMockUIRenderer } = await import("./testUtils.js"));
  });

  it("appends error entries to the store and shows banner", async () => {
    const store = createMockStore();
    const ui = createMockUIRenderer();
    const handler = new IngestErrorHandler(store, ui, { postMessage: jest.fn(), log: console });

    await handler.process("ingestError", {
      errorId: "e1",
      message: "Something failed",
      code: "EFAIL"
    });

    expect(store.getState().errors).toHaveLength(1);
    expect(ui.showRecoverableError).toHaveBeenCalled();
  });

  it("sanitises hints and forwards to config", async () => {
    const store = createMockStore();
    const ui = createMockUIRenderer();
    const handler = new IngestErrorHandler(store, ui, { postMessage: jest.fn(), log: console });

    await handler.process("ingestError", {
      errorId: "e2",
      message: "Error",
      hint: "Use <strong>safe</strong> hint"
    });

    expect(ui.updateConfig).toHaveBeenCalled();
  });

  it("ignores invalid payload", async () => {
    const store = createMockStore();
    const ui = createMockUIRenderer();
    const postMessage = jest.fn();
    const handler = new IngestErrorHandler(store, ui, { postMessage, log: console });

    await handler.process("ingestError", {});

    expect(ui.showRecoverableError).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "handler:validationFailed" })
    );
  });
});
