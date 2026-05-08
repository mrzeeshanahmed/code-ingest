import * as vscode from "vscode";

export interface GitActivityMonitorOptions {
  workspaceRoot?: string;
  onActivityStart?: () => void;
  onActivityEnd?: () => void;
  outputChannel?: { appendLine(message: string): void };
}

export class GitActivityMonitor implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private activeGitOperations = 0;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly debounceMs = 2000;
  private lastHead: string | undefined;

  constructor(private readonly options: GitActivityMonitorOptions = {}) {
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("git")) {
          this.options.outputChannel?.appendLine("[git-monitor] Git configuration changed.");
        }
      })
    );

    // Watch .git/HEAD for branch switches when workspace root is known.
    if (options.workspaceRoot) {
      const headPattern = new vscode.RelativePattern(options.workspaceRoot, ".git/HEAD");
      const headWatcher = vscode.workspace.createFileSystemWatcher(headPattern);
      this.disposables.push(
        headWatcher.onDidChange(async () => {
          try {
            const headUri = vscode.Uri.file(`${options.workspaceRoot}/.git/HEAD`);
            const content = await vscode.workspace.fs.readFile(headUri);
            const newHead = Buffer.from(content).toString("utf8").trim();
            if (this.lastHead !== undefined && this.lastHead !== newHead) {
              this.options.outputChannel?.appendLine(`[git-monitor] Git HEAD changed: ${this.lastHead} → ${newHead}`);
              this.notifyGitOperationStart();
              this.resetTimer();
            }
            this.lastHead = newHead;
          } catch {
            // Ignore read errors
          }
        })
      );
      this.disposables.push(headWatcher);
    }

    // Attempt to integrate with VS Code Git extension API for operation events.
    this.trySubscribeToGitExtension();
  }

  private trySubscribeToGitExtension(): void {
    try {
      const gitExtension = vscode.extensions.getExtension("vscode.git");
      if (!gitExtension) {
        return;
      }
      const git = gitExtension.exports;
      if (typeof git?.getAPI === "function") {
        const api = git.getAPI(1);
        if (api?.onDidChangeState) {
          this.disposables.push(
            api.onDidChangeState((state: string) => {
              if (state === "operation") {
                this.notifyGitOperationStart();
              } else if (state === "idle") {
                this.notifyGitOperationEnd();
              }
            })
          );
        }
      }
    } catch {
      // VS Code Git extension API is optional; ignore errors.
    }
  }

  public isGitActive(): boolean {
    return this.activeGitOperations > 0;
  }

  public notifyGitOperationStart(): void {
    if (this.activeGitOperations === 0) {
      this.options.onActivityStart?.();
    }
    this.activeGitOperations += 1;
    this.resetTimer();
  }

  public notifyGitOperationEnd(): void {
    this.activeGitOperations = Math.max(0, this.activeGitOperations - 1);
    if (this.activeGitOperations === 0) {
      this.resetTimer();
    }
  }

  private resetTimer(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
    }
    this.flushTimer = setTimeout(() => {
      if (this.activeGitOperations === 0) {
        this.options.onActivityEnd?.();
      }
      this.flushTimer = undefined;
    }, this.debounceMs);
  }

  public dispose(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
    }
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }
}
