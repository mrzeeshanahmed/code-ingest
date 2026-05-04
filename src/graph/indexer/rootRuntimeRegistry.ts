import * as vscode from "vscode";
import { GraphDatabase } from "../database/GraphDatabase";
import { FileWatcher } from "./FileWatcher";
import { GitActivityMonitor } from "./GitActivityMonitor";
import { GraphIndexer } from "./GraphIndexer";

export interface RootRuntime {
  workspaceFolder: vscode.WorkspaceFolder;
  graphDatabase: GraphDatabase;
  fileWatcher: FileWatcher;
  gitActivityMonitor: GitActivityMonitor;
  graphIndexer: GraphIndexer;
  disposables: vscode.Disposable[];
}

export class RootRuntimeRegistry implements vscode.Disposable {
  private readonly runtimes = new Map<string, RootRuntime>();

  public getRuntime(rootUri: vscode.Uri): RootRuntime | undefined {
    return this.runtimes.get(rootUri.toString());
  }

  public hasRuntime(rootUri: vscode.Uri): boolean {
    return this.runtimes.has(rootUri.toString());
  }

  public register(runtime: RootRuntime): void {
    const key = runtime.workspaceFolder.uri.toString();
    const existing = this.runtimes.get(key);
    if (existing) {
      this.disposeRuntime(existing);
    }
    this.runtimes.set(key, runtime);
  }

  public unregister(rootUri: vscode.Uri): void {
    const runtime = this.runtimes.get(rootUri.toString());
    if (runtime) {
      this.disposeRuntime(runtime);
      this.runtimes.delete(rootUri.toString());
    }
  }

  public getAllRuntimes(): RootRuntime[] {
    return Array.from(this.runtimes.values());
  }

  public dispose(): void {
    for (const runtime of this.runtimes.values()) {
      this.disposeRuntime(runtime);
    }
    this.runtimes.clear();
  }

  private disposeRuntime(runtime: RootRuntime): void {
    runtime.fileWatcher.dispose();
    runtime.gitActivityMonitor.dispose();
    for (const disposable of runtime.disposables) {
      disposable.dispose();
    }
    runtime.graphDatabase.dispose();
  }
}
