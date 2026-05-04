import * as crypto from "node:crypto";

export interface GraphCodeChunk {
  id: string;
  fileNodeId: string;
  startLine: number;
  endLine: number;
  content: string;
  lineage?: string | undefined;
  piiDetected: boolean;
  piiRedactedContent?: string | undefined;
}

export interface GraphCommentChunk {
  id: string;
  fileNodeId: string;
  startLine: number;
  endLine: number;
  content: string;
  lineage?: string | undefined;
  piiDetected: boolean;
  piiTags?: string | undefined;
}

export function generateChunkId(fileNodeId: string, startLine: number, endLine: number): string {
  const payload = `${fileNodeId}::${startLine}::${endLine}`;
  return crypto.createHash("sha256").update(payload).digest("hex");
}
