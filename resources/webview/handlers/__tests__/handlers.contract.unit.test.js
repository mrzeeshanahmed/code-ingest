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
    { name: "ConfigHandler", importPath: "../configHandler.js", samplePayload: { config: {} }, messageType: "config" },
    { name: "GenerationResultHandler", importPath: "../generationResultHandler.js", samplePayload: { content: "" }, messageType: "generationResult" },
    { name: "IngestErrorHandler", importPath: "../ingestErrorHandler.js", samplePayload: { message: "err" }, messageType: "ingestError" },
    { name: "IngestPreviewHandler", importPath: "../ingestPreviewHandler.js", samplePayload: { previewId: "p" }, messageType: "ingestPreview" },
    { name: "PreviewDeltaHandler", importPath: "../previewDeltaHandler.js", samplePayload: { changes: [{ changeType: "update", content: "" }] }, messageType: "previewDelta" },
    { name: "ProgressHandler", importPath: "../progressHandler.js", samplePayload: { phase: "scan" }, messageType: "progress" },
    { name: "RemoteRepoLoadedHandler", importPath: "../remoteRepoLoadedHandler.js", samplePayload: { repoUrl: "u", sha: "abc" }, messageType: "remoteRepoLoaded" },
    { name: "RestoredStateHandler", importPath: "../restoredStateHandler.js", samplePayload: { state: {} }, messageType: "restoredState" },
    { name: "StateHandler", importPath: "../stateHandler.js", samplePayload: { tree: [] }, messageType: "state:update" },
    { name: "TreeDataHandler", importPath: "../treeDataHandler.js", samplePayload: { tree: [] }, messageType: "treeData" }
  ];

  beforeAll(async () => {
    ({ BaseHandler } = await import("../base/handlerInterface.js"));
    ({ createMockStore, createMockUIRenderer } = await import("./testUtils.js"));
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
