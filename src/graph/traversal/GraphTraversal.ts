import { GraphDatabase } from "../database/GraphDatabase";
import { GraphEdge } from "../models/Edge";
import { GraphNode } from "../models/Node";

export interface SubGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  orderedNodeIds: string[];
  circularEdgeIds: string[];
}

export class GraphTraversal {
  constructor(private readonly graphDatabase: GraphDatabase) {}

  public bfs(
    startNodeId: string,
    depth: number,
    direction: "both" | "incoming" | "outgoing" = "both"
  ): SubGraph {
    const visited = new Set<string>();
    const nodes = new Map<string, GraphNode>();
    const edges = new Map<string, GraphEdge>();
    const circularEdgeIds = new Set<string>();
    let frontier = new Set<string>([startNodeId]);
    const rootNode = this.graphDatabase.getNodeById(startNodeId);

    if (rootNode) {
      nodes.set(rootNode.id, rootNode);
    }

    for (let hop = 0; hop <= depth && frontier.size > 0; hop += 1) {
      const currentIds = Array.from(frontier);
      frontier = new Set<string>();

      for (const nodeId of currentIds) {
        visited.add(nodeId);
      }

      const batch = this.graphDatabase.getNeighbors(currentIds, direction);
      for (const node of batch.nodes) {
        nodes.set(node.id, node);
      }

      for (const edge of batch.edges) {
        edges.set(edge.id, edge);
        if (visited.has(edge.sourceId) && visited.has(edge.targetId)) {
          circularEdgeIds.add(edge.id);
        }

        if (!visited.has(edge.sourceId)) {
          frontier.add(edge.sourceId);
        }

        if (!visited.has(edge.targetId)) {
          frontier.add(edge.targetId);
        }
      }
    }

    const degree = new Map<string, number>();
    for (const edge of edges.values()) {
      degree.set(edge.sourceId, (degree.get(edge.sourceId) ?? 0) + 1);
      degree.set(edge.targetId, (degree.get(edge.targetId) ?? 0) + 1);
    }

    const orderedNodeIds = Array.from(nodes.keys()).sort((left, right) => {
      if (left === startNodeId) {
        return -1;
      }
      if (right === startNodeId) {
        return 1;
      }
      return (degree.get(right) ?? 0) - (degree.get(left) ?? 0);
    });

    return {
      nodes: Array.from(nodes.values()),
      edges: Array.from(edges.values()),
      orderedNodeIds,
      circularEdgeIds: Array.from(circularEdgeIds.values())
    };
  }
}
