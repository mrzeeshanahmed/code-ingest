import * as vscode from "vscode";
import { GraphDatabase } from "../database/GraphDatabase";
import { FileWatcher } from "./FileWatcher";
import { GitActivityMonitor } from "./GitActivityMonitor";
import { GraphIndexer } from "./GraphIndexer";
import { KnowledgeService } from "../semantic/KnowledgeService";

export interface RootRuntime {
  workspaceFolder: vscode.WorkspaceFolder;
  graphDatabase: GraphDatabase;
  fileWatcher: FileWatcher;
  gitActivityMonitor: GitActivityMonitor;
  graphIndexer: GraphIndexer;
  knowledgeService: KnowledgeService;
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

  public async register(runtime: RootRuntime): Promise<void> {
    const key = runtime.workspaceFolder.uri.toString();
    const existing = this.runtimes.get(key);
    if (existing) {
      await this.disposeRuntime(existing);
    }
    this.runtimes.set(key, runtime);
  }

  public async unregister(rootUri: vscode.Uri): Promise<void> {
    const runtime = this.runtimes.get(rootUri.toString());
    if (runtime) {
      await this.disposeRuntime(runtime);
      this.runtimes.delete(rootUri.toString());
    }
  }

  public getAllRuntimes(): RootRuntime[] {
    return Array.from(this.runtimes.values());
  }

  public dispose(): void {
    // Fire-and-forget: disposal is best-effort. The async disposeRuntime
    // calls are started but may not complete before process exit.
    // This is acceptable since the VFS and WASM runtime will clean up
    // on process termination regardless.
    for (const runtime of this.runtimes.values()) {
      this.disposeRuntime(runtime);
    }
    this.runtimes.clear();
  }

  private async disposeRuntime(runtime: RootRuntime): Promise<void> {
    runtime.fileWatcher.dispose();
    runtime.gitActivityMonitor.dispose();
    for (const disposable of runtime.disposables) {
      disposable.dispose();
    }
    await runtime.graphDatabase.dispose();
  }
}
