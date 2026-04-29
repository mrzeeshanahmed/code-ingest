import * as crypto from "node:crypto";

export type EdgeType = "import" | "call" | "inheritance" | "implements" | "contains";

export interface GraphEdge {
  id: string;
  sourceId: string;
  targetId: string;
  type: EdgeType;
  weight: number;
  metadata?: Record<string, unknown>;
}

export function createGraphEdgeId(sourceId: string, targetId: string, type: EdgeType): string {
  const hash = crypto.createHash("sha256");
  hash.update(sourceId);
  hash.update("\n");
  hash.update(targetId);
  hash.update("\n");
  hash.update(type);
  return hash.digest("hex");
}
