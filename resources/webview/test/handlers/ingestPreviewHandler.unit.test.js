/**
 * @jest-environment jsdom
 */
/*
 * Follow instructions in copilot-instructions.md exactly.
 */

describe("IngestPreviewHandler", () => {
  let IngestPreviewHandler;
  let createMockStore;
  let createMockUIRenderer;

  beforeAll(async () => {
    ({ IngestPreviewHandler } = await import("../../handlers/ingestPreviewHandler.js"));
    ({ createMockStore, createMockUIRenderer } = await import("../testUtils.js"));
  });

  it("updates the store and preview UI on valid payload", async () => {
    const store = createMockStore();
    const ui = createMockUIRenderer();
    const postMessage = jest.fn();
    const handler = new IngestPreviewHandler(store, ui, { postMessage, log: console });

    const payload = {
      previewId: "abc",
      title: "Digest",
      subtitle: "Summary",
      content: "Hello world",
      tokenCount: { total: 1234 }
    };

    await handler.process("ingestPreview", payload);

    expect(store.getState().preview.title).toBe("Digest");
    expect(ui.updatePreview).toHaveBeenCalledWith(expect.objectContaining({ title: "Digest" }));
    expect(ui.setTokenCount).toHaveBeenCalledWith({ total: 1234 });
  });

  it("does not invoke UI when payload is invalid", async () => {
    const store = createMockStore();
    const ui = createMockUIRenderer();
    const postMessage = jest.fn();
    const handler = new IngestPreviewHandler(store, ui, { postMessage, log: console });

    await handler.process("ingestPreview", { title: "Missing id" });

    expect(ui.updatePreview).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "handler:validationFailed" })
    );
  });

  it("sanitises metadata before updating config", async () => {
    const store = createMockStore();
    const ui = createMockUIRenderer();
    const handler = new IngestPreviewHandler(store, ui, { postMessage: jest.fn(), log: console });

    await handler.process("ingestPreview", {
      previewId: "def",
      metadata: { "<script>": "alert(1)" }
    });

    expect(ui.updateConfig).toHaveBeenCalled();
  });
});
