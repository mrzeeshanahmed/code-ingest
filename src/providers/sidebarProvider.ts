import * as fs from "node:fs/promises";
import * as vscode from "vscode";
import { GraphSettings } from "../config/constants";
import { setWebviewHtml } from "./webviewHelpers";

export interface SidebarState {
  status: "ready" | "indexing" | "partial" | "error";
  nodeCount: number;
  edgeCount: number;
  fileCount: number;
  lastIndexed?: number | null | undefined;
  databaseSizeBytes: number;
  activeFile?: string | undefined;
  dependencyCount: number;
  dependentCount: number;
  settings: Pick<GraphSettings, "hopDepth" | "defaultNodeMode" | "excludePatterns">;
}

interface SidebarProviderOptions {
  extensionUri: vscode.Uri;
  onRebuildGraph: () => Promise<void> | void;
  onOpenGraphView: (filePath?: string) => Promise<void> | void;
  onSendToChat: (filePath?: string) => Promise<void> | void;
  onOpenSettings: () => Promise<void> | void;
  onExport: (mode: "raw" | "clean" | "graph", piiPolicy?: string) => Promise<void> | void;
}

export class SidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "codeIngest.sidebarView";

  private view: vscode.WebviewView | undefined;
  private state: SidebarState | undefined;

  constructor(private readonly options: SidebarProviderOptions) {}

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.options.extensionUri, "out", "resources", "webview")]
    };

    setWebviewHtml(webviewView.webview, this.options.extensionUri, "out/resources/webview/sidebar/sidebar.html", {
      state: this.state
    });

    webviewView.webview.onDidReceiveMessage((message: unknown) => {
      void this.handleMessage(message);
    });

    if (this.state) {
      void this.postState();
    }
  }

  public setState(state: SidebarState): void {
    this.state = state;
    void this.postState();
  }

  private async postState(): Promise<void> {
    if (!this.view || !this.state) {
      return;
    }

    await this.view.webview.postMessage({
      type: "sidebar-state",
      payload: this.state
    });
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (!message || typeof message !== "object") {
      return;
    }

    const candidate = message as {
      type?: string;
      payload?: {
        filePath?: unknown;
        pattern?: unknown;
        section?: unknown;
        key?: unknown;
        value?: unknown;
        piiPolicy?: unknown;
      };
    };
    const payload = candidate.payload ?? {};

    switch (candidate.type) {
      case "rebuild-graph":
        await this.options.onRebuildGraph();
        break;
      case "open-graph-view":
        await this.options.onOpenGraphView(typeof payload.filePath === "string" ? payload.filePath : undefined);
        break;
      case "send-to-chat":
        await this.options.onSendToChat(typeof payload.filePath === "string" ? payload.filePath : undefined);
        break;
      case "open-settings":
        await this.options.onOpenSettings();
        break;
      case "edit-ignore":
        await this.openIgnoreFile();
        break;
      case "update-setting":
        await this.updateSetting(payload.section, payload.key, payload.value);
        break;
      case "add-exclude-pattern":
        await this.addExcludePattern(payload.pattern);
        break;
      case "remove-exclude-pattern":
        await this.removeExcludePattern(payload.pattern);
        break;
      case "export-raw":
        await this.options.onExport("raw");
        break;
      case "export-clean":
        await this.options.onExport("clean", typeof payload.piiPolicy === "string" ? payload.piiPolicy : undefined);
        break;
      case "export-graph":
        await this.options.onExport("graph", typeof payload.piiPolicy === "string" ? payload.piiPolicy : undefined);
        break;
      default:
        break;
    }
  }

  private async updateSetting(section: unknown, key: unknown, value: unknown): Promise<void> {
    if (typeof section !== "string" || typeof key !== "string") {
      return;
    }

    const folder = vscode.workspace.workspaceFolders?.[0];
    await vscode.workspace.getConfiguration(section, folder).update(key, value, vscode.ConfigurationTarget.Workspace);
  }

  private async addExcludePattern(pattern: unknown): Promise<void> {
    if (typeof pattern !== "string") {
      return;
    }

    const trimmed = pattern.trim();
    if (!trimmed) {
      return;
    }

    const folder = vscode.workspace.workspaceFolders?.[0];
    const configuration = vscode.workspace.getConfiguration("codeIngest.indexing", folder);
    const current = configuration.get<string[]>("excludePatterns", []);
    if (current.includes(trimmed)) {
      return;
    }

    await configuration.update("excludePatterns", [...current, trimmed], vscode.ConfigurationTarget.Workspace);
  }

  private async removeExcludePattern(pattern: unknown): Promise<void> {
    if (typeof pattern !== "string") {
      return;
    }

    const folder = vscode.workspace.workspaceFolders?.[0];
    const configuration = vscode.workspace.getConfiguration("codeIngest.indexing", folder);
    const current = configuration.get<string[]>("excludePatterns", []);
    await configuration.update(
      "excludePatterns",
      current.filter((entry) => entry !== pattern),
      vscode.ConfigurationTarget.Workspace
    );
  }

  private async openIgnoreFile(): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      return;
    }

    const uri = vscode.Uri.joinPath(folder.uri, ".codeingestignore");
    try {
      await vscode.workspace.fs.stat(uri);
    } catch {
      await fs.writeFile(uri.fsPath, "", "utf8");
    }
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: false });
  }
}
