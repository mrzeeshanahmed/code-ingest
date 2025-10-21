/**
 * @jest-environment jsdom
 */
/*
 * Follow instructions in copilot-instructions.md exactly.
 */

describe("ConfigHandler", () => {
  let ConfigHandler;
  let createMockStore;
  let createMockUIRenderer;

  beforeAll(async () => {
    ({ ConfigHandler } = await import("../configHandler.js"));
    ({ createMockStore, createMockUIRenderer } = await import("./testUtils.js"));
  });

  it("applies configuration updates", async () => {
    const store = createMockStore({ config: { maxFiles: 100 } });
    const ui = createMockUIRenderer();
    const handler = new ConfigHandler(store, ui, { postMessage: jest.fn(), log: console });

    await handler.process("config", {
      config: { maxFiles: 200 },
      activePreset: "Large"
    });

    expect(store.getState().config.maxFiles).toBe(200);
    expect(store.getState().config.summary).toMatchObject({
      statusLine: expect.any(String),
      includeSummary: expect.any(String)
    });
    expect(store.getState().activePreset).toBe("Large");
    expect(ui.updateConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        preset: "Large",
        summary: expect.objectContaining({ statusLine: expect.any(String) })
      })
    );
  });

  it("surfaces validation errors to the user", async () => {
    const store = createMockStore();
    const ui = createMockUIRenderer();
    const handler = new ConfigHandler(store, ui, { postMessage: jest.fn(), log: console });

    await handler.process("config", {
      config: {},
      validationErrors: ["Invalid path"]
    });

    expect(ui.showRecoverableError).toHaveBeenCalled();
  });

  it("ignores invalid payload", async () => {
    const store = createMockStore();
    const ui = createMockUIRenderer();
    const postMessage = jest.fn();
    const handler = new ConfigHandler(store, ui, { postMessage, log: console });

    await handler.process("config", 42);

    expect(ui.updateConfig).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "handler:validationFailed" })
    );
  });
});
