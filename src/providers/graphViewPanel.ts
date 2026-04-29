import * as path from "node:path";
import * as vscode from "vscode";
import { GraphSettings } from "../config/constants";
import { setWebviewHtml } from "./webviewHelpers";
import { GraphDatabase } from "../graph/database/GraphDatabase";
import { GraphTraversal } from "../graph/traversal/GraphTraversal";

interface GraphViewPanelOptions {
  extensionUri: vscode.Uri;
  graphDatabase: GraphDatabase;
  traversal: GraphTraversal;
  getSettings: () => GraphSettings;
  outputChannel?: { appendLine(message: string): void };
  onSendToChat?: (filePath?: string | string[]) => Promise<void> | void;
}

export class GraphViewPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private currentFocusFile: string | undefined;
  private currentNodeMode: GraphSettings["defaultNodeMode"] | undefined;
  private currentLayout: GraphSettings["layout"] | undefined;
  private showFullGraph = false;

  constructor(private readonly options: GraphViewPanelOptions) {}

  public dispose(): void {
    this.panel?.dispose();
    this.panel = undefined;
  }

  public async createOrShow(focusFile?: string): Promise<void> {
    if (focusFile) {
      this.currentFocusFile = focusFile;
      this.showFullGraph = false;
    } else {
      this.currentFocusFile = this.currentFocusFile ?? vscode.window.activeTextEditor?.document.uri.fsPath;
    }

    const settings = this.options.getSettings();
    this.currentNodeMode = this.currentNodeMode ?? settings.defaultNodeMode;
    this.currentLayout = this.currentLayout ?? settings.layout;

    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.One);
      await this.loadGraph();
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      "codeIngestGraphView",
      "Code-Ingest Graph",
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

    setWebviewHtml(this.panel.webview, this.options.extensionUri, "out/resources/webview/graph/graphView.html", {
      focusFile: this.currentFocusFile
    });

    await this.loadGraph();
  }

  public async refresh(): Promise<void> {
    if (!this.panel) {
      return;
    }

    await this.loadGraph();
  }

  public async focusFile(filePath?: string): Promise<void> {
    if (filePath) {
      this.currentFocusFile = filePath;
      this.showFullGraph = false;
    }

    await this.createOrShow(this.currentFocusFile);
  }

  public async exportPng(): Promise<void> {
    if (!this.panel) {
      return;
    }

    await this.panel.webview.postMessage({ type: "request-export-png" });
  }

  private async loadGraph(): Promise<void> {
    if (!this.panel) {
      return;
    }

    const settings = this.options.getSettings();
    const nodeMode = this.currentNodeMode ?? settings.defaultNodeMode;
    const layout = this.currentLayout ?? settings.layout;
    const allSnapshot = this.options.graphDatabase.getGraphSnapshot(nodeMode);
    let snapshot = this.showFullGraph ? allSnapshot : this.options.graphDatabase.getGraphSnapshot(nodeMode, settings.maxNodes);
    let truncated = !this.showFullGraph && allSnapshot.nodes.length > settings.maxNodes;

    if (truncated) {
      const focusRelativePath = this.currentFocusFile
        ? path.relative(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "", this.currentFocusFile).replace(/\\/gu, "/")
        : undefined;
      const focusNode = focusRelativePath ? this.options.graphDatabase.getNodeByRelativePath(focusRelativePath) : undefined;
      if (focusNode) {
        const ego = this.options.traversal.bfs(focusNode.id, 2, "both");
        snapshot = {
          nodes: ego.nodes,
          edges: ego.edges
        };
      }
    }

    const stats = this.options.graphDatabase.getStats();
    const ramEstimateMb = this.estimateGraphMemoryMb(allSnapshot.nodes.length, allSnapshot.edges.length);
    await this.panel.webview.postMessage({
      type: "load-graph",
      payload: {
        nodes: snapshot.nodes,
        edges: snapshot.edges,
        stats,
        focusFile: this.currentFocusFile,
        layout,
        nodeMode,
        truncated,
        fullGraphLoaded: this.showFullGraph,
        maxNodes: settings.maxNodes
        ,
        ramEstimateMb,
        focusModeOpacity: settings.focusModeOpacity
      }
    });
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (!message || typeof message !== "object") {
      return;
    }

    const candidate = message as { type?: string; payload?: Record<string, unknown> };
    const payload = candidate.payload ?? {};

    switch (candidate.type) {
      case "ready":
        await this.loadGraph();
        break;
      case "open-file":
        await this.openFile(String(payload.filePath ?? ""), typeof payload.line === "number" ? payload.line : undefined);
        break;
      case "focus-file":
        await this.focusFile(String(payload.filePath ?? ""));
        break;
      case "expand-node":
        await this.focusFile(String(payload.filePath ?? ""));
        break;
      case "send-to-chat":
        await this.options.onSendToChat?.(
          Array.isArray(payload.filePaths)
            ? payload.filePaths.filter((value): value is string => typeof value === "string")
            : typeof payload.filePath === "string"
              ? payload.filePath
              : undefined
        );
        break;
      case "graph-mode-change":
        if (payload.mode === "file" || payload.mode === "function") {
          this.currentNodeMode = payload.mode;
          this.showFullGraph = false;
          await this.loadGraph();
        }
        break;
      case "layout-change":
        if (payload.layout === "cose" || payload.layout === "radial") {
          this.currentLayout = payload.layout;
          await this.loadGraph();
        }
        break;
      case "load-full-graph":
        this.showFullGraph = true;
        await this.loadGraph();
        break;
      case "copy-path":
        if (typeof payload.filePath === "string") {
          await vscode.env.clipboard.writeText(payload.filePath);
        }
        break;
      case "show-in-explorer":
        if (typeof payload.filePath === "string") {
          const uri = vscode.Uri.file(payload.filePath);
          await vscode.commands.executeCommand("revealInExplorer", uri);
        }
        break;
      case "export-png-result":
        if (typeof payload.dataUrl === "string") {
          await this.savePng(payload.dataUrl);
        }
        break;
      default:
        break;
    }
  }

  private async openFile(filePath: string, line?: number): Promise<void> {
    if (!filePath) {
      return;
    }

    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    const editor = await vscode.window.showTextDocument(document, { preview: false });
    if (typeof line === "number" && line > 0) {
      const position = new vscode.Position(Math.max(0, line - 1), 0);
      editor.selection = new vscode.Selection(position, position);
      editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
    }
  }

  private async savePng(dataUrl: string): Promise<void> {
    const destination = await vscode.window.showSaveDialog({
      filters: { PNG: ["png"] },
      saveLabel: "Export Graph as PNG"
    });

    if (!destination) {
      return;
    }

    const base64 = dataUrl.replace(/^data:image\/png;base64,/u, "");
    const bytes = Buffer.from(base64, "base64");
    await vscode.workspace.fs.writeFile(destination, bytes);
    void vscode.window.showInformationMessage(`Graph exported to ${destination.fsPath}`);
  }

  private estimateGraphMemoryMb(nodeCount: number, edgeCount: number): number {
    return Number(((nodeCount * 0.006) + (edgeCount * 0.002)).toFixed(1));
  }
}
