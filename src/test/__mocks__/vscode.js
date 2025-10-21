const path = require("node:path");

const noop = () => undefined;

const createEventEmitter = () => {
  const listeners = new Set();
  const event = jest.fn((listener) => {
    listeners.add(listener);
    return {
      dispose: () => listeners.delete(listener)
    };
  });

  const fire = jest.fn((...args) => {
    for (const listener of Array.from(listeners)) {
      listener(...args);
    }
  });

  const dispose = jest.fn(() => {
    listeners.clear();
  });

  return { event, fire, dispose };
};

const outputChannels = new Map();
const registeredCommands = new Map();
const registeredWebviewProviders = new Map();
const createdTreeViews = new Map();
const createdWebviewPanels = [];

function createUri(fsPath) {
  return {
    scheme: "file",
    fsPath,
    path: fsPath,
    toString: () => fsPath,
    toJSON: () => ({ scheme: "file", path: fsPath })
  };
}

const createMockDocument = (uri = createUri("untitled:mock")) => ({
  uri,
  fileName: uri.fsPath,
  isUntitled: false,
  isDirty: false,
  languageId: "plaintext",
  eol: 1,
  lineCount: 0,
  getText: jest.fn(() => ""),
  positionAt: jest.fn((offset) => ({ line: 0, character: offset })),
  save: jest.fn(() => Promise.resolve(true)),
  version: 1,
  isClosed: false,
  lineAt: jest.fn(),
  offsetAt: jest.fn(),
  validateRange: jest.fn((range) => range),
  validatePosition: jest.fn((position) => position)
});

const window = {
  showErrorMessage: jest.fn(() => Promise.resolve(undefined)),
  showWarningMessage: jest.fn(() => Promise.resolve(undefined)),
  showInformationMessage: jest.fn(() => Promise.resolve(undefined)),
  showInputBox: jest.fn(() => Promise.resolve(undefined)),
  showQuickPick: jest.fn(() => Promise.resolve(undefined)),
  withProgress: jest.fn((_, task) => task({ report: noop }, { isCancellationRequested: false })),
  showTextDocument: jest.fn(async (document) => ({
    document: document ?? createMockDocument(),
    edit: jest.fn(async (callback) => {
      callback({ insert: jest.fn() });
    })
  }))
};

function createOutputChannelImplementation(name) {
  const channel = {
    appendLine: jest.fn(),
    append: jest.fn(),
    clear: jest.fn(),
    dispose: jest.fn(),
    show: jest.fn(),
    hide: jest.fn()
  };
  outputChannels.set(name, channel);
  return channel;
}

window.createOutputChannel = jest.fn(createOutputChannelImplementation);

function createTreeViewImplementation(id, options) {
  const emitter = createEventEmitter();
  const treeView = {
    id,
    options,
    onDidChangeVisibility: emitter.event,
    dispose: jest.fn(() => {
      emitter.dispose();
      createdTreeViews.delete(id);
    })
  };
  createdTreeViews.set(id, treeView);
  return treeView;
}

window.createTreeView = jest.fn(createTreeViewImplementation);

window.__getCreatedTreeViews = () => new Map(createdTreeViews);

function registerWebviewViewProviderImplementation(id, provider, options) {
  registeredWebviewProviders.set(id, { provider, options });
  return {
    dispose: jest.fn(() => {
      registeredWebviewProviders.delete(id);
    })
  };
}

window.registerWebviewViewProvider = jest.fn(registerWebviewViewProviderImplementation);

function createWebviewPanelImplementation(viewType, title, showOptions, options) {
  const disposeEmitter = createEventEmitter();
  const messageEmitter = createEventEmitter();

  const webview = {
    html: "",
    cspSource: "vscode-resource://test",
    options: options ?? {},
    postMessage: jest.fn(() => Promise.resolve(true)),
    asWebviewUri: jest.fn((uri) => ({
      scheme: "vscode-resource",
      fsPath: uri.fsPath ?? uri.path ?? String(uri),
      toString() {
        return `vscode-resource:${this.fsPath}`;
      }
    })),
    onDidReceiveMessage: jest.fn((listener) => messageEmitter.event(listener))
  };

  const panel = {
    viewType,
    title,
    showOptions,
    options,
    webview,
    reveal: jest.fn(),
    dispose: jest.fn(() => {
      disposeEmitter.fire();
      disposeEmitter.dispose();
    }),
    onDidDispose: disposeEmitter.event,
    onDidChangeViewState: jest.fn()
  };

  createdWebviewPanels.push(panel);
  return panel;
}

window.createWebviewPanel = jest.fn(createWebviewPanelImplementation);

const workspaceFolderEmitter = createEventEmitter();
const configurationEmitter = createEventEmitter();
let saveDocumentEmitter = createEventEmitter();

const fileSystemWatchers = new Set();

const workspace = {
  getConfiguration: jest.fn(() => ({ get: jest.fn(), update: jest.fn() })),
  getWorkspaceFolder: jest.fn(() => workspace.workspaceFolders[0]),
  workspaceFolders: [],
  openTextDocument: jest.fn(async (input) => {
    if (input && typeof input === "object" && "fsPath" in input) {
      return createMockDocument(input);
    }
    if (typeof input === "object" && "path" in input) {
      return createMockDocument(createUri(input.path));
    }
    return createMockDocument();
  }),
  fs: {
    readFile: jest.fn(() => Promise.resolve(new Uint8Array())),
    writeFile: jest.fn(() => Promise.resolve()),
    delete: jest.fn(() => Promise.resolve()),
    rename: jest.fn(() => Promise.resolve())
  },
  onDidChangeConfiguration: jest.fn((listener) => configurationEmitter.event(listener)),
  onDidChangeWorkspaceFolders: jest.fn((listener) => workspaceFolderEmitter.event(listener)),
  onDidSaveTextDocument: jest.fn((listener) => saveDocumentEmitter.event(listener)),
  createFileSystemWatcher: jest.fn((pattern) => {
    const changeEmitter = createEventEmitter();
    const createEmitter = createEventEmitter();
    const deleteEmitter = createEventEmitter();

    const watcher = {
      pattern,
      onDidChange: changeEmitter.event,
      onDidCreate: createEmitter.event,
      onDidDelete: deleteEmitter.event,
      dispose: jest.fn(() => {
        changeEmitter.dispose();
        createEmitter.dispose();
        deleteEmitter.dispose();
        fileSystemWatchers.delete(watcher);
      }),
      __fireChange: (uri) => changeEmitter.fire(uri),
      __fireCreate: (uri) => createEmitter.fire(uri),
      __fireDelete: (uri) => deleteEmitter.fire(uri)
    };

    fileSystemWatchers.add(watcher);
    return watcher;
  })
};

workspace.__fireWorkspaceFoldersChanged = (event) => workspaceFolderEmitter.fire(event);
workspace.__fireConfigurationChange = (event) => configurationEmitter.fire(event);
workspace.__fireDidSaveTextDocument = (document) => saveDocumentEmitter.fire(document);
workspace.__getFileSystemWatchers = () => new Set(fileSystemWatchers);

const commandDisposables = new Map();

function registerCommandImplementation(commandId, handler) {
  registeredCommands.set(commandId, handler);
  const disposable = {
    dispose: jest.fn(() => {
      registeredCommands.delete(commandId);
      commandDisposables.delete(commandId);
    })
  };
  commandDisposables.set(commandId, disposable);
  return disposable;
}

function executeCommandImplementation(commandId, ...args) {
  const handler = registeredCommands.get(commandId);
  if (!handler) {
    return Promise.resolve(undefined);
  }
  try {
    const result = handler(...args);
    if (result && typeof result.then === "function") {
      return result;
    }
    return Promise.resolve(result);
  } catch (error) {
    return Promise.reject(error);
  }
}

const commands = {
  registerCommand: jest.fn(registerCommandImplementation),
  executeCommand: jest.fn(executeCommandImplementation)
};

commands.__getRegisteredCommands = () => new Map(registeredCommands);

const registeredExtensions = new Map();

const extensions = {
  getExtension: jest.fn((id) => registeredExtensions.get(id) ?? undefined),
  all: [],
  __register(extension) {
    registeredExtensions.set(extension.id, extension);
    this.all = [...registeredExtensions.values()];
  },
  __reset() {
    registeredExtensions.clear();
    this.all = [];
    this.getExtension.mockClear();
  }
};

const env = {
  machineId: "mock-machine",
  sessionId: "mock-session",
  language: "en"
};

const createUriFromValue = (value) => {
  if (value && typeof value.fsPath === "string") {
    return createUri(value.fsPath);
  }
  return createUri(String(value));
};

const Uri = {
  parse: jest.fn((value) => createUriFromValue(value)),
  file: jest.fn((value) => createUri(path.resolve(String(value)))),
  joinPath: jest.fn((base, ...segments) => {
    const basePath = base.fsPath ?? base.path ?? String(base);
    return createUri(path.join(basePath, ...segments));
  })
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

const ExtensionMode = {
  Production: 1,
  Development: 2,
  Test: 3
};

const ExtensionRuntime = {
  Node: 1,
  Web: 2
};

const ExtensionKind = {
  UI: 1,
  Workspace: 2,
  Web: 3
};

const FileType = {
  Unknown: 0,
  File: 1,
  Directory: 2,
  SymbolicLink: 64
};

const ViewColumn = {
  One: 1,
  Two: 2,
  Three: 3,
  Active: -1,
  Beside: -2
};

class TreeItem {
  constructor(label, collapsibleState) {
    this.label = label;
    this.collapsibleState = collapsibleState;
    this.description = undefined;
  }
}

class MarkdownString {
  constructor(value = "") {
    this.value = value;
    this.supportHtml = false;
    this.supportThemeIcons = false;
    this.isTrusted = false;
  }

  appendMarkdown(text) {
    this.value += text;
    return this;
  }

  appendText(text) {
    this.value += text;
    return this;
  }

  toString() {
    return this.value;
  }
}

const TreeItemCollapsibleState = {
  None: 0,
  Collapsed: 1,
  Expanded: 2
};

const TreeItemCheckboxState = {
  Unchecked: 0,
  Checked: 1,
  Indeterminate: 2
};

class ThemeIcon {
  constructor(id) {
    this.id = id;
  }
}

class CancellationError extends Error {
  constructor(message) {
    super(message ?? "Canceled");
    this.name = "CancellationError";
  }
}

class CancellationToken {
  constructor(source) {
    this._source = source;
    this.onCancellationRequested = jest.fn(() => ({ dispose: jest.fn() }));
  }

  get isCancellationRequested() {
    return this._source._isCancelled;
  }
}

class CancellationTokenSource {
  constructor() {
    this._isCancelled = false;
    this.token = new CancellationToken(this);
  }

  cancel() {
    this._isCancelled = true;
  }

  dispose() {
    this._isCancelled = true;
  }
}

const mockVSCode = {
  window,
  workspace,
  commands,
  extensions,
  env,
  Uri,
  authentication,
  ProgressLocation,
  ExtensionMode,
  ExtensionRuntime,
  ExtensionKind,
  FileType,
  ViewColumn,
  TreeItem,
  TreeItemCollapsibleState,
  TreeItemCheckboxState,
  ThemeIcon,
  MarkdownString,
  CancellationToken,
  CancellationTokenSource,
  CancellationError,
  EventEmitter: jest.fn(() => createEventEmitter())
};

mockVSCode.__reset = () => {
  registeredCommands.clear();
  commandDisposables.clear();
  registeredWebviewProviders.clear();
  createdTreeViews.clear();
  createdWebviewPanels.length = 0;
  outputChannels.clear();

  window.showErrorMessage.mockClear();
  window.showWarningMessage.mockClear();
  window.showInformationMessage.mockClear();
  window.showInputBox.mockClear();
  window.showQuickPick.mockClear();
  window.withProgress.mockClear();
  window.createOutputChannel.mockClear();
  window.createTreeView.mockClear();
  window.registerWebviewViewProvider.mockClear();
  window.createWebviewPanel.mockClear();
  window.showTextDocument.mockClear();

  workspace.getConfiguration.mockClear();
  workspace.getWorkspaceFolder.mockClear();
  workspace.fs.readFile.mockClear();
  workspace.fs.writeFile.mockClear();
  workspace.fs.delete.mockClear();
  workspace.fs.rename.mockClear();
  workspace.openTextDocument.mockClear();
  workspace.onDidChangeConfiguration.mockClear();
  workspace.onDidChangeWorkspaceFolders.mockClear();
  workspace.onDidSaveTextDocument.mockClear();
  workspace.createFileSystemWatcher.mockClear();
  workspace.workspaceFolders = [];
  saveDocumentEmitter.dispose();
  saveDocumentEmitter = createEventEmitter();
  workspace.onDidSaveTextDocument.mockImplementation((listener) => saveDocumentEmitter.event(listener));
  for (const watcher of fileSystemWatchers) {
    watcher.dispose();
  }
  fileSystemWatchers.clear();

  commands.registerCommand.mockClear();
  commands.registerCommand.mockImplementation(registerCommandImplementation);
  commands.executeCommand.mockClear();
  commands.executeCommand.mockImplementation(executeCommandImplementation);

  extensions.__reset();

  Uri.parse.mockClear();
  Uri.file.mockClear();
  Uri.joinPath.mockClear();
};

window.__getOutputChannels = () => new Map(outputChannels);
window.__getRegisteredWebviewProviders = () => new Map(registeredWebviewProviders);
window.__getCreatedWebviews = () => [...createdWebviewPanels];
commands.__getCommandDisposables = () => new Map(commandDisposables);

module.exports = mockVSCode;
