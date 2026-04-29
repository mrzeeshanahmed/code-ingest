import * as vscode from "vscode";
import { DigestGenerator } from "./digestGenerator";
import { GraphDatabase } from "../graph/database/GraphDatabase";
import { ContextBuilder } from "../graph/traversal/ContextBuilder";
import { PIIService, PIIPolicyMode } from "./security/piiService";
import { GraphSettings } from "../config/constants";
import { SubGraph } from "../graph/traversal/GraphTraversal";

import { createFormatter } from "../formatters/factory";

export enum ExportMode {
  Raw = "raw",
  Clean = "clean",
  Graph = "graph"
}

export interface ExportOptions {
  mode: ExportMode;
  piiPolicy?: PIIPolicyMode;
  queryOrigin?: string;
  subGraph?: SubGraph; // Only used for Graph mode
  settings: GraphSettings;
  format?: "markdown" | "json" | "text";
  digestOptions?: any; // Options for DigestGenerator
}

export class ExportController {
  constructor(
    private readonly workspaceRoot: vscode.Uri,
    private readonly digestGenerator: DigestGenerator,
    private readonly graphDatabase: GraphDatabase,
    private readonly piiService: PIIService
  ) {}

  public async export(options: ExportOptions): Promise<string> {
    switch (options.mode) {
      case ExportMode.Raw:
        return this.exportRaw(options);
      case ExportMode.Clean:
        return this.exportClean(options);
      case ExportMode.Graph:
        return this.exportGraph(options);
      default:
        throw new Error(`Unsupported export mode: ${options.mode}`);
    }
  }

  /**
   * Raw Export: Uses the legacy pipeline (DigestGenerator) without strict PII enforcement.
   * Useful for internal backups or raw code extraction.
   */
  private async exportRaw(options: ExportOptions): Promise<string> {
    const defaultOptions = {
      selectedFiles: [],
      outputFormat: options.format ?? "markdown",
      maxTokens: 16_000,
      includeMetadata: true,
      applyRedaction: false,
    };
    const digestResult = await this.digestGenerator.generateDigest(options.digestOptions ?? defaultOptions);
    const formatter = createFormatter(options.format ?? "markdown");
    return formatter.finalize(digestResult);
  }

  /**
   * Clean Export: Uses the Graph-based pipeline to export the entire repository while enforcing PII compliance.
   * Suitable for AI training data or external sharing.
   */
  private async exportClean(options: ExportOptions): Promise<string> {
    const policy = options.piiPolicy ?? PIIPolicyMode.Strict;
    
    // For a clean export of the whole workspace, we use the ContextBuilder 
    // configured with the requested PII policy, and feed it all file nodes.
    const allFileNodes = this.graphDatabase.getAllNodes("file");
    
    // We treat the whole workspace as a "subgraph" with no edges, just to extract content
    const subGraph: SubGraph = {
      nodes: allFileNodes,
      edges: [],
      orderedNodeIds: allFileNodes.map((n) => n.id),
      circularEdgeIds: []
    };

    const contextBuilder = new ContextBuilder(options.settings, this.graphDatabase, policy);
    const result = await contextBuilder.build("Clean Export", subGraph);
    return result.payload;
  }

  /**
   * Graph Export: Uses the Graph-based pipeline to export a targeted subgraph (traversal).
   * Also enforces PII compliance if configured.
   */
  private async exportGraph(options: ExportOptions): Promise<string> {
    const policy = options.piiPolicy ?? PIIPolicyMode.Strict;
    const subGraph = options.subGraph ?? { nodes: [], edges: [], orderedNodeIds: [], circularEdgeIds: [] };
    
    const contextBuilder = new ContextBuilder(options.settings, this.graphDatabase, policy);
    const result = await contextBuilder.build(options.queryOrigin ?? "Graph Export", subGraph);
    return result.payload;
  }
}
