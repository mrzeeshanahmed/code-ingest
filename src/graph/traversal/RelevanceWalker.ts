import { GraphDatabase } from "../database/GraphDatabase";
import { GraphEdge } from "../models/Edge";
import { GraphNode } from "../models/Node";

export interface RelevanceWalkOptions {
  startNodeIds: string[];
  maxDepth: number;
  maxNodes: number;
  direction?: "both" | "incoming" | "outgoing";
}

export interface RelevanceWalkResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  orderedNodeIds: string[];
  scores: Map<string, number>;
}

export class RelevanceWalker {
  constructor(private readonly graphDatabase: GraphDatabase) {}

  public walk(options: RelevanceWalkOptions): RelevanceWalkResult {
    const { startNodeIds, maxDepth, maxNodes, direction = "both" } = options;
    const scores = new Map<string, number>();
    const visited = new Set<string>();
    const nodes = new Map<string, GraphNode>();
    const edges = new Map<string, GraphEdge>();

    // Initialize scores for start nodes.
    for (const id of startNodeIds) {
      scores.set(id, 1.0);
      const node = this.graphDatabase.getNodeById(id);
      if (node) {
        nodes.set(id, node);
      }
    }

    let frontier = new Map<string, number>();
    for (const id of startNodeIds) {
      frontier.set(id, scores.get(id)!);
    }

    for (let depth = 0; depth < maxDepth && frontier.size > 0 && nodes.size < maxNodes; depth += 1) {
      const nextFrontier = new Map<string, number>();
      const currentIds = Array.from(frontier.keys());
      const batch = this.graphDatabase.getNeighbors(currentIds, direction);

      for (const node of batch.nodes) {
        if (!nodes.has(node.id)) {
          nodes.set(node.id, node);
        }
      }

      for (const edge of batch.edges) {
        edges.set(edge.id, edge);
        const weight = edge.weight ?? 1.0;
        const sourceScore = frontier.get(edge.sourceId) ?? scores.get(edge.sourceId) ?? 0;
        const targetScore = frontier.get(edge.targetId) ?? scores.get(edge.targetId) ?? 0;
        const incomingScore = direction !== "outgoing" ? sourceScore * weight : 0;
        const outgoingScore = direction !== "incoming" ? targetScore * weight : 0;
        const score = Math.max(incomingScore, outgoingScore);

        if (score > 0) {
          const neighborId = direction === "incoming" ? edge.sourceId : edge.targetId;
          const current = scores.get(neighborId) ?? 0;
          const updated = Math.max(current, score);
          scores.set(neighborId, updated);

          if (!visited.has(neighborId) && nodes.size < maxNodes) {
            nextFrontier.set(neighborId, updated);
          }
        }
      }

      for (const id of currentIds) {
        visited.add(id);
      }
      frontier = nextFrontier;
    }

    const orderedNodeIds = Array.from(nodes.keys()).sort((left, right) => {
      const leftScore = scores.get(left) ?? 0;
      const rightScore = scores.get(right) ?? 0;
      if (rightScore !== leftScore) {
        return rightScore - leftScore;
      }
      return left.localeCompare(right);
    });

    return {
      nodes: Array.from(nodes.values()),
      edges: Array.from(edges.values()),
      orderedNodeIds,
      scores
    };
  }
}
