import * as crypto from "node:crypto";
import * as path from "node:path";
import * as vscode from "vscode";
import { GraphSettings } from "../config/constants";
import { GraphDatabase } from "../graph/database/GraphDatabase";
import { GraphNode } from "../graph/models/Node";
import { ContextBuilder } from "../graph/traversal/ContextBuilder";
import { GraphTraversal, SubGraph } from "../graph/traversal/GraphTraversal";
import { resolveLanguageModel as defaultResolveLanguageModel, formatContextFooter } from "../graph/traversal/languageModelResolver";
import { EmbeddingService } from "./embeddingService";

interface CopilotParticipantOptions {
  extensionUri: vscode.Uri;
  getGraphDatabase: () => GraphDatabase;
  getTraversal: () => GraphTraversal;
  getContextBuilder: () => ContextBuilder;
  getEmbeddingService: () => EmbeddingService;
  getSettings: () => GraphSettings;
  outputChannel?: { appendLine(message: string): void };
  onFocusFile?: (filePath: string) => Promise<void> | void;
  resolveLanguageModel?: (modelFamily: string, token: vscode.CancellationToken) => Promise<vscode.LanguageModelChat | undefined>;
}

interface ParsedRequest {
  command: "context" | "focus" | "impact" | "explain" | "depth" | "search" | "audit" | "export";
  argument?: string | undefined;
  remainingText?: string | undefined;
}

export class CopilotParticipant implements vscode.Disposable {
  private disposable: vscode.Disposable | undefined;

  constructor(private readonly options: CopilotParticipantOptions) {}

  public register(): void {
    const chatApi = (vscode as unknown as {
      chat?: {
        createChatParticipant?: (
          id: string,
          handler: (request: unknown, context: unknown, stream: unknown, token: vscode.CancellationToken) => Promise<void>
        ) => vscode.Disposable & { iconPath?: vscode.Uri };
      };
    }).chat;

    if (typeof chatApi?.createChatParticipant !== "function") {
      this.options.outputChannel?.appendLine("[copilot] Chat participant API unavailable; skipping registration.");
      return;
    }

    const participant = chatApi.createChatParticipant("code-ingest", async (request, context, stream, token) => {
      await this.handleRequest(request, context, stream, token);
    });
    participant.iconPath = vscode.Uri.joinPath(this.options.extensionUri, "assets", "icon.svg");
    this.disposable = participant;
  }

  public dispose(): void {
    this.disposable?.dispose();
  }

  public async createContextPayload(
    target?: string | string[],
    direction: "both" | "incoming" | "outgoing" = "both",
    depth = this.options.getSettings().hopDepth,
    semanticQuery?: string
  ): Promise<string> {
    const result = await this.createContextResult(target, direction, depth, semanticQuery);
    return result.payload;
  }

  private async createContextResult(
    target?: string | string[],
    direction: "both" | "incoming" | "outgoing" = "both",
    depth = this.options.getSettings().hopDepth,
    semanticQuery?: string
  ): Promise<{ payload: string; tokenEstimate: number; includedNodeIds: string[]; droppedNodeIds: string[] }> {
    const nodes = this.resolveTargetNodes(target);
    if (nodes.length === 0) {
      return { payload: "No active file available for graph context.", tokenEstimate: 0, includedNodeIds: [], droppedNodeIds: [] };
    }

    const subGraph = this.mergeSubGraphs(nodes, depth, direction);
    const semanticMatches = semanticQuery
      ? await this.options.getEmbeddingService().search(semanticQuery, this.options.getSettings().semanticResultCount)
      : [];

    const queryOrigin = nodes.map((node) => node.relativePath).join(", ");
    const context = await this.options.getContextBuilder().build(queryOrigin, subGraph, semanticMatches, {
      depth,
      direction: direction === "both" ? "bidirectional" : direction
    });
    return {
      payload: context.payload,
      tokenEstimate: context.tokenEstimate,
      includedNodeIds: context.includedNodeIds,
      droppedNodeIds: context.droppedNodeIds
    };
  }

  private async handleRequest(
    request: unknown,
    _context: unknown,
    stream: unknown,
    token: vscode.CancellationToken
  ): Promise<void> {
    void _context;

    const typedStream = stream as {
      markdown?: (value: string) => void;
      write?: (value: string) => void;
      progress?: (value: string) => void;
    };

    // Pre-flight checks
    if (!vscode.workspace.isTrusted) {
      this.writeMarkdown(typedStream, "This workspace is not trusted. Code-Ingest requires a trusted workspace to access graph features.");
      return;
    }

    const db = this.options.getGraphDatabase();
    const indexState = db.getIndexState();
    if (!indexState || indexState.nodeCount === 0) {
      this.writeMarkdown(typedStream, "The graph is not initialized yet. Run **Code-Ingest: Initialize Codebase** from the command palette to build the graph.");
      return;
    }

    const parsed = this.parseRequest(request);
    const typedRequest = request as { model?: { family?: string } };
    const modelFamily = typedRequest.model?.family ?? "gpt-4";

    typedStream.progress?.("Resolving language model...");
    const resolveLm = this.options.resolveLanguageModel ?? defaultResolveLanguageModel;
    const model = await resolveLm(modelFamily, token);
    if (!model) {
      this.writeMarkdown(typedStream, `Unable to resolve a Copilot chat model for family "${modelFamily}". Please check your Copilot subscription and VS Code version.`);
      return;
    }

    if (token.isCancellationRequested) {
      this.writeMarkdown(typedStream, "Retrieval cancelled.");
      return;
    }

    if (parsed.command === "export") {
      const contextResult = await this.createContextResult(parsed.argument, "both", this.options.getSettings().hopDepth, parsed.remainingText);
      this.writeMarkdown(typedStream, contextResult.payload);
      this.writeFooter(typedStream, parsed, contextResult.payload, contextResult.tokenEstimate);
      return;
    }

    if (parsed.command === "focus") {
      if (!parsed.argument) {
        this.writeMarkdown(typedStream, "Provide a file path to focus the graph.");
      } else {
        await this.options.onFocusFile?.(parsed.argument);
        this.writeMarkdown(typedStream, `Focused graph view on \`${parsed.argument}\`.`);
      }
      return;
    }

    if (parsed.command === "search") {
      typedStream.progress?.("Searching semantic index...");
      const matches = await this.options.getEmbeddingService().search(parsed.argument ?? parsed.remainingText ?? "", this.options.getSettings().semanticResultCount);
      if (matches.length === 0) {
        this.writeMarkdown(typedStream, "No semantic matches found.");
      } else {
        this.writeMarkdown(typedStream, matches.map((match) => `- \`${match.node.relativePath}\` (${match.distance.toFixed(4)})`).join("\n"));
      }
      return;
    }

    typedStream.progress?.("Ranking graph neighborhood...");
    const contextResult = await this.createContextResult(
      parsed.argument,
      parsed.command === "impact" ? "incoming" : "both",
      parsed.command === "depth" && parsed.argument ? Number(parsed.argument) : this.options.getSettings().hopDepth,
      parsed.remainingText
    );

    if (token.isCancellationRequested) {
      this.writeMarkdown(typedStream, "Retrieval cancelled.");
      return;
    }

    typedStream.progress?.("Compressing context...");

    try {
      const response = await model.sendRequest(
        [vscode.LanguageModelChatMessage.User(contextResult.payload)],
        {},
        token
      );

      for await (const fragment of response.text) {
        if (token.isCancellationRequested) {
          break;
        }
        this.writeMarkdown(typedStream, fragment);
      }
    } catch (error) {
      this.options.outputChannel?.appendLine(`[copilot] sendRequest failed: ${(error as Error).message}`);
      this.writeMarkdown(typedStream, contextResult.payload);
    }

    this.writeFooter(typedStream, parsed, contextResult.payload, contextResult.tokenEstimate);
  }

  private writeFooter(
    stream: { markdown?: (value: string) => void; write?: (value: string) => void },
    parsed: ParsedRequest,
    payload: string,
    promptTokens = 0
  ): void {
    const files = this.extractFilesFromPayload(payload);
    const footer = formatContextFooter({
      files,
      nodeCount: files.length,
      depth: parsed.command === "depth" && parsed.argument ? Number(parsed.argument) : this.options.getSettings().hopDepth,
      semanticMatches: Boolean(parsed.remainingText),
      promptTokens,
      piiPolicy: "strict"
    });
    this.writeMarkdown(stream, footer);
  }

  private extractFilesFromPayload(payload: string): string[] {
    const matches = payload.match(/`([^`]+\.(?:ts|tsx|js|jsx|py|java|go|rs|md|json))`/gu);
    return matches ? matches.map((m) => m.slice(1, -1)) : [];
  }

  private parseRequest(request: unknown): ParsedRequest {
    const candidate = request as { command?: { name?: string }; prompt?: string; text?: string };
    const commandName = candidate.command?.name;
    if (typeof commandName === "string" && commandName) {
      return {
        command: commandName as ParsedRequest["command"],
        argument: candidate.prompt
      };
    }

    const text = typeof candidate.prompt === "string" ? candidate.prompt : typeof candidate.text === "string" ? candidate.text : "";
    const slashMatch = text.trim().match(/^\/(context|focus|impact|explain|depth|search|audit|export)\s*(.*)$/u);
    if (slashMatch) {
      const payload = slashMatch[2]?.trim();
      if (slashMatch[1] === "depth") {
        const [depthToken, ...rest] = (payload ?? "").split(/\s+/u).filter(Boolean);
        return {
          command: "depth",
          argument: depthToken || undefined,
          remainingText: rest.length > 0 ? rest.join(" ") : undefined
        };
      }

      if (slashMatch[1] === "context" || slashMatch[1] === "focus" || slashMatch[1] === "export") {
        return {
          command: slashMatch[1] as ParsedRequest["command"],
          argument: payload || undefined
        };
      }

      return {
        command: slashMatch[1] as ParsedRequest["command"],
        argument: payload || undefined,
        remainingText: payload || undefined
      };
    }

    return {
      command: "context",
      remainingText: text
    };
  }

  private writeMarkdown(stream: { markdown?: (value: string) => void; write?: (value: string) => void }, markdown: string): void {
    if (typeof stream.markdown === "function") {
      stream.markdown(markdown);
      return;
    }
    if (typeof stream.write === "function") {
      stream.write(markdown);
    }
  }

  private resolveTargetNodes(target?: string | string[]): GraphNode[] {
    const files = Array.isArray(target)
      ? target
      : [target ?? vscode.window.activeTextEditor?.document.uri.fsPath].filter((value): value is string => Boolean(value));

    const nodes: GraphNode[] = [];
    for (const filePath of files) {
      const node = this.resolveNodeForFile(filePath);
      if (node) {
        nodes.push(node);
      }
    }
    return nodes;
  }

  private resolveNodeForFile(filePath: string): GraphNode | undefined {
    // Try to find which workspace root this file path belongs to.
    let workspaceRoot = "";
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) {
      if (folders.length === 1) {
        workspaceRoot = folders[0].uri.fsPath;
      } else if (path.isAbsolute(filePath)) {
        // Find the matching root by checking which folder contains this path.
        const resolved = folders.find((folder) => {
          const relative = path.relative(folder.uri.fsPath, filePath);
          return !relative.startsWith("..") && !path.isAbsolute(relative);
        });
        workspaceRoot = resolved?.uri.fsPath ?? folders[0].uri.fsPath;
      } else {
        // Relative path: use the active editor's root or first root.
        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor) {
          const matched = folders.find((folder) => {
            const rel = path.relative(folder.uri.fsPath, activeEditor.document.uri.fsPath);
            return !rel.startsWith("..") && !path.isAbsolute(rel);
          });
          workspaceRoot = matched?.uri.fsPath ?? folders[0].uri.fsPath;
        } else {
          workspaceRoot = folders[0].uri.fsPath;
        }
      }
    }
    if (!workspaceRoot) {
      return undefined;
    }
    const absolutePath = path.isAbsolute(filePath) ? filePath : path.join(workspaceRoot, filePath);
    const relativePath = path.relative(workspaceRoot, absolutePath).replace(/\\/gu, "/");
    return this.options.getGraphDatabase().getNodeByRelativePath(relativePath);
  }

  private mergeSubGraphs(
    nodes: GraphNode[],
    depth: number,
    direction: "both" | "incoming" | "outgoing"
  ): SubGraph {
    const mergedNodes = new Map<string, GraphNode>();
    const mergedEdges = new Map<string, SubGraph["edges"][number]>();
    const circularEdgeIds = new Set<string>();
    const orderedNodeIds: string[] = [];

    for (const node of nodes) {
      if (node === undefined) continue;
      const subGraph = this.options.getTraversal().bfs(node.id, depth, direction);
      for (const entry of subGraph.nodes) {
        mergedNodes.set(entry.id, entry);
      }
      for (const edge of subGraph.edges) {
        mergedEdges.set(edge.id, edge);
      }
      for (const edgeId of subGraph.circularEdgeIds) {
        circularEdgeIds.add(edgeId);
      }
      for (const nodeId of subGraph.orderedNodeIds) {
        if (!orderedNodeIds.includes(nodeId)) {
          orderedNodeIds.push(nodeId);
        }
      }
    }

    return {
      nodes: Array.from(mergedNodes.values()),
      edges: Array.from(mergedEdges.values()),
      orderedNodeIds,
      circularEdgeIds: Array.from(circularEdgeIds.values())
    };
  }
}
