import * as vscode from "vscode";
import { CodeIngestPanel } from "../providers/codeIngestPanel";

export class WebviewPanelManager {
  constructor(private readonly extensionUri: vscode.Uri) {}

  createAndShowPanel(): void {
    void CodeIngestPanel.createOrShow(this.extensionUri);
  }
}
