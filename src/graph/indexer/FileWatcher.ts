import * as path from "node:path";
import * as vscode from "vscode";

export interface FileWatcherOptions {
  workspaceRoot: vscode.Uri;
  debounceMs: number;
  onFilesChanged: (relativePaths: string[]) => Promise<void> | void;
  outputChannel?: { appendLine(message: string): void };
}

export class FileWatcher implements vscode.Disposable {
  private readonly watcher: vscode.FileSystemWatcher;
  private readonly pending = new Set<string>();
  private flushTimer: NodeJS.Timeout | undefined;

  constructor(private readonly options: FileWatcherOptions) {
    this.watcher = vscode.workspace.createFileSystemWatcher("**/*", false, false, false);
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
      const items = Array.from(this.pending.values());
      this.pending.clear();
      this.flushTimer = undefined;
      this.options.outputChannel?.appendLine(`[watcher] Reindexing ${items.length} changed file(s).`);
      void this.options.onFilesChanged(items);
    }, this.options.debounceMs);
  }
}
