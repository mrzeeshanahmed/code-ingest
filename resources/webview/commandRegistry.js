const handlers = new Map();

export const commandRegistry = {
  register(commandName, handler) {
    if (typeof handler !== "function") {
      throw new TypeError(`Handler for command "${commandName}" must be a function.`);
    }

    handlers.set(commandName, handler);
    return () => {
      handlers.delete(commandName);
    };
  },

  dispatch(commandName, payload) {
    const handler = handlers.get(commandName);
    if (!handler) {
      console.warn(`No handler registered for command: ${commandName}`);
      return;
    }

    handler(payload);
  }
};
