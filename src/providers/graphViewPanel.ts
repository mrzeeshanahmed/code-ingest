import * as path from "node:path";
import * as vscode from "vscode";
import { GraphSettings } from "../config/constants";
import { setWebviewHtml } from "./webviewHelpers";
import { GraphDatabase } from "../graph/database/GraphDatabase";
import { GraphTraversal } from "../graph/traversal/GraphTraversal";

interface GraphViewPanelOptions {
  extensionUri: vscode.Uri;
  getGraphDatabase: () => GraphDatabase;
  getTraversal: () => GraphTraversal;
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

  private get graphDatabase(): GraphDatabase { return this.options.getGraphDatabase(); }
  private get traversal(): GraphTraversal { return this.options.getTraversal(); }

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
    const allSnapshot = this.graphDatabase.getGraphSnapshot(nodeMode);
    let snapshot = this.showFullGraph ? allSnapshot : this.graphDatabase.getGraphSnapshot(nodeMode, settings.maxNodes);
    let truncated = !this.showFullGraph && allSnapshot.nodes.length > settings.maxNodes;

    if (truncated) {
      let focusRelativePath: string | undefined;
      if (this.currentFocusFile) {
        const matchedFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(this.currentFocusFile));
        focusRelativePath = matchedFolder
          ? path.relative(matchedFolder.uri.fsPath, this.currentFocusFile).replace(/\\/gu, "/")
          : undefined;
      }
      const focusNode = focusRelativePath ? this.graphDatabase.getNodeByRelativePath(focusRelativePath) : undefined;
      if (focusNode) {
        const ego = this.traversal.bfs(focusNode.id, 2, "both");
        snapshot = {
          nodes: ego.nodes,
          edges: ego.edges
        };
      }
    }

    const stats = this.graphDatabase.getStats();
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

    if (!vscode.workspace.isTrusted) {
      return;
    }

    const candidate = message as { type?: string; payload?: Record<string, unknown> };
    const payload = candidate.payload ?? {};

    // Helper to validate file paths are inside the workspace.
    const isValidFilePath = (filePath: string): boolean => {
      if (!filePath || typeof filePath !== "string") {
        return false;
      }
      const folders = vscode.workspace.workspaceFolders;
      if (!folders) {
        return false;
      }
      return folders.some((folder) => {
        const rel = path.relative(folder.uri.fsPath, filePath);
        return !rel.startsWith("..") && !path.isAbsolute(rel);
      });
    };

    switch (candidate.type) {
      case "ready":
        await this.loadGraph();
        break;
      case "open-file": {
        const openFp = String(payload.filePath ?? "");
        if (isValidFilePath(openFp)) {
          await this.openFile(openFp, typeof payload.line === "number" ? payload.line : undefined);
        }
        break;
      }
      case "focus-file": {
        const focusFp = String(payload.filePath ?? "");
        if (isValidFilePath(focusFp)) {
          await this.focusFile(focusFp);
        }
        break;
      }
      case "expand-node": {
        const expandFp = String(payload.filePath ?? "");
        if (isValidFilePath(expandFp)) {
          await this.focusFile(expandFp);
        }
        break;
      }
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
