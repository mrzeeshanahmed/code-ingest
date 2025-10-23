/*
 * Follow instructions in copilot-instructions.md exactly.
 */

export function createMockStore(initialState = {}) {
  let state = { ...initialState };
  const listeners = new Set();
  return {
    getState() {
      return state;
    },
    setState(update) {
      const nextState =
        typeof update === "function" ? { ...state, ...update(state) } : { ...state, ...update };
      state = nextState;
      listeners.forEach((listener) => listener(state));
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
}

export function createMockUIRenderer() {
  const methods = [
    "updatePreview",
    "setTokenCount",
    "updateProgress",
    "toggleLoadingOverlay",
    "updateTree",
    "updateTreeSelection",
    "showRecoverableError",
    "clearRecoverableError",
    "updateConfig",
    "showGenerationResult",
    "showRepoMetadata",
    "enableIngestActions",
    "restoreState",
    "applyPreviewDelta"
  ];

  const renderer = {};
  for (const method of methods) {
    renderer[method] = jest.fn();
  }
  return renderer;
}
