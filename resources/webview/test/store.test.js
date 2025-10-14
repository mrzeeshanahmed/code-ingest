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

    it("syncs redaction override from config updates", () => {
      const actions = store.getActions();

      actions.config.update({ redactionOverride: true });
      let state = store.getState();
      expect(state.generation.redactionOverride).toBe(true);

      actions.config.update({ redactionOverride: false });
      state = store.getState();
      expect(state.generation.redactionOverride).toBe(false);
    });
  });

  describe("legacy patch buffering", () => {
    it("queues partial updates until markReady is invoked", () => {
      store.setState({ preview: { title: "Queued" } });

      expect(store.getState().preview.title).not.toBe("Queued");

      store.markReady();

      expect(store.getState().preview.title).toBe("Queued");
    });

    it("applies tree and selection updates atomically", () => {
      const initialState = store.getState();
      const initialSelectionSet = initialState.fileTree.selectedFiles;

      store.markReady();
      store.setState({ tree: [{ path: "src/index.ts" }], selection: ["src/index.ts"] });

      const nextState = store.getState();
      expect(nextState.tree).toEqual([{ path: "src/index.ts" }]);
      expect(nextState.selection).toEqual(["src/index.ts"]);
      expect(nextState.fileTree.selectedFiles.has("src/index.ts")).toBe(true);
      expect(nextState.fileTree.selectedFiles).not.toBe(initialSelectionSet);
    });

    it("flushes queued updaters in order", () => {
      store.setState(() => ({ status: "loading" }));
      store.setState(() => ({ status: "ready" }));

      expect(store.getState().status).toBe("idle");

      store.markReady();

      expect(store.getState().status).toBe("ready");
    });

    it("clones notification arrays to avoid external mutation", () => {
      const errors = [{ message: "one" }];

      store.markReady();
      store.setState({ errors });

      const nextState = store.getState();
      expect(nextState.errors).not.toBe(errors);
      expect(nextState.notifications.errors).not.toBe(errors);
      expect(nextState.errors).toEqual(errors);

      errors.push({ message: "two" });
      expect(nextState.errors).toEqual([{ message: "one" }]);
    });
  });
});
