import * as crypto from "node:crypto";

export type EdgeType = "import" | "call" | "inheritance" | "implements" | "contains" | "knowledge_of";

export interface GraphEdge {
  id: string;
  sourceId: string;
  targetId: string;
  type: EdgeType;
  weight: number;
  metadata?: Record<string, unknown>;
}

export function createGraphEdgeId(sourceId: string, targetId: string, type: EdgeType): string {
  const payload = `${sourceId}::${targetId}::${type}`;
  return crypto.createHash("sha256").update(payload).digest("hex");
}
