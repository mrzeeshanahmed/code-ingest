/*
 * Follow instructions in copilot-instructions.md exactly.
 */

import { serializeState, deserializeState } from "./state.js";

const CHANNEL_NAME = "code-ingest-webview-store";

const createBroadcastChannel = () => {
  if (typeof BroadcastChannel === "undefined") {
    return null;
  }

  try {
    return new BroadcastChannel(CHANNEL_NAME);
  } catch (error) {
    console.warn("store.sync.broadcast.unavailable", error);
    return null;
  }
};

export const registerStateSync = (store, { onStateChange, windowRef = window } = {}) => {
  const channel = createBroadcastChannel();
  const instanceId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  const publish = (snapshot, reason = "mutation") => {
    const payload = {
      type: "store-sync",
      reason,
      snapshot,
      instanceId,
      ts: Date.now()
    };

    if (channel) {
      channel.postMessage(payload);
    }

    try {
      windowRef?.localStorage?.setItem(CHANNEL_NAME, JSON.stringify(payload));
    } catch (error) {
      console.warn("store.sync.localStorage.error", error);
    }

    if (typeof onStateChange === "function") {
      onStateChange(payload);
    }
  };

  const unsubscribeStore = store.subscribe(
    (state) => serializeState(state),
    (snapshot) => publish(snapshot),
    { fireImmediately: true, equalityFn: Object.is }
  );

  const handleMessage = (event) => {
    const message = event?.data;
    if (!message || message.instanceId === instanceId) {
      return;
    }
    if (message?.type === "store-sync" && message?.snapshot) {
      store.setState(
        { ...deserializeState(message.snapshot) },
        false,
        "sync.apply"
      );
    }
  };

  if (channel) {
    channel.addEventListener("message", handleMessage);
  }

  const handleStorage = (event) => {
    if (event.key !== CHANNEL_NAME || !event.newValue) {
      return;
    }

    try {
      const parsed = JSON.parse(event.newValue);
      if (parsed.instanceId === instanceId) {
        return;
      }
      store.setState({ ...deserializeState(parsed.snapshot) }, false, "sync.storage");
    } catch (error) {
      console.warn("store.sync.storage.error", error);
    }
  };

  if (windowRef && typeof windowRef.addEventListener === "function") {
    windowRef.addEventListener("storage", handleStorage);
  }

  const dispose = () => {
    unsubscribeStore();
    if (channel) {
      channel.removeEventListener("message", handleMessage);
      channel.close();
    }
    if (windowRef && typeof windowRef.removeEventListener === "function") {
      windowRef.removeEventListener("storage", handleStorage);
    }
  };

  return dispose;
};