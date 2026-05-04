import * as path from "node:path";
import * as vscode from "vscode";

export interface FileWatcherOptions {
  workspaceRoot: vscode.Uri;
  relativePattern: vscode.RelativePattern;
  debounceMs?: number;
  onFilesChanged: (relativePaths: string[]) => Promise<void> | void;
  outputChannel?: { appendLine(message: string): void };
  isPaused?: () => boolean;
}

export class FileWatcher implements vscode.Disposable {
  private readonly watcher: vscode.FileSystemWatcher;
  private readonly pending = new Set<string>();
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly debounceMs: number;

  constructor(private readonly options: FileWatcherOptions) {
    this.debounceMs = options.debounceMs ?? 800;
    this.watcher = vscode.workspace.createFileSystemWatcher(options.relativePattern, false, false, false);
    this.watcher.onDidChange((uri) => this.enqueue(uri));
    this.watcher.onDidCreate((uri) => this.enqueue(uri));
    this.watcher.onDidDelete((uri) => this.enqueue(uri));
  }

  public dispose(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
    }
    this.watcher.dispose();
  }

  private enqueue(uri: vscode.Uri): void {
    const relativePath = path.relative(this.options.workspaceRoot.fsPath, uri.fsPath).replace(/\\/gu, "/");
    if (!relativePath || relativePath.startsWith(".vscode/code-ingest")) {
      return;
    }

    this.pending.add(relativePath);
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
    }

    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      if (this.options.isPaused?.()) {
        this.options.outputChannel?.appendLine(`[watcher] Paused due to git activity; holding ${this.pending.size} file(s).`);
        return;
      }
      const items = Array.from(this.pending.values());
      this.pending.clear();
      this.options.outputChannel?.appendLine(`[watcher] Reindexing ${items.length} changed file(s).`);
      void this.options.onFilesChanged(items);
    }, this.debounceMs);
  }
}
