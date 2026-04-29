/**
 * @jest-environment jsdom
 */
/*
 * Follow instructions in copilot-instructions.md exactly.
 */

describe("PreviewDeltaHandler", () => {
  let PreviewDeltaHandler;
  let createMockStore;
  let createMockUIRenderer;

  beforeAll(async () => {
    ({ PreviewDeltaHandler } = await import("../previewDeltaHandler.js"));
    ({ createMockStore, createMockUIRenderer } = await import("./testUtils.js"));
  });

  it("applies preview changes", async () => {
    const store = createMockStore();
    const ui = createMockUIRenderer();
    const handler = new PreviewDeltaHandler(store, ui, { postMessage: jest.fn(), log: console });

    await handler.process("previewDelta", {
      changes: [{ changeType: "append", content: " more" }]
    });

    expect(ui.applyPreviewDelta).toHaveBeenCalled();
  });

  it("updates token count when provided", async () => {
    const store = createMockStore({ preview: {} });
    const ui = createMockUIRenderer();
    const handler = new PreviewDeltaHandler(store, ui, { postMessage: jest.fn(), log: console });

    await handler.process("previewDelta", {
      changes: [{ changeType: "update", content: "text" }],
      tokenCount: { total: 100 }
    });

    expect(store.getState().preview.tokenCount.total).toBe(100);
    expect(ui.setTokenCount).toHaveBeenCalledWith({ total: 100 });
  });

  it("ignores invalid payload", async () => {
    const store = createMockStore();
    const ui = createMockUIRenderer();
    const postMessage = jest.fn();
    const handler = new PreviewDeltaHandler(store, ui, { postMessage, log: console });

    await handler.process("previewDelta", {});

    expect(ui.applyPreviewDelta).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "handler:validationFailed" })
    );
  });
});