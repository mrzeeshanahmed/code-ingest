import * as vscode from "vscode";
import { FileWatcher } from "../../graph/indexer/FileWatcher";

describe("FileWatcher", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  test("batches and de-duplicates file changes", async () => {
    const onFilesChanged = jest.fn();
    const watcher = new FileWatcher({
      workspaceRoot: vscode.Uri.file("E:/workspace"),
      debounceMs: 50,
      onFilesChanged
    });

    const createdWatchers = Array.from((vscode.workspace as unknown as { __getFileSystemWatchers: () => Set<unknown> }).__getFileSystemWatchers());
    const rawWatcher = createdWatchers[0] as {
      __fireChange: (uri: vscode.Uri) => void;
      __fireCreate: (uri: vscode.Uri) => void;
    };

    rawWatcher.__fireChange(vscode.Uri.file("E:/workspace/src/index.ts"));
    rawWatcher.__fireCreate(vscode.Uri.file("E:/workspace/src/index.ts"));
    rawWatcher.__fireChange(vscode.Uri.file("E:/workspace/src/dep.ts"));
    rawWatcher.__fireChange(vscode.Uri.file("E:/workspace/.vscode/code-ingest/graph.db"));

    jest.advanceTimersByTime(60);
    await Promise.resolve();

    expect(onFilesChanged).toHaveBeenCalledTimes(1);
    expect(onFilesChanged).toHaveBeenCalledWith(["src/index.ts", "src/dep.ts"]);

    watcher.dispose();
  });

  test("cancels pending work on dispose", () => {
    const onFilesChanged = jest.fn();
    const watcher = new FileWatcher({
      workspaceRoot: vscode.Uri.file("E:/workspace"),
      debounceMs: 50,
      onFilesChanged
    });

    const createdWatchers = Array.from((vscode.workspace as unknown as { __getFileSystemWatchers: () => Set<unknown> }).__getFileSystemWatchers());
    const rawWatcher = createdWatchers[0] as {
      __fireDelete: (uri: vscode.Uri) => void;
    };

    rawWatcher.__fireDelete(vscode.Uri.file("E:/workspace/src/index.ts"));
    watcher.dispose();
    jest.advanceTimersByTime(60);

    expect(onFilesChanged).not.toHaveBeenCalled();
  });
});
