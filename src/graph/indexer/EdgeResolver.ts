import * as path from "node:path";
import { createGraphEdgeId, GraphEdge, EdgeType } from "../models/Edge";
import { GraphNode } from "../models/Node";
import { ExtractedSymbol } from "./LspExtractor";

export interface IndexedFileEntry {
  fileNode: GraphNode;
  symbolNodes: GraphNode[];
  symbols: ExtractedSymbol[];
  content: string;
  codeChunks: import("../models/Chunk").GraphCodeChunk[];
  commentChunks: import("../models/Chunk").GraphCommentChunk[];
}

interface SymbolLookupEntry {
  node: GraphNode;
  fileNode: GraphNode;
}

function createEdge(sourceId: string, targetId: string, type: EdgeType, metadata?: Record<string, unknown>): GraphEdge {
  const edge: GraphEdge = {
    id: createGraphEdgeId(sourceId, targetId, type),
    sourceId,
    targetId,
    type,
    weight: 1
  };

  if (metadata) {
    edge.metadata = metadata;
  }

  return edge;
}

export class EdgeResolver {
  public resolve(entries: IndexedFileEntry[]): GraphEdge[] {
    const edges = new Map<string, GraphEdge>();
    const fileByRelativePath = new Map(entries.map((entry) => [this.normalize(entry.fileNode.relativePath), entry]));
    const symbolLookup = this.buildSymbolLookup(entries);

    for (const entry of entries) {
      this.resolveImports(entry, fileByRelativePath, edges);
      this.resolveInheritance(entry, symbolLookup, edges);
      this.resolveCalls(entry, symbolLookup, edges);
    }

    return Array.from(edges.values());
  }

  private buildSymbolLookup(entries: IndexedFileEntry[]): Map<string, SymbolLookupEntry[]> {
    const lookup = new Map<string, SymbolLookupEntry[]>();

    for (const entry of entries) {
      for (const node of entry.symbolNodes) {
        const bucket = lookup.get(node.label) ?? [];
        bucket.push({ node, fileNode: entry.fileNode });
        lookup.set(node.label, bucket);
      }
    }

    return lookup;
  }

  private resolveImports(
    entry: IndexedFileEntry,
    fileByRelativePath: Map<string, IndexedFileEntry>,
    edges: Map<string, GraphEdge>
  ): void {
    const importRegex = /(?:import\s+[^'"]*from\s+|require\()\s*['"]([^'"]+)['"]/gu;
    let match: RegExpExecArray | null;

    while ((match = importRegex.exec(entry.content)) !== null) {
      const specifier = match[1];
      const resolvedRelative = this.resolveImportSpecifier(entry.fileNode.relativePath, specifier, fileByRelativePath);
      if (!resolvedRelative) {
        continue;
      }

      const target = fileByRelativePath.get(resolvedRelative);
      if (!target) {
        continue;
      }
      const edge = createEdge(entry.fileNode.id, target.fileNode.id, "import", { importSpecifier: specifier });
      edges.set(edge.id, edge);
    }
  }

  private resolveInheritance(
    entry: IndexedFileEntry,
    symbolLookup: Map<string, SymbolLookupEntry[]>,
    edges: Map<string, GraphEdge>
  ): void {
    const inheritanceRegex = /^\s*class\s+([A-Za-z0-9_$]+)(?:\s+extends\s+([A-Za-z0-9_$]+))?(?:\s+implements\s+([A-Za-z0-9_$,\s]+))?/gmu;
    let match: RegExpExecArray | null;

    while ((match = inheritanceRegex.exec(entry.content)) !== null) {
      const sourceName = match[1];
      const source = entry.symbolNodes.find((node) => node.label === sourceName) ?? entry.fileNode;

      if (match[2]) {
        const targets = symbolLookup.get(match[2]) ?? [];
        for (const target of targets) {
          const edge = createEdge(source.id, target.node.id, "inheritance");
          edges.set(edge.id, edge);
        }
      }

      if (match[3]) {
        const interfaceNames = match[3].split(",").map((value) => value.trim()).filter(Boolean);
        for (const interfaceName of interfaceNames) {
          const targets = symbolLookup.get(interfaceName) ?? [];
          for (const target of targets) {
            const edge = createEdge(source.id, target.node.id, "implements");
            edges.set(edge.id, edge);
          }
        }
      }
    }
  }

  private resolveCalls(
    entry: IndexedFileEntry,
    symbolLookup: Map<string, SymbolLookupEntry[]>,
    edges: Map<string, GraphEdge>
  ): void {
    const callRegex = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/gu;
    const source = entry.symbolNodes[0] ?? entry.fileNode;
    let match: RegExpExecArray | null;

    while ((match = callRegex.exec(entry.content)) !== null) {
      const callee = match[1];
      if (this.shouldIgnoreCall(callee)) {
        continue;
      }

      const targets = symbolLookup.get(callee) ?? [];
      for (const target of targets) {
        const edge = createEdge(source.id, target.node.id, "call");
        edges.set(edge.id, edge);
      }
    }
  }

  private shouldIgnoreCall(name: string): boolean {
    return new Set(["if", "for", "while", "switch", "catch", "function", "return", "typeof", "new"]).has(name);
  }

  private resolveImportSpecifier(
    relativePath: string,
    specifier: string,
    fileByRelativePath: Map<string, IndexedFileEntry>
  ): string | undefined {
    if (!specifier.startsWith(".")) {
      return undefined;
    }

    const sourceDirectory = path.posix.dirname(this.normalize(relativePath));
    const candidateBase = this.normalize(path.posix.join(sourceDirectory, specifier));
    const candidates = [
      candidateBase,
      `${candidateBase}.ts`,
      `${candidateBase}.tsx`,
      `${candidateBase}.js`,
      `${candidateBase}.jsx`,
      `${candidateBase}.py`,
      path.posix.join(candidateBase, "index.ts"),
      path.posix.join(candidateBase, "index.js")
    ];

    return candidates.find((candidate) => fileByRelativePath.has(candidate));
  }

  private normalize(value: string): string {
    return value.replace(/\\/gu, "/");
  }
}
