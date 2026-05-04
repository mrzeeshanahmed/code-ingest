import * as vscode from "vscode";

export interface GitActivityMonitorOptions {
  onActivityStart?: () => void;
  onActivityEnd?: () => void;
  outputChannel?: { appendLine(message: string): void };
}

export class GitActivityMonitor implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private activeGitOperations = 0;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly debounceMs = 2000;

  constructor(private readonly options: GitActivityMonitorOptions = {}) {
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("git")) {
          this.options.outputChannel?.appendLine("[git-monitor] Git configuration changed.");
        }
      })
    );
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
