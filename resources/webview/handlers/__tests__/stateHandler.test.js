/**
 * @jest-environment jsdom
 */
/*
 * Follow instructions in copilot-instructions.md exactly.
 */

describe("StateHandler", () => {
  let StateHandler;
  let createMockStore;
  let createMockUIRenderer;

  beforeAll(async () => {
    ({ StateHandler } = await import("../stateHandler.js"));
    ({ createMockStore, createMockUIRenderer } = await import("./testUtils.js"));
  });

  it("handles full state updates", async () => {
    const store = createMockStore();
    const ui = createMockUIRenderer();
    const handler = new StateHandler(store, ui, { postMessage: jest.fn(), log: console });

    await handler.process("state:update", {
      tree: [{ uri: "file" }],
      preview: { title: "Updated" },
      selection: ["file"]
    });

    expect(store.getState().selection).toEqual(["file"]);
    expect(ui.updatePreview).toHaveBeenCalled();
    expect(ui.updateTree).toHaveBeenCalled();
  });

  it("applies patch updates", async () => {
    const store = createMockStore({ preview: { title: "Old" } });
    const ui = createMockUIRenderer();
    const handler = new StateHandler(store, ui, { postMessage: jest.fn(), log: console });

    await handler.process("state:patch", { preview: { title: "New" } });

    expect(store.getState().preview.title).toBe("New");
  });

  it("sanely ignores malformed payload", async () => {
    const store = createMockStore();
    const ui = createMockUIRenderer();
    const postMessage = jest.fn();
    const handler = new StateHandler(store, ui, { postMessage, log: console });

    await handler.process("state:update", null);

    expect(ui.updatePreview).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "handler:validationFailed" })
    );
  });
});