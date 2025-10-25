import { beforeEach, describe, expect, jest, test } from "@jest/globals";
import * as path from "node:path";
import * as vscode from "vscode";

import {
  SelectionManager,
  type SelectionChangeEvent,
  type SelectionManagerOptions,
  type SelectionState
} from "../../providers/selectionManager";
import type { FileNode } from "../../services/fileScanner";

class InMemoryMemento implements vscode.Memento {
  private readonly store = new Map<string, unknown>();

  get<T>(key: string, defaultValue?: T): T {
    if (this.store.has(key)) {
      return this.store.get(key) as T;
    }
    return defaultValue as T;
  }

  update(key: string, value: unknown): Thenable<void> {
    if (value === undefined) {
      this.store.delete(key);
    } else {
      this.store.set(key, value);
    }
    return Promise.resolve();
  }

  keys(): readonly string[] {
    return [...this.store.keys()];
  }
}

const workspaceRoot = path.resolve("/__workspace__");
const fileAUri = vscode.Uri.file(path.join(workspaceRoot, "src", "a.ts"));
const fileBUri = vscode.Uri.file(path.join(workspaceRoot, "src", "b.ts"));
const fileCUri = vscode.Uri.file(path.join(workspaceRoot, "src", "c.ts"));

function createManager(overrides: Partial<SelectionManagerOptions> = {}) {
  const storage = overrides.storage ?? new InMemoryMemento();
  const manager = new SelectionManager({
    workspaceRoot,
    storage,
    validatePathExists: () => true,
    ...overrides
  });
  return { manager, storage };
}

describe("SelectionManager", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("selecting a file emits change and persists state", async () => {
    const { manager, storage } = createManager();
    const events: SelectionChangeEvent[] = [];
    manager.onDidChangeSelection((event) => events.push(event));

    manager.selectFile(fileAUri.toString());

    expect(events).toHaveLength(1);
    expect(events[0]?.files).toEqual([fileAUri.toString()]);
    expect(events[0]?.relativeFiles).toEqual(["src/a.ts"]);

    await manager.saveState();

    const [storageKey] = storage.keys();
    expect(storageKey).toBeDefined();
    const stored = storage.get<{ selected: string[] }>(storageKey);
    expect(stored?.selected).toContain("src/a.ts");

    manager.dispose();
  });

  test("enforces selection limits and warns when exceeded", () => {
    const { manager } = createManager({ maxSelection: 2 });

    manager.selectFile(fileAUri.toString());
    manager.selectFile(fileBUri.toString());
    manager.selectFile(fileCUri.toString());

    expect(manager.getSelectedUris()).toHaveLength(2);
    expect(vscode.window.showWarningMessage).toHaveBeenCalled();

    manager.dispose();
  });

  test("invalid regex pattern reports an error and keeps selection unchanged", async () => {
    const fileNodes: FileNode[] = [
      {
        uri: fileAUri.toString(),
        name: "a.ts",
        type: "file",
        relPath: "src/a.ts"
      }
    ];
    const scan = jest.fn(async () => fileNodes);

    const { manager } = createManager({ fileScanner: { scan } });

    await manager.selectPattern("[", "regex");

    expect(scan).toHaveBeenCalled();
    expect(vscode.window.showErrorMessage).toHaveBeenCalled();
    expect(manager.getSelectedUris()).toHaveLength(0);

    manager.dispose();
  });

  test("restores persisted timestamp without scheduling an immediate save", async () => {
    jest.useFakeTimers();

    const storage = new InMemoryMemento();
    const rootKey = Buffer.from(workspaceRoot).toString("base64url");
    const storageKey = `code-ingest.selection.${rootKey}`;
    const persistedTimestamp = new Date("2024-02-01T12:34:56.000Z");

    await storage.update(storageKey, {
      workspaceRoot,
      selected: ["src/a.ts"],
      preview: [],
      excluded: [],
      lastModified: persistedTimestamp.toISOString()
    });

    const updateSpy = jest.spyOn(storage, "update");
    let restoredManager: SelectionManager | undefined;

    try {
      const statePromise = new Promise<SelectionState>((resolve) => {
        restoredManager = new SelectionManager({
          workspaceRoot,
          storage,
          validatePathExists: () => true,
          autoSaveDebounceMs: 5,
          onStateApplied: (state) => resolve(state)
        });
      });

      const restoredState = await statePromise;

      expect(restoredState.lastModified.toISOString()).toBe(persistedTimestamp.toISOString());
      expect(restoredManager?.getStateSnapshot().lastModified.toISOString()).toBe(
        persistedTimestamp.toISOString()
      );
      expect(restoredManager?.getSelectedUris()).toEqual([fileAUri.toString()]);

      expect(updateSpy).not.toHaveBeenCalled();

      jest.runOnlyPendingTimers();
      await Promise.resolve();

      expect(updateSpy).not.toHaveBeenCalled();
    } finally {
      updateSpy.mockRestore();
      restoredManager?.dispose();
      jest.useRealTimers();
    }
  });
});
