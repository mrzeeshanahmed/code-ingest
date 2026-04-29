/*
 * Follow instructions in copilot-instructions.md exactly.
 */

const isRecord = (value) => typeof value === "object" && value !== null;

const createSelectorListener = (selector, listener, options, getState) => {
  const selectorFn = selector ?? ((state) => state);
  const equalityFn = options?.equalityFn ?? Object.is;
  let currentSlice;

  const computeSlice = () => {
    try {
      currentSlice = selectorFn(getState());
    } catch (error) {
      console.warn("simpleStore.selector.initialize.failed", error);
      currentSlice = undefined;
    }
  };

  computeSlice();

  if (options?.fireImmediately) {
    try {
      listener(currentSlice, currentSlice);
    } catch (error) {
      console.warn("simpleStore.listener.fireImmediately.failed", error);
    }
  }

  return (state, previousState, action) => {
    let nextSlice;
    try {
      nextSlice = selectorFn(state);
    } catch (error) {
      console.warn("simpleStore.selector.runtime.failed", error);
      return;
    }

    if (equalityFn(currentSlice, nextSlice)) {
      return;
    }

    const previousSlice = currentSlice;
    currentSlice = nextSlice;

    try {
      listener(nextSlice, previousSlice, action);
    } catch (error) {
      console.warn("simpleStore.listener.failed", error);
    }
  };
};

export const createStore = (initializer) => {
  if (typeof initializer !== "function") {
    throw new TypeError("simpleStore requires an initializer function");
  }

  const listeners = new Set();
  let state;
  let initialSnapshot;

  const getState = () => state;

  const notify = (nextState, previousState, action) => {
    for (const listener of Array.from(listeners)) {
      try {
        listener(nextState, previousState, action);
      } catch (error) {
        console.warn("simpleStore.listener.notification.failed", error);
      }
    }
  };

  const setState = (partial, replace = false, action) => {
    const previousState = state;
    const candidate = typeof partial === "function" ? partial(previousState) : partial;

    if (candidate === undefined) {
      return action;
    }

    const nextState = replace
      ? candidate
      : isRecord(candidate)
        ? { ...previousState, ...candidate }
        : candidate;

    if (Object.is(nextState, previousState)) {
      return action;
    }

    state = nextState;
    notify(state, previousState, action);
    return action;
  };

  const subscribe = (selectorOrListener, listenerOrOptions, maybeOptions) => {
    if (typeof selectorOrListener === "function" && typeof listenerOrOptions === "function") {
      const wrapped = createSelectorListener(selectorOrListener, listenerOrOptions, maybeOptions, getState);
      listeners.add(wrapped);
      return () => listeners.delete(wrapped);
    }

    const listener = selectorOrListener;
    const options = (typeof listenerOrOptions === "object" && listenerOrOptions !== null)
      ? listenerOrOptions
      : maybeOptions ?? {};

    if (options.fireImmediately) {
      try {
        listener(state, state);
      } catch (error) {
        console.warn("simpleStore.listener.fireImmediately.failed", error);
      }
    }

    listeners.add(listener);
    return () => listeners.delete(listener);
  };

  const destroy = () => {
    listeners.clear();
  };

  const api = {
    setState,
    getState,
    subscribe,
    destroy,
    getInitialState: () => initialSnapshot
  };

  state = initializer((partial, replace, action) => setState(partial, replace, action), getState, api);
  initialSnapshot = state;

  if (state === undefined) {
    throw new Error("simpleStore initializer must return an initial state");
  }

  return {
    setState,
    getState,
    subscribe,
    destroy,
    getInitialState: () => initialSnapshot
  };
};

export const subscribeWithSelector = (config) => config;
export const devtools = (config) => config;
export const persist = (config) => config;