/**
 * @jest-environment jsdom
 */
/*
 * Follow instructions in copilot-instructions.md exactly.
 */

describe("ProgressHandler", () => {
  let ProgressHandler;
  let createMockStore;
  let createMockUIRenderer;

  beforeAll(async () => {
    ({ ProgressHandler } = await import("../progressHandler.js"));
    ({ createMockStore, createMockUIRenderer } = await import("./testUtils.js"));
  });

  it("updates progress state and UI", async () => {
    const store = createMockStore();
    const ui = createMockUIRenderer();
    const handler = new ProgressHandler(store, ui, { postMessage: jest.fn(), log: console });

    await handler.process("progress", {
      phase: "ingest",
      percent: 50,
      message: "Halfway",
      cancellable: true
    });

    expect(store.getState().progress.phase).toBe("ingest");
    expect(ui.updateProgress).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "ingest", percent: 50 })
    );
  });

  it("shows loading overlay when overlayMessage provided", async () => {
    const store = createMockStore();
    const ui = createMockUIRenderer();
    const handler = new ProgressHandler(store, ui, { postMessage: jest.fn(), log: console });

    await handler.process("progress", {
      phase: "scan",
      overlayMessage: "Scanning"
    });

    expect(ui.toggleLoadingOverlay).toHaveBeenCalledWith(true, "Scanning");
  });

  it("skips handling invalid progress payload", async () => {
    const store = createMockStore();
    const ui = createMockUIRenderer();
    const postMessage = jest.fn();
    const handler = new ProgressHandler(store, ui, { postMessage, log: console });

    await handler.process("progress", { phase: "invalid" });

    expect(ui.updateProgress).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "handler:validationFailed" })
    );
  });
});