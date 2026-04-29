import * as vscode from "vscode";

export class CodeIngestTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData: vscode.Event<void> = this._onDidChangeTreeData.event;

  constructor(private readonly workspaceFolder: vscode.WorkspaceFolder) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (element) {
      return [];
    }

    const item = new vscode.TreeItem(this.workspaceFolder.name, vscode.TreeItemCollapsibleState.None);
    item.description = this.workspaceFolder.uri.fsPath;
    return [item];
  }
}