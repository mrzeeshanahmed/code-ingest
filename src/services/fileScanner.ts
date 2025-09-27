import * as vscode from "vscode";

export interface FileNode {
  readonly uri: string;
  readonly name: string;
  readonly type: "file" | "directory";
  readonly children?: FileNode[];
  readonly placeholder?: boolean;
}

export class FileScanner {
  constructor(private readonly workspaceUri: vscode.Uri) {}

  async scan(): Promise<FileNode[]> {
    void this.workspaceUri;
    return [];
  }
}
