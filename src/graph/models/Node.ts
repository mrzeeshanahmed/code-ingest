import * as crypto from "node:crypto";

export type NodeType = "file" | "function" | "class" | "interface" | "method" | "knowledge" | "module_summary";

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
  symbolName = ""
): string {
  const payload = `${workspaceRoot}::${relativePath}::${symbolName}`;
  return crypto.createHash("sha256").update(payload).digest("hex");
}
