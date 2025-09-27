import * as vscode from 'vscode';
import { GitignoreService } from './services/gitignoreService';
import { Diagnostics } from './services/diagnostics';
import { WorkspaceManager } from './services/workspaceManager';
import { CodeIngestTreeProvider } from './tree/codeIngestTreeProvider';
import { registerAllCommands } from './commands';
import { WebviewPanelManager } from './webview/webviewPanelManager';

export function activate(context: vscode.ExtensionContext) {
  const diagnostics = new Diagnostics();
  const gitignoreService = new GitignoreService();
  const workspaceManager = new WorkspaceManager(diagnostics, gitignoreService);

  const treeProviders = new Map<string, CodeIngestTreeProvider>();

  const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
  for (const folder of workspaceFolders) {
    const provider = new CodeIngestTreeProvider(folder);
    treeProviders.set(folder.uri.fsPath, provider);

    const treeView = vscode.window.createTreeView('codeIngestExplorer', {
      treeDataProvider: provider,
      showCollapseAll: true
    });

    context.subscriptions.push(treeView);
  }

  const webviewPanelManager = new WebviewPanelManager(context.extensionUri);

  registerAllCommands(context, {
    diagnostics,
    gitignoreService,
    workspaceManager,
    webviewPanelManager,
    treeProviders
  });

  workspaceManager.initialize();

  console.log('Congratulations, your extension "Code Ingest" is now active!');

  context.subscriptions.push({ dispose: () => diagnostics.clear() });
}

export function deactivate() {}
