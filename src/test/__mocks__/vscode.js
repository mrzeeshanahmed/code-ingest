const noop = () => undefined;
const createEventEmitter = () => {
  const listeners = new Set();
  return {
    event: jest.fn((listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    fire: jest.fn((...args) => {
      for (const listener of listeners) {
        listener(...args);
      }
    }),
    dispose: jest.fn(() => {
      listeners.clear();
    })
  };
};

const window = {
  showErrorMessage: jest.fn(() => Promise.resolve(undefined)),
  showWarningMessage: jest.fn(() => Promise.resolve(undefined)),
  showInformationMessage: jest.fn(() => Promise.resolve(undefined)),
  showInputBox: jest.fn(() => Promise.resolve(undefined)),
  showQuickPick: jest.fn(() => Promise.resolve(undefined)),
  createOutputChannel: jest.fn(() => ({
    appendLine: jest.fn(),
    append: jest.fn(),
    clear: jest.fn(),
    dispose: jest.fn(),
    show: jest.fn()
  })),
  withProgress: jest.fn((_, task) => task({ report: noop }, { isCancellationRequested: false }))
};

const workspace = {
  getConfiguration: jest.fn(() => ({ get: jest.fn(), update: jest.fn() })),
  workspaceFolders: [],
  fs: {
    readFile: jest.fn(() => Promise.resolve(new Uint8Array())),
    writeFile: jest.fn(() => Promise.resolve()),
    delete: jest.fn(() => Promise.resolve()),
    rename: jest.fn(() => Promise.resolve())
  },
  onDidChangeConfiguration: jest.fn(() => noop)
};

const commands = {
  registerCommand: jest.fn(() => ({ dispose: jest.fn() })),
  executeCommand: jest.fn(() => Promise.resolve())
};

const env = {
  machineId: "mock-machine",
  sessionId: "mock-session",
  language: "en"
};

const Uri = {
  parse: jest.fn((value) => ({ scheme: "file", path: value, toString: () => value })),
  file: jest.fn((value) => ({ scheme: "file", fsPath: value, toString: () => value }))
};

const authentication = {
  getSession: jest.fn(() => Promise.resolve(undefined)),
  onDidChangeSessions: jest.fn(() => ({ dispose: jest.fn() }))
};

const ProgressLocation = {
  Notification: 15,
  Window: 10,
  SourceControl: 20
};

const mockVSCode = {
  window,
  workspace,
  commands,
  env,
  Uri,
  authentication,
  ProgressLocation,
  EventEmitter: jest.fn(() => createEventEmitter())
};

module.exports = mockVSCode;
