/**
 * @jest-environment jsdom
 */
/*
 * Follow instructions in copilot-instructions.md exactly.
 */

describe("TreeDataHandler", () => {
  let TreeDataHandler;
  let createMockStore;
  let createMockUIRenderer;

  beforeAll(async () => {
    ({ TreeDataHandler } = await import("../treeDataHandler.js"));
    ({ createMockStore, createMockUIRenderer } = await import("./testUtils.js"));
  });

  it("renders tree data and selection", async () => {
    const store = createMockStore();
    const ui = createMockUIRenderer();
    const handler = new TreeDataHandler(store, ui, { postMessage: jest.fn(), log: console });

    const payload = {
      tree: [
        {
          uri: "root",
          name: "root",
          expanded: true,
          children: [{ uri: "root/file", name: "file" }]
        }
      ],
      selection: ["root/file"]
    };

    await handler.process("treeData", payload);

    expect(store.getState().tree).toHaveLength(1);
    expect(ui.updateTree).toHaveBeenCalledWith(expect.any(Array), expect.any(Object));
    expect(ui.updateTreeSelection).toHaveBeenCalledWith(["root/file"]);
  });

  it("shows warnings when provided", async () => {
    const store = createMockStore();
    const ui = createMockUIRenderer();
    const handler = new TreeDataHandler(store, ui, { postMessage: jest.fn(), log: console });

    await handler.process("treeData", { tree: [], warnings: ["Too many files"] });

    expect(ui.showRecoverableError).toHaveBeenCalled();
  });

  it("rejects malformed payloads", async () => {
    const store = createMockStore();
    const ui = createMockUIRenderer();
    const postMessage = jest.fn();
    const handler = new TreeDataHandler(store, ui, { postMessage, log: console });

    await handler.process("treeData", { tree: "oops" });

    expect(ui.updateTree).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "handler:validationFailed" })
    );
  });
});