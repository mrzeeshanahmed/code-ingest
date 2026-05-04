// @ts-nocheck
import { jest } from "@jest/globals";
import * as path from "node:path";

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
const createdWebviewPanels: any[] = [];

function createUri(fsPath: string) {
  return {
    scheme: "file",
    fsPath,
    path: fsPath,
    toString: () => fsPath,
    toJSON: () => ({ scheme: "file", path: fsPath })
  };
}

class RelativePattern {
  public baseUri: any;
  public pattern: string;
  constructor(base: any, pattern: string) {
    this.baseUri = typeof base === "string" ? createUri(base) : base;
    this.pattern = pattern;
  }
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
  positionAt: jest.fn((offset: number) => ({ line: 0, character: offset })),
  save: jest.fn(() => Promise.resolve(true)),
  version: 1,
  isClosed: false,
  lineAt: jest.fn(),
  offsetAt: jest.fn(),
  validateRange: jest.fn((range: any) => range),
  validatePosition: jest.fn((position: any) => position)
});

const window = {
  showErrorMessage: jest.fn(() => Promise.resolve(undefined)),
  showWarningMessage: jest.fn(() => Promise.resolve(undefined)),
  showInformationMessage: jest.fn(() => Promise.resolve(undefined)),
  showInputBox: jest.fn(() => Promise.resolve(undefined)),
  showQuickPick: jest.fn(() => Promise.resolve(undefined)),
  withProgress: jest.fn((_: any, task: any) => task({ report: noop }, { isCancellationRequested: false })),
  showTextDocument: jest.fn(async (document: any) => ({
    document: document ?? createMockDocument(),
    edit: jest.fn(async (callback: any) => {
      callback({ insert: jest.fn() });
    })
  }))
} as any;

function createOutputChannelImplementation(name: string) {
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

function createTreeViewImplementation(id: string, options: any) {
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

function registerWebviewViewProviderImplementation(id: string, provider: any, options: any) {
  registeredWebviewProviders.set(id, { provider, options });
  return {
    dispose: jest.fn(() => {
      registeredWebviewProviders.delete(id);
    })
  };
}

window.registerWebviewViewProvider = jest.fn(registerWebviewViewProviderImplementation);

function createWebviewPanelImplementation(viewType: string, title: string, showOptions: any, options: any) {
  const disposeEmitter = createEventEmitter();
  const messageEmitter = createEventEmitter();

  const webview = {
    html: "",
    cspSource: "vscode-resource://test",
    options: options ?? {},
    postMessage: jest.fn(() => Promise.resolve(true)),
    asWebviewUri: jest.fn((uri: any) => ({
      scheme: "vscode-resource",
      fsPath: uri.fsPath ?? uri.path ?? String(uri),
      toString() {
        return `vscode-resource:${this.fsPath}`;
      }
    })),
    onDidReceiveMessage: jest.fn((listener: any) => messageEmitter.event(listener))
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
let activeEditorEmitter = createEventEmitter();

const fileSystemWatchers = new Set();

const workspace = {
  getConfiguration: jest.fn(() => ({ get: jest.fn(), update: jest.fn() })),
  getWorkspaceFolder: jest.fn(() => (workspace as any).workspaceFolders[0]),
  workspaceFolders: [] as any[],
  openTextDocument: jest.fn(async (input: any) => {
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
    rename: jest.fn(() => Promise.resolve()),
    stat: jest.fn(() => Promise.resolve({ type: 1, ctime: Date.now(), mtime: Date.now(), size: 0 }))
  },
  onDidChangeConfiguration: jest.fn((listener: any) => configurationEmitter.event(listener)),
  onDidChangeWorkspaceFolders: jest.fn((listener: any) => workspaceFolderEmitter.event(listener)),
  onDidSaveTextDocument: jest.fn((listener: any) => saveDocumentEmitter.event(listener)),
  createFileSystemWatcher: jest.fn((pattern: any) => {
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
      __fireChange: (uri: any) => changeEmitter.fire(uri),
      __fireCreate: (uri: any) => createEmitter.fire(uri),
      __fireDelete: (uri: any) => deleteEmitter.fire(uri)
    };

    fileSystemWatchers.add(watcher);
    return watcher;
  })
} as any;

workspace.__fireWorkspaceFoldersChanged = (event: any) => workspaceFolderEmitter.fire(event);
workspace.__fireConfigurationChange = (event: any) => configurationEmitter.fire(event);
workspace.__fireDidSaveTextDocument = (document: any) => saveDocumentEmitter.fire(document);
workspace.__getFileSystemWatchers = () => new Set(fileSystemWatchers);

const commandDisposables = new Map();

function registerCommandImplementation(commandId: string, handler: any) {
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

function executeCommandImplementation(commandId: string, ...args: any[]) {
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

(commands as any).__getRegisteredCommands = () => new Map(registeredCommands);

const registeredExtensions = new Map();

const extensions = {
  getExtension: jest.fn((id: string) => registeredExtensions.get(id) ?? undefined),
  all: [] as any[],
  __register(extension: any) {
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
  language: "en",
  clipboard: {
    writeText: jest.fn(() => Promise.resolve()),
    readText: jest.fn(() => Promise.resolve(""))
  }
};

const createUriFromValue = (value: any) => {
  if (value && typeof value.fsPath === "string") {
    return createUri(value.fsPath);
  }
  return createUri(String(value));
};

const Uri = {
  parse: jest.fn((value: any) => createUriFromValue(value)),
  file: jest.fn((value: any) => createUri(path.resolve(String(value)))),
  joinPath: jest.fn((base: any, ...segments: any[]) => {
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

const ConfigurationTarget = {
  Global: 1,
  Workspace: 2,
  WorkspaceFolder: 3
};

class TreeItem {
  label: any;
  collapsibleState: any;
  description: any;
  constructor(label: any, collapsibleState: any) {
    this.label = label;
    this.collapsibleState = collapsibleState;
    this.description = undefined;
  }
}

class MarkdownString {
  value: string;
  supportHtml: boolean;
  supportThemeIcons: boolean;
  isTrusted: boolean;
  constructor(value = "") {
    this.value = value;
    this.supportHtml = false;
    this.supportThemeIcons = false;
    this.isTrusted = false;
  }

  appendMarkdown(text: string) {
    this.value += text;
    return this;
  }

  appendText(text: string) {
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
  id: any;
  constructor(id: any) {
    this.id = id;
  }
}

class CancellationError extends Error {
  constructor(message?: string) {
    super(message ?? "Canceled");
    this.name = "CancellationError";
  }
}

class CancellationToken {
  _source: any;
  onCancellationRequested: any;
  constructor(source: any) {
    this._source = source;
    this.onCancellationRequested = jest.fn(() => ({ dispose: jest.fn() }));
  }

  get isCancellationRequested() {
    return this._source._isCancelled;
  }
}

class CancellationTokenSource {
  _isCancelled: boolean;
  token: any;
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

const EventEmitter = jest.fn(() => createEventEmitter());

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
  ConfigurationTarget,
  TreeItem,
  TreeItemCollapsibleState,
  TreeItemCheckboxState,
  ThemeIcon,
  MarkdownString,
  CancellationToken,
  CancellationTokenSource,
  CancellationError,
  EventEmitter
};

window.activeTextEditor = undefined;
window.onDidChangeActiveTextEditor = jest.fn((listener: any) => activeEditorEmitter.event(listener));
window.__fireActiveTextEditorChange = (editor: any) => {
  window.activeTextEditor = editor;
  activeEditorEmitter.fire(editor);
};

const registeredChatParticipants = new Map();
const chat = {
  createChatParticipant: jest.fn((id: string, handler: any) => {
    const participant = {
      id,
      handler,
      iconPath: undefined,
      dispose: jest.fn(() => {
        registeredChatParticipants.delete(id);
      })
    };
    registeredChatParticipants.set(id, participant);
    return participant;
  }),
  __getRegisteredParticipants: () => new Map(registeredChatParticipants)
};

const lm = {
  computeTextEmbedding: jest.fn(async (input: any) => {
    const normalized = String(input ?? "");
    return [normalized.length, normalized.split(/\s+/u).filter(Boolean).length];
  })
};

(mockVSCode as any).chat = chat;
(mockVSCode as any).lm = lm;

(mockVSCode as any).__reset = () => {
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
  window.onDidChangeActiveTextEditor.mockClear();
  window.onDidChangeActiveTextEditor.mockImplementation((listener: any) => activeEditorEmitter.event(listener));
  window.activeTextEditor = undefined;

  workspace.getConfiguration.mockClear();
  workspace.getWorkspaceFolder.mockClear();
  workspace.fs.readFile.mockClear();
  workspace.fs.writeFile.mockClear();
  workspace.fs.delete.mockClear();
  workspace.fs.rename.mockClear();
  workspace.fs.stat.mockClear();
  workspace.openTextDocument.mockClear();
  workspace.onDidChangeConfiguration.mockClear();
  workspace.onDidChangeWorkspaceFolders.mockClear();
  workspace.onDidSaveTextDocument.mockClear();
  workspace.createFileSystemWatcher.mockClear();
  workspace.workspaceFolders = [];
  saveDocumentEmitter.dispose();
  saveDocumentEmitter = createEventEmitter();
  workspace.onDidSaveTextDocument.mockImplementation((listener: any) => saveDocumentEmitter.event(listener));
  activeEditorEmitter.dispose();
  activeEditorEmitter = createEventEmitter();
  for (const watcher of fileSystemWatchers) {
    watcher.dispose();
  }
  fileSystemWatchers.clear();

  commands.registerCommand.mockClear();
  commands.registerCommand.mockImplementation(registerCommandImplementation);
  commands.executeCommand.mockClear();
  commands.executeCommand.mockImplementation(executeCommandImplementation);

  extensions.__reset();
  registeredChatParticipants.clear();
  chat.createChatParticipant.mockClear();
  lm.computeTextEmbedding.mockClear();
  env.clipboard.writeText.mockClear();
  env.clipboard.readText.mockClear();

  Uri.parse.mockClear();
  Uri.file.mockClear();
  Uri.joinPath.mockClear();
};

window.__getOutputChannels = () => new Map(outputChannels);
window.__getRegisteredWebviewProviders = () => new Map(registeredWebviewProviders);
window.__getCreatedWebviews = () => [...createdWebviewPanels];
(commands as any).__getCommandDisposables = () => new Map(commandDisposables);

export { window, workspace, commands, extensions, env, Uri, authentication, ProgressLocation, ExtensionMode, ExtensionRuntime, ExtensionKind, FileType, ViewColumn, ConfigurationTarget, TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, ThemeIcon, MarkdownString, CancellationToken, CancellationTokenSource, CancellationError, EventEmitter, chat, lm, RelativePattern };
export default mockVSCode;
