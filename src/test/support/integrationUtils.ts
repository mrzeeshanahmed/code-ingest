import { jest } from "@jest/globals";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as vscode from "vscode";
import { activate as activateExtensionInternal, deactivate as deactivateExtensionInternal } from "../../extension";

class InMemoryMemento implements vscode.Memento {
  private readonly store = new Map<string, unknown>();

  get<T>(key: string, defaultValue?: T): T | undefined {
    if (!this.store.has(key)) {
      return defaultValue;
    }
    return this.store.get(key) as T;
  }

  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) {
      this.store.delete(key);
    } else {
      this.store.set(key, value);
    }
  }

  keys(): string[] {
    return [...this.store.keys()];
  }
}

function createSecretStorage(): vscode.SecretStorage {
  const store = new Map<string, string>();
  const emitter = new (vscode.EventEmitter as unknown as typeof vscode.EventEmitter)<vscode.SecretStorageChangeEvent>();

  return {
    get onDidChange(): vscode.Event<vscode.SecretStorageChangeEvent> {
      return emitter.event;
    },
    async get(key: string): Promise<string | undefined> {
      return store.get(key);
    },
    async store(key: string, value: string): Promise<void> {
      store.set(key, value);
      emitter.fire({ key });
    },
    async delete(key: string): Promise<void> {
      store.delete(key);
      emitter.fire({ key });
    }
  } satisfies vscode.SecretStorage;
}

function createEnvironmentVariableCollection(): vscode.EnvironmentVariableCollection {
  const entries = new Map<string, vscode.EnvironmentVariableMutator>();
  const collection: Partial<vscode.EnvironmentVariableCollection> & {
    dispose(): void;
    [Symbol.iterator](): IterableIterator<[string, vscode.EnvironmentVariableMutator]>;
  } = {
    persistent: true,
    description: undefined,
    replace(variable: string, value: string): void {
      entries.set(variable, {
        type: vscode.EnvironmentVariableMutatorType.Replace,
        value,
        options: {} as vscode.EnvironmentVariableMutatorOptions
      });
    },
    append(variable: string, value: string): void {
      entries.set(variable, {
        type: vscode.EnvironmentVariableMutatorType.Append,
        value,
        options: {} as vscode.EnvironmentVariableMutatorOptions
      });
    },
    prepend(variable: string, value: string): void {
      entries.set(variable, {
        type: vscode.EnvironmentVariableMutatorType.Prepend,
        value,
        options: {} as vscode.EnvironmentVariableMutatorOptions
      });
    },
    get(variable: string): vscode.EnvironmentVariableMutator | undefined {
      return entries.get(variable);
    },
    delete(variable: string): void {
      entries.delete(variable);
    },
    clear(): void {
      entries.clear();
    },
    forEach(callback: (variable: string, mutator: vscode.EnvironmentVariableMutator, collection: vscode.EnvironmentVariableCollection) => void, thisArg?: unknown): void {
      for (const [variable, mutator] of entries) {
        callback.call(thisArg, variable, mutator, collection as vscode.EnvironmentVariableCollection);
      }
    },
    [Symbol.iterator](): IterableIterator<[string, vscode.EnvironmentVariableMutator]> {
      return entries.entries();
    },
    dispose(): void {
      entries.clear();
    }
  };

  return collection as unknown as vscode.EnvironmentVariableCollection;
}

const workspaceDirStack: string[] = [];

export function createTempWorkspace(prefix = "code-ingest-test-"): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  workspaceDirStack.push(dir);
  return dir;
}

export function cleanupTempWorkspaces(): void {
  while (workspaceDirStack.length > 0) {
    const dir = workspaceDirStack.pop();
    if (!dir) {
      continue;
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
}

export async function seedWorkspaceFile(workspaceRoot: string, relative: string, content: string): Promise<void> {
  const fullPath = path.join(workspaceRoot, relative);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content, "utf8");
}

export function createMockExtensionContext(extensionPath = path.resolve(__dirname, "../../..")): vscode.ExtensionContext {
  const subscriptions: vscode.Disposable[] = [];
  const extensionUri = vscode.Uri.file(extensionPath);
  const workspaceState = new InMemoryMemento();
  const globalState = new InMemoryMemento();
  const secrets = createSecretStorage();
  const environmentVariableCollection = createEnvironmentVariableCollection();
  const storagePath = path.join(extensionPath, ".tmp-storage");
  const globalStoragePath = path.join(extensionPath, ".tmp-global-storage");
  const logPath = path.join(extensionPath, ".tmp-log");

  const extensionExports: { context?: vscode.ExtensionContext } = {};

  const extension: vscode.Extension<unknown> = {
    id: "code-ingest.code-ingest",
    isActive: true,
    extensionPath,
    packageJSON: {},
    extensionUri,
    exports: extensionExports,
    activate: async () => extensionExports,
    extensionKind: vscode.ExtensionKind?.Workspace ?? 1,
    isReadonly: false
  } as vscode.Extension<unknown>;

  const context: vscode.ExtensionContext = {
    subscriptions,
    workspaceState,
    globalState,
    secrets,
    extensionPath,
    extensionUri,
    environmentVariableCollection,
  extensionMode: vscode.ExtensionMode?.Test ?? vscode.ExtensionMode.Production,
    storageUri: vscode.Uri.file(storagePath),
    globalStorageUri: vscode.Uri.file(globalStoragePath),
    logUri: vscode.Uri.file(logPath),
    storagePath,
    globalStoragePath,
    logPath,
    asAbsolutePath: (relativePath: string) => path.join(extensionPath, relativePath),
    extension
  } as unknown as vscode.ExtensionContext;

  extensionExports.context = context;

  const extensionsApi = vscode.extensions as unknown as {
    __register?: (ext: vscode.Extension<unknown>) => void;
  };
  extensionsApi.__register?.(extension);

  return context;
}

export async function activateExtension(context: vscode.ExtensionContext): Promise<vscode.ExtensionContext> {
  await activateExtensionInternal(context);
  return context;
}

export async function deactivateExtension(): Promise<void> {
  await deactivateExtensionInternal();
  const extensionsApi = vscode.extensions as unknown as {
    __reset?: () => void;
  };
  extensionsApi.__reset?.();
}

export function expectCommandRegistered(commandId: string): void {
  const commandsMock = vscode.commands as unknown as {
    __getRegisteredCommands?: () => Map<string, (...args: unknown[]) => unknown>;
  };

  const registry = commandsMock.__getRegisteredCommands?.();
  if (!registry) {
    throw new Error("VS Code command registry mock is not available.");
  }

  if (!registry.has(commandId)) {
    throw new Error(`Expected command "${commandId}" to be registered.`);
  }
}

export function getOutputChannel(name: string) {
  const windowMock = vscode.window as unknown as {
    __getOutputChannels?: () => Map<string, unknown>;
  };

  const channels = windowMock.__getOutputChannels?.();
  if (!channels) {
    throw new Error("Output channel registry mock is not available.");
  }

  return channels.get(name);
}

export function getRegisteredWebviewProviders(): Map<string, { provider: unknown; options: unknown }> {
  const windowMock = vscode.window as unknown as {
    __getRegisteredWebviewProviders?: () => Map<string, { provider: unknown; options: unknown }>;
  };
  return windowMock.__getRegisteredWebviewProviders?.() ?? new Map();
}

export function getCreatedWebviews(): unknown[] {
  const windowMock = vscode.window as unknown as {
    __getCreatedWebviews?: () => unknown[];
  };
  return windowMock.__getCreatedWebviews?.() ?? [];
}

export function mockWorkspaceFolders(workspaceRoot: string): () => void {
  const workspaceMock = vscode.workspace as unknown as {
    workspaceFolders: Array<{ uri: vscode.Uri; name: string }>;
    getWorkspaceFolder: (uri: vscode.Uri) => { uri: vscode.Uri; name: string } | undefined;
  };

  const folderUri = vscode.Uri.file(workspaceRoot);
  const folder = { uri: folderUri, name: path.basename(workspaceRoot) };

  const previousFolders = [...workspaceMock.workspaceFolders];
  const previousGetter = workspaceMock.getWorkspaceFolder;

  workspaceMock.workspaceFolders.splice(0, workspaceMock.workspaceFolders.length, folder);
  workspaceMock.getWorkspaceFolder = jest.fn(() => folder);

  return () => {
    workspaceMock.workspaceFolders.splice(0, workspaceMock.workspaceFolders.length, ...previousFolders);
    workspaceMock.getWorkspaceFolder = previousGetter;
  };
}