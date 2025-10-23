/**
 * @jest-environment jsdom
 */
/*
 * Follow instructions in copilot-instructions.md exactly.
 */

describe("Webview handler contract", () => {
  let BaseHandler;
  let createMockStore;
  let createMockUIRenderer;

  const handlerDefinitions = [
    { name: "ConfigHandler", importPath: "../../handlers/configHandler.js", samplePayload: { config: {} }, messageType: "config" },
    { name: "GenerationResultHandler", importPath: "../../handlers/generationResultHandler.js", samplePayload: { content: "" }, messageType: "generationResult" },
    { name: "IngestErrorHandler", importPath: "../../handlers/ingestErrorHandler.js", samplePayload: { message: "err" }, messageType: "ingestError" },
    { name: "IngestPreviewHandler", importPath: "../../handlers/ingestPreviewHandler.js", samplePayload: { previewId: "p" }, messageType: "ingestPreview" },
    { name: "PreviewDeltaHandler", importPath: "../../handlers/previewDeltaHandler.js", samplePayload: { changes: [{ changeType: "update", content: "" }] }, messageType: "previewDelta" },
    { name: "ProgressHandler", importPath: "../../handlers/progressHandler.js", samplePayload: { phase: "scan" }, messageType: "progress" },
    { name: "RemoteRepoLoadedHandler", importPath: "../../handlers/remoteRepoLoadedHandler.js", samplePayload: { repoUrl: "u", sha: "abc" }, messageType: "remoteRepoLoaded" },
    { name: "RestoredStateHandler", importPath: "../../handlers/restoredStateHandler.js", samplePayload: { state: {} }, messageType: "restoredState" },
    { name: "StateHandler", importPath: "../../handlers/stateHandler.js", samplePayload: { tree: [] }, messageType: "state:update" },
    { name: "TreeDataHandler", importPath: "../../handlers/treeDataHandler.js", samplePayload: { tree: [] }, messageType: "treeData" }
  ];

  beforeAll(async () => {
    ({ BaseHandler } = await import("../../handlers/base/handlerInterface.js"));
    ({ createMockStore, createMockUIRenderer } = await import("../testUtils.js"));
  });

  it.each(handlerDefinitions)("exposes required interface methods for %s", async ({ name, importPath, samplePayload, messageType }) => {
    const module = await import(importPath);
    const Handler = module[name];
    const store = createMockStore();
    const ui = createMockUIRenderer();
    const handlerInstance = new Handler(store, ui, { postMessage: jest.fn(), log: console });

    expect(handlerInstance).toBeInstanceOf(BaseHandler);
    expect(typeof handlerInstance.process).toBe("function");
    expect(typeof handlerInstance.validate).toBe("function");
    expect(typeof handlerInstance.handle).toBe("function");
    expect(typeof handlerInstance.canHandle).toBe("function");

    const messageTypes = handlerInstance.messageTypes instanceof Set
      ? handlerInstance.messageTypes
      : new Set(handlerInstance.messageTypes ?? []);

    expect(messageTypes.size).toBeGreaterThan(0);
    expect(messageTypes.has(messageType)).toBe(true);
    expect(handlerInstance.canHandle(messageType)).toBe(true);

    const validationResult = handlerInstance.validate(samplePayload, messageType);
    expect(validationResult === true || typeof validationResult === "boolean" || typeof validationResult === "object").toBe(true);
  });
});
