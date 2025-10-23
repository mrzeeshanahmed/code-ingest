/**
 * @jest-environment jsdom
 */
/*
 * Follow instructions in copilot-instructions.md exactly.
 */

describe("RestoredStateHandler", () => {
  let RestoredStateHandler;
  let createMockStore;
  let createMockUIRenderer;

  beforeAll(async () => {
    ({ RestoredStateHandler } = await import("../../handlers/restoredStateHandler.js"));
    ({ createMockStore, createMockUIRenderer } = await import("../testUtils.js"));
  });

  it("merges restored state and updates renderer", async () => {
    const store = createMockStore();
    const ui = createMockUIRenderer();
    const handler = new RestoredStateHandler(store, ui, { postMessage: jest.fn(), log: console });

    await handler.process("restoredState", {
      state: {
        selection: ["a"],
        preview: { title: "Saved" }
      }
    });

    expect(store.getState().selection).toEqual(["a"]);
    expect(ui.restoreState).toHaveBeenCalledWith(expect.objectContaining({ selection: ["a"] }));
  });

  it("displays migration notice when provided", async () => {
    const store = createMockStore();
    const ui = createMockUIRenderer();
    const handler = new RestoredStateHandler(store, ui, { postMessage: jest.fn(), log: console });

    await handler.process("restoredState", {
      state: {},
      migrated: true
    });

    expect(ui.showRecoverableError).toHaveBeenCalled();
  });

  it("ignores payload without state", async () => {
    const store = createMockStore();
    const ui = createMockUIRenderer();
    const postMessage = jest.fn();
    const handler = new RestoredStateHandler(store, ui, { postMessage, log: console });

    await handler.process("restoredState", {});

    expect(ui.restoreState).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
  });
});
