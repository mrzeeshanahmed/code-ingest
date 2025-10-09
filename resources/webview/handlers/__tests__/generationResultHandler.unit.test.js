/**
 * @jest-environment jsdom
 */
/*
 * Follow instructions in copilot-instructions.md exactly.
 */

describe("GenerationResultHandler", () => {
  let GenerationResultHandler;
  let createMockStore;
  let createMockUIRenderer;

  beforeAll(async () => {
    ({ GenerationResultHandler } = await import("../generationResultHandler.js"));
    ({ createMockStore, createMockUIRenderer } = await import("./testUtils.js"));
  });

  it("stores generation result and updates preview", async () => {
    const store = createMockStore();
    const ui = createMockUIRenderer();
    const handler = new GenerationResultHandler(store, ui, {
      postMessage: jest.fn(),
      log: console
    });

    const payload = {
      resultId: "r1",
      title: "Complete",
      content: "Generated content",
      tokenCount: { total: 5000 },
      stats: { files: 3 }
    };

    await handler.process("generationResult", payload);

    expect(store.getState().lastGeneration.id).toBe("r1");
    expect(ui.showGenerationResult).toHaveBeenCalledWith(expect.objectContaining({ title: "Complete" }));
  });

  it("rejects invalid payload", async () => {
    const store = createMockStore();
    const ui = createMockUIRenderer();
    const postMessage = jest.fn();
    const handler = new GenerationResultHandler(store, ui, { postMessage, log: console });

    await handler.process("generationResult", { title: 123 });

    expect(ui.showGenerationResult).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "handler:validationFailed" })
    );
  });

  it("passes redaction state through the store", async () => {
    const store = createMockStore();
    const ui = createMockUIRenderer();
    const handler = new GenerationResultHandler(store, ui, { postMessage: jest.fn(), log: console });

    await handler.process("generationResult", {
      resultId: "r2",
      content: "",
      redacted: true
    });

    expect(store.getState().lastGeneration.redacted).toBe(true);
  });
});
