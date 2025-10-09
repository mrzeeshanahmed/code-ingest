/*
 * Follow instructions in copilot-instructions.md exactly.
 */

import { createStore } from "../../store.js";
import { createWebviewStore } from "../createStore.js";

const createMockStorage = () => {
  let value = null;
  return {
    getItem: () => value,
    setItem: (key, next) => {
      value = next;
      return null;
    },
    removeItem: () => {
      value = null;
      return null;
    }
  };
};

const setupWindow = () => {
  if (typeof window !== "undefined") {
    return;
  }

  global.window = {
    localStorage: createMockStorage(),
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    __REDUX_DEVTOOLS_EXTENSION__: undefined
  };

  global.BroadcastChannel = class {
    constructor() {
      this.listeners = new Set();
    }
    postMessage() {}
    addEventListener(event, listener) {
      if (event === "message") {
        this.listeners.add(listener);
      }
    }
    removeEventListener(event, listener) {
      if (event === "message") {
        this.listeners.delete(listener);
      }
    }
    close() {
      this.listeners.clear();
    }
  };
};

setupWindow();

describe("webview store", () => {
  test("legacy setState patch updates tree and selection mirrors", () => {
    const store = createStore();

    store.setState({
      tree: [{ uri: "file:///foo.ts" }],
      selection: ["file:///foo.ts"]
    });

    const state = store.getState();
    expect(state.tree).toHaveLength(1);
    expect(Array.from(state.fileTree.selectedFiles)).toEqual(["file:///foo.ts"]);
    expect(state.selection).toEqual(["file:///foo.ts"]);
  });

  test("generation progress clamps percent and updates legacy mirror", () => {
    const store = createStore();
    const actions = store.getActions();

    actions.generation.updateProgress({ phase: "ingest", percent: 150, cancellable: true });

    const state = store.getState();
    expect(state.generation.progress.phase).toBe("ingest");
    expect(state.generation.progress.percent).toBe(100);
    expect(state.progress.percent).toBe(100);
    expect(state.generation.progress.cancellable).toBe(true);
  });

  test("persisted state rehydrates sets", () => {
    const storage = createMockStorage();
    const store = createWebviewStore({ enableSync: false, storage });
    const actions = store.getActions();

    actions.fileTree.setSelection(["a", "b"]);

  const persistedRaw = storage.getItem("code-ingest-webview");
  expect(persistedRaw).toBeTruthy();
  const persisted = JSON.parse(persistedRaw);
    expect(persisted.state.fileTree.selectedFiles).toEqual(["a", "b"]);

    const rehydratedStore = createWebviewStore({ enableSync: false, storage });
    const rehydratedState = rehydratedStore.getState();

    expect(Array.from(rehydratedState.fileTree.selectedFiles)).toEqual(["a", "b"]);
    expect(rehydratedState.selection).toEqual(["a", "b"]);
  });
});
