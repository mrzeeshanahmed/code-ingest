import * as vscode from "vscode";
import { GraphSettings } from "../config/constants";
import { setWebviewHtml } from "./webviewHelpers";

interface SettingsProviderOptions {
  extensionUri: vscode.Uri;
  getSettings: () => GraphSettings;
}

export class SettingsProvider implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;

  constructor(private readonly options: SettingsProviderOptions) {}

  public dispose(): void {
    this.panel?.dispose();
    this.panel = undefined;
  }

  public async createOrShow(): Promise<void> {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.One);
      await this.postState();
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      "codeIngestSettings",
      "Code-Ingest Settings",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.options.extensionUri, "out", "resources", "webview")]
      }
    );

    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });

    this.panel.webview.onDidReceiveMessage((message: unknown) => {
      void this.handleMessage(message);
    });

    setWebviewHtml(this.panel.webview, this.options.extensionUri, "out/resources/webview/settings/settings.html", {
      settings: this.options.getSettings()
    });
    await this.postState();
  }

  public async postState(): Promise<void> {
    if (!this.panel) {
      return;
    }

    await this.panel.webview.postMessage({
      type: "settings-state",
      payload: this.options.getSettings()
    });
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (!message || typeof message !== "object") {
      return;
    }

    const candidate = message as { type?: string; payload?: { section?: string; key?: string; value?: unknown } };
    if (candidate.type !== "update-setting" || !candidate.payload) {
      return;
    }

    const section = candidate.payload.section;
    const key = candidate.payload.key;
    if (!section || !key) {
      return;
    }

    const folder = vscode.workspace.workspaceFolders?.[0];
    await vscode.workspace.getConfiguration(section, folder).update(key, candidate.payload.value, vscode.ConfigurationTarget.Workspace);
    await this.postState();
  }
}
