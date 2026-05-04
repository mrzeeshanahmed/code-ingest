import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createGraphEdgeId, EdgeType, GraphEdge } from "../../graph/models/Edge";
import { createGraphNodeId, GraphNode, NodeType } from "../../graph/models/Node";

export async function createTempWorkspace(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(process.cwd(), `${prefix}-`));
}

export async function removeTempWorkspace(workspacePath: string): Promise<void> {
  await fs.rm(workspacePath, { recursive: true, force: true });
}

export function createNode(
  workspaceRoot: string,
  relativePath: string,
  label: string,
  type: NodeType = "file",
  overrides: Partial<GraphNode> = {}
): GraphNode {
  const timestamp = overrides.lastIndexed ?? Date.now();
  const symbolName = type === "file" ? "" : label;
  return {
    id: createGraphNodeId(workspaceRoot, relativePath, symbolName),
    type,
    label,
    filePath: path.join(workspaceRoot, relativePath),
    relativePath,
    lastIndexed: timestamp,
    hash: overrides.hash ?? `${relativePath}::${label}::${type}`,
    ...overrides
  };
}

export function createEdge(sourceId: string, targetId: string, type: EdgeType, overrides: Partial<GraphEdge> = {}): GraphEdge {
  return {
    id: createGraphEdgeId(sourceId, targetId, type),
    sourceId,
    targetId,
    type,
    weight: overrides.weight ?? 1,
    ...overrides
  };
}
