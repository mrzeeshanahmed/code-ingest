import * as crypto from "node:crypto";

export type NodeType = "file" | "function" | "class" | "interface" | "method";

export interface GraphNode {
  id: string;
  type: NodeType;
  label: string;
  filePath: string;
  relativePath: string;
  startLine?: number | undefined;
  endLine?: number | undefined;
  language?: string | undefined;
  lastIndexed: number;
  hash: string;
  metadata?: Record<string, unknown> | undefined;
}

export function createGraphNodeId(
  workspaceRoot: string,
  relativePath: string,
  symbolName?: string,
  symbolKind?: string
): string {
  const hash = crypto.createHash("sha256");
  hash.update(workspaceRoot);
  hash.update("\n");
  hash.update(relativePath);
  hash.update("\n");
  hash.update(symbolName ?? "");
  hash.update("\n");
  hash.update(symbolKind ?? "");
  return hash.digest("hex");
}
