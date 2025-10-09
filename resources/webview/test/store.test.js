/*
 * Follow instructions in copilot-instructions.md exactly.
 */

const { createStore } = require("../store.js");

describe("Webview Store", () => {
  let store;

  beforeEach(() => {
    store = createStore();
  });

  describe("initial state", () => {
    it("provides default UI configuration", () => {
      const state = store.getState();
      expect(state.ui).toEqual(
        expect.objectContaining({
          sidebarExpanded: true,
          previewPanelVisible: false,
          progressVisible: false,
          currentTab: "overview",
          theme: "system"
        })
      );
    });

    it("starts with an empty file tree", () => {
      const state = store.getState();
      const nodes = state.fileTree?.nodes ?? state.tree ?? [];

      expect(Array.isArray(nodes)).toBe(true);
      expect(nodes.length).toBe(0);
      expect(state.fileTree.selectedFiles instanceof Set).toBe(true);
      expect(state.fileTree.selectedFiles.size).toBe(0);
      expect(state.fileTree.expandedPaths.size).toBe(0);
    });
  });

  describe("file tree actions", () => {
    it("toggles file selection", () => {
      const actions = store.getActions();

      actions.fileTree.toggleSelection("file1.js");
      let state = store.getState();
      expect(state.fileTree.selectedFiles.has("file1.js")).toBe(true);

      actions.fileTree.toggleSelection("file1.js");
      state = store.getState();
      expect(state.fileTree.selectedFiles.has("file1.js")).toBe(false);
    });

    it("selects and clears all files", () => {
      const actions = store.getActions();
      const files = ["file1.js", "file2.js", "file3.js"];

      actions.fileTree.selectAll(files);
      let state = store.getState();
      expect(Array.from(state.fileTree.selectedFiles)).toEqual(expect.arrayContaining(files));

      actions.fileTree.selectNone();
      state = store.getState();
      expect(state.fileTree.selectedFiles.size).toBe(0);
    });

    it("handles directory expansion", () => {
      const actions = store.getActions();

      actions.fileTree.toggleExpanded("src/");
      let state = store.getState();
      expect(state.fileTree.expandedPaths.has("src/")).toBe(true);

      actions.fileTree.toggleExpanded("src/");
      state = store.getState();
      expect(state.fileTree.expandedPaths.has("src/")).toBe(false);
    });
  });

  describe("generation actions", () => {
    it("starts generation process", () => {
      const actions = store.getActions();

      actions.generation.startGeneration();
      const state = store.getState();
      expect(state.generation.inProgress).toBe(true);
      expect(state.generation.progress.phase).toBe("scanning");
    });

    it("updates generation progress", () => {
      const actions = store.getActions();
      const progress = { phase: "processing", filesProcessed: 10, totalFiles: 100 };

      actions.generation.updateProgress(progress);
      const state = store.getState();
      expect(state.generation.progress).toEqual(expect.objectContaining(progress));
    });

    it("toggles redaction override", () => {
      const actions = store.getActions();

      actions.generation.toggleRedactionOverride();
      let state = store.getState();
      expect(state.generation.redactionOverride).toBe(true);

      actions.generation.toggleRedactionOverride();
      state = store.getState();
      expect(state.generation.redactionOverride).toBe(false);
    });
  });
});
