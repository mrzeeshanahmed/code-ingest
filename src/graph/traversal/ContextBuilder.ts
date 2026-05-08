import * as fs from "node:fs/promises";
import { GraphSettings } from "../../config/constants";
import { redactSecrets } from "../../utils/redactSecrets";
import { wrapWithBoundary, generateBoundaryTag, isBoundarySafe } from "../../utils/escapeHtml";
import { GraphNode } from "../models/Node";
import { SubGraph } from "./GraphTraversal";
import { GraphDatabase } from "../database/GraphDatabase";
import { TokenBudgetService } from "./TokenBudgetService";
import { PIIPolicyMode } from "../../services/security/piiService";
import type * as vscode from "vscode";

export interface SemanticMatch {
  node: GraphNode;
  distance: number;
}

export interface ContextBuildResult {
  payload: string;
  includedNodeIds: string[];
  droppedNodeIds: string[];
  tokenEstimate: number;
  boundaryTag: string;
}

export interface TraversalMetadata {
  depth: number;
  direction: "bidirectional" | "incoming" | "outgoing";
}

function fastLocalEstimate(text: string): number {
  // Fast local estimator: ~4 characters per token.
  // Used for greedy assembly only; final verification uses model-scoped countTokens().
  return Math.max(1, Math.ceil(text.length / 4));
}

export class ContextBuilder {
  private readonly tokenBudgetService: TokenBudgetService;

  constructor(
    private readonly settings: Pick<GraphSettings, "tokenBudget" | "includeSourceContent" | "redactSecrets" | "copilotReserveTokensPercent" | "copilotReserveTokensMin">,
    private readonly graphDatabase?: GraphDatabase,
    private readonly piiPolicy: PIIPolicyMode = PIIPolicyMode.Strict,
    tokenBudgetService?: TokenBudgetService,
    private readonly languageModel?: vscode.LanguageModelChat
  ) {
    this.tokenBudgetService = tokenBudgetService ?? new TokenBudgetService({
      totalBudget: this.settings.tokenBudget,
      reserveTokensPercent: ((this.settings.copilotReserveTokensPercent ?? 30) / 100),
      reserveTokensMin: this.settings.copilotReserveTokensMin ?? 1024
    });
  }

  public async build(
    queryOrigin: string,
    subGraph: SubGraph,
    semanticMatches: SemanticMatch[] = [],
    traversal: TraversalMetadata = { depth: 0, direction: "bidirectional" }
  ): Promise<ContextBuildResult> {
    // Generate a fresh XML boundary tag for this chat turn.
    const boundaryTag = generateBoundaryTag();
    const nodeMap = new Map(subGraph.nodes.map((node) => [node.id, node]));
    const edgeSummaries = this.buildEdgeSummary(subGraph);
    const sections: string[] = [
      "=== CODE-INGEST GRAPH CONTEXT ===",
      `Query origin: ${queryOrigin}`,
      `Traversal: BFS, depth=${traversal.depth}, direction=${traversal.direction}`,
      `Total context nodes: ${subGraph.nodes.length} | Total edges: ${subGraph.edges.length}`,
      "",
      "--- NODE SUMMARY ---"
    ];

    if (subGraph.circularEdgeIds.length > 0) {
      sections.splice(4, 0, `[CIRCULAR DEPENDENCY DETECTED] ${subGraph.circularEdgeIds.length} circular relationship(s).`, "");
    }

    for (const nodeId of subGraph.orderedNodeIds) {
      const node = nodeMap.get(nodeId);
      if (!node) {
        continue;
      }

      sections.push(this.renderNodeSummary(node, edgeSummaries.get(node.id)));
    }

    sections.push("");
    sections.push(`--- SEMANTICALLY SIMILAR (sqlite-vec kNN, top-${semanticMatches.length}) ---`);
    if (semanticMatches.length === 0) {
      sections.push("[none]");
    } else {
      for (const match of semanticMatches) {
        sections.push(`[${match.node.type.toUpperCase()}] ${match.node.relativePath} (distance: ${match.distance.toFixed(4)})`);
      }
    }

    const structuralPayload = sections.join("\n");
    let fastEstimate = fastLocalEstimate(structuralPayload);
    const includedNodeIds: string[] = [];
    const droppedNodeIds: string[] = [];
    const fileContentSections: string[] = [];
    const effectiveBudget = this.tokenBudgetService.getEffectiveBudget();

    if (this.settings.includeSourceContent) {
      fileContentSections.push("");
      fileContentSections.push("--- FILE CONTENTS (within token budget) ---");

      // Assemble candidate blocks per relevance tier (orderedNodeIds order).
      const candidateBlocks: string[] = [];
      for (const nodeId of subGraph.orderedNodeIds) {
        const node = nodeMap.get(nodeId);
        if (!node || node.type !== "file") {
          continue;
        }

        const content = await this.readNodeContent(node);
        if (!content) {
          continue;
        }

        // Verify the original content is free of boundary-like collisions.
        if (!isBoundarySafe(content, boundaryTag)) {
          continue;
        }
        // Wrap repository content in randomized XML boundaries with entity encoding.
        const wrapped = wrapWithBoundary(content, boundaryTag);

        const block = `[${node.relativePath}]\n${wrapped}\n`;
        const blockTokens = fastLocalEstimate(block);
        if (fastEstimate + blockTokens > effectiveBudget) {
          droppedNodeIds.push(node.id);
          continue;
        }

        fastEstimate += blockTokens;
        includedNodeIds.push(node.id);
        candidateBlocks.push(block);
      }

      fileContentSections.push(...candidateBlocks);
    }

    let payload = [structuralPayload, ...fileContentSections, "=== END GRAPH CONTEXT ==="].join("\n");

    // Batched token verification: one model-scoped countTokens() call for the whole payload.
    let finalTokenEstimate = fastEstimate;
    if (this.languageModel) {
      try {
        finalTokenEstimate = await this.tokenBudgetService.countTokens(payload, this.languageModel);
      } catch {
        // Keep fast local estimate if model counting fails.
      }
    }

    // Trim over-budget content by dropping last-added blocks and re-verify in batches.
    while (finalTokenEstimate > effectiveBudget && includedNodeIds.length > 0) {
      const droppedId = includedNodeIds.pop()!;
      droppedNodeIds.push(droppedId);
      // Rebuild payload without the dropped block.
      const droppedNode = nodeMap.get(droppedId);
      if (droppedNode) {
        const idx = fileContentSections.findIndex((s) => s.startsWith(`[${droppedNode.relativePath}]`));
        if (idx >= 0) {
          fileContentSections.splice(idx, 1);
        }
      }
      payload = [structuralPayload, ...fileContentSections, "=== END GRAPH CONTEXT ==="].join("\n");
      try {
        finalTokenEstimate = await this.tokenBudgetService.countTokens(payload, this.languageModel!);
      } catch {
        break;
      }
    }

    return {
      payload,
      includedNodeIds,
      droppedNodeIds,
      tokenEstimate: finalTokenEstimate,
      boundaryTag
    };
  }

  private buildEdgeSummary(subGraph: SubGraph): Map<string, string[]> {
    const nodeLookup = new Map(subGraph.nodes.map((node) => [node.id, node]));
    const summary = new Map<string, string[]>();
    for (const edge of subGraph.edges) {
      const bucket = summary.get(edge.sourceId) ?? [];
      const target = nodeLookup.get(edge.targetId);
      const targetLabel = target ? `${target.label} (${target.relativePath})` : edge.targetId;
      bucket.push(`${edge.type}: ${targetLabel}`);
      summary.set(edge.sourceId, bucket);
    }
    return summary;
  }

  private renderNodeSummary(node: GraphNode, relationships: string[] | undefined): string {
    const lines = [`[${node.type.toUpperCase()}] ${node.relativePath}${node.language ? ` (language: ${node.language})` : ""}`];
    for (const relationship of relationships ?? []) {
      lines.push(`  ↳ ${relationship}`);
    }
    return lines.join("\n");
  }

  private async readNodeContent(node: GraphNode): Promise<string> {
    if (!this.graphDatabase) {
      // Fallback for legacy pipeline
      try {
        const raw = await fs.readFile(node.filePath, "utf8");
        return this.settings.redactSecrets ? redactSecrets(raw) : raw;
      } catch {
        return "";
      }
    }

    // Graph-based pipeline using chunks
    const chunks = await this.graphDatabase.getCodeChunksForFile(node.id);
    if (chunks.length === 0) {
      return "";
    }

    let result = "";
    // Note: since chunks have overlap, we might ideally need a more complex merge,
    // but for ContextBuilder simply concatenating unique lines or using chunks sequentially works.
    // For simplicity, if we chunked overlappingly, concatenating them directly duplicates overlaps.
    // However, if we reconstruct from chunks, we should remove overlap, or better yet, since the
    // purpose is context for LLM, we just return the full file content if token limits allow.
    // For strict PII, we should merge the PII redacted contents.
    // The easiest way to reconstruct is just take the first maxLinesPerChunk lines of each chunk 
    // except the last one, or rely on the actual raw file if Allow mode.
    if (this.piiPolicy === PIIPolicyMode.Allow) {
      try {
        const raw = await fs.readFile(node.filePath, "utf8");
        return this.settings.redactSecrets ? redactSecrets(raw) : raw;
      } catch {
        return "";
      }
    }

    // For Strict or Mask, we MUST use chunks because they contain the redacted content.
    // Since chunks overlap, concatenating them directly might duplicate content.
    // To reconstruct correctly without overlap, we track the current line number.
    let currentLine = 1;
    for (const chunk of chunks) {
      const content = chunk.piiRedactedContent ?? chunk.content;
      const lines = content.split(/\r?\n/u);
      
      // Calculate how many lines to actually append to avoid overlap duplication
      const overlapDiff = currentLine - chunk.startLine;
      if (overlapDiff >= 0 && overlapDiff < lines.length) {
        result += lines.slice(overlapDiff).join("\n") + "\n";
        currentLine = chunk.endLine + 1;
      }
    }

    return result.trimEnd();
  }
}
