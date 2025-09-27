import * as path from "node:path";
import * as vscode from "vscode";
import { SelectionManager } from "./selectionManager";
import { ExpandState } from "./expandState";
import { createTreeIcon, formatTooltip } from "./treeHelpers";
import { FileScanner, type FileNode } from "../services/fileScanner";

export class CodeIngestTreeProvider implements vscode.TreeDataProvider<FileNode> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<FileNode | undefined>();

  readonly onDidChangeTreeData: vscode.Event<FileNode | undefined> = this.onDidChangeTreeDataEmitter.event;

  private readonly scanningPlaceholder: FileNode = {
    uri: "code-ingest://placeholder/scanning",
    name: "Scanning...",
    type: "file",
    placeholder: true
  };

  private rootNodes: FileNode[] | undefined;
  private scanning = false;
  private scanPromise: Promise<void> | undefined;

  constructor(
    private readonly workspaceFolderUri: vscode.Uri,
    private readonly fileScanner: FileScanner,
    private readonly selectionManager: SelectionManager,
    private readonly expandState: ExpandState
  ) {
    void this.workspaceFolderUri;
  }

  getTreeItem(element: FileNode): vscode.TreeItem {
    if (element.placeholder) {
      const placeholderItem = new vscode.TreeItem(element.name, vscode.TreeItemCollapsibleState.None);
      placeholderItem.contextValue = "codeIngest.placeholder";
      placeholderItem.iconPath = new vscode.ThemeIcon("sync");
      return placeholderItem;
    }

    const collapsibleState = element.type === "directory"
      ? this.expandState.isExpanded(element.uri)
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.None;

    const label = path.basename(vscode.Uri.parse(element.uri).fsPath) || element.name;
    const item = new vscode.TreeItem(label, collapsibleState);
    item.resourceUri = vscode.Uri.parse(element.uri);

    const isSelected = element.type === "file" && this.selectionManager.isSelected(element.uri);
    item.checkboxState = isSelected
      ? vscode.TreeItemCheckboxState.Checked
      : vscode.TreeItemCheckboxState.Unchecked;

    item.iconPath = createTreeIcon(element);
    item.tooltip = formatTooltip(element);

    if (element.type === "directory") {
      item.contextValue = "codeIngest.directory";
    } else {
      item.contextValue = isSelected ? "codeIngest.file.selected" : "codeIngest.file";
    }

    return item;
  }

  async getChildren(element?: FileNode): Promise<FileNode[]> {
    if (!element) {
      if (this.rootNodes) {
        return this.rootNodes;
      }

      if (this.scanning) {
        return [this.scanningPlaceholder];
      }

      void this.ensureScan();
      return [this.scanningPlaceholder];
    }

    if (element.type === "directory") {
      return element.children ?? [];
    }

    return [];
  }

  refresh(): void {
    this.rootNodes = undefined;
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  dispose(): void {
    this.onDidChangeTreeDataEmitter.dispose();
  }

  private ensureScan(): Promise<void> {
    if (this.scanPromise) {
      return this.scanPromise;
    }

    this.scanning = true;
    this.scanPromise = this.fileScanner
      .scan()
      .then((nodes) => {
        this.rootNodes = nodes;
      })
      .catch((error) => {
        console.error("CodeIngestTreeProvider: scan failed", error);
        this.rootNodes = [];
      })
      .finally(() => {
        this.scanning = false;
        this.scanPromise = undefined;
        this.onDidChangeTreeDataEmitter.fire(undefined);
      });

    return this.scanPromise;
  }
}
