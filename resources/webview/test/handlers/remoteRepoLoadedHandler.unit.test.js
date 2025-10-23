/**
 * @jest-environment jsdom
 */
/*
 * Follow instructions in copilot-instructions.md exactly.
 */

describe("RemoteRepoLoadedHandler", () => {
  let RemoteRepoLoadedHandler;
  let createMockStore;
  let createMockUIRenderer;

  beforeAll(async () => {
    ({ RemoteRepoLoadedHandler } = await import("../../handlers/remoteRepoLoadedHandler.js"));
    ({ createMockStore, createMockUIRenderer } = await import("../testUtils.js"));
  });

  it("updates repo metadata and enables actions", async () => {
    const store = createMockStore();
    const ui = createMockUIRenderer();
    const handler = new RemoteRepoLoadedHandler(store, ui, { postMessage: jest.fn(), log: console });

    await handler.process("remoteRepoLoaded", {
      repoUrl: "https://example.com/repo.git",
      sha: "abcdef1"
    });

    expect(store.getState().remoteRepo.repoUrl).toContain("example.com");
    expect(ui.showRepoMetadata).toHaveBeenCalled();
    expect(ui.enableIngestActions).toHaveBeenCalledWith(true);
  });

  it("shows warnings when provided", async () => {
    const store = createMockStore();
    const ui = createMockUIRenderer();
    const handler = new RemoteRepoLoadedHandler(store, ui, { postMessage: jest.fn(), log: console });

    await handler.process("remoteRepoLoaded", {
      repoUrl: "https://example.com/repo.git",
      sha: "abcdef1",
      warnings: ["Sparse checkout failed"]
    });

    expect(ui.showRecoverableError).toHaveBeenCalled();
  });

  it("rejects invalid payload", async () => {
    const store = createMockStore();
    const ui = createMockUIRenderer();
    const postMessage = jest.fn();
    const handler = new RemoteRepoLoadedHandler(store, ui, { postMessage, log: console });

    await handler.process("remoteRepoLoaded", { sha: "abc" });

    expect(ui.showRepoMetadata).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "handler:validationFailed" })
    );
  });
});
