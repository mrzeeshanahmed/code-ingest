import { GraphDatabase } from "../database/GraphDatabase";
import { GraphEdge } from "../models/Edge";
import { GraphNode } from "../models/Node";

export interface RelevanceWalkOptions {
  startNodeIds: string[];
  maxDepth: number;
  maxNodes: number;
  direction?: "both" | "incoming" | "outgoing";
  abortSignal?: AbortSignal;
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
    const { startNodeIds, maxDepth, maxNodes, direction = "both", abortSignal } = options;
    const nodes = new Map<string, GraphNode>();
    const edges = new Map<string, GraphEdge>();

    // 1. Gather Subgraph (BFS up to maxDepth)
    let frontier = new Set<string>(startNodeIds);
    for (const id of startNodeIds) {
      const node = this.graphDatabase.getNodeById(id);
      if (node) nodes.set(id, node);
    }

    for (let depth = 0; depth < maxDepth && frontier.size > 0 && nodes.size < maxNodes; depth++) {
      if (abortSignal?.aborted) break;

      const currentIds = Array.from(frontier);
      const batch = this.graphDatabase.getNeighbors(currentIds, direction);
      
      const nextFrontier = new Set<string>();
      for (const node of batch.nodes) {
        if (!nodes.has(node.id) && nodes.size < maxNodes) {
          nodes.set(node.id, node);
          nextFrontier.add(node.id);
        }
      }
      for (const edge of batch.edges) {
        edges.set(edge.id, edge);
      }
      frontier = nextFrontier;
    }

    const validEdges = Array.from(edges.values()).filter(
      (e) => nodes.has(e.sourceId) && nodes.has(e.targetId)
    );

    // 2. Personalized PageRank
    const DAMPING = 0.85;
    const RESTART = 1 - DAMPING;
    const MAX_ITERATIONS = 50;
    const CONVERGENCE_TOLERANCE = 1e-4;

    let scores = new Map<string, number>();
    for (const id of nodes.keys()) {
      scores.set(id, startNodeIds.includes(id) ? 1.0 / startNodeIds.length : 0);
    }

    // Precompute degree for super-node penalty
    const outDegree = new Map<string, number>();
    const inDegree = new Map<string, number>();
    for (const e of validEdges) {
      outDegree.set(e.sourceId, (outDegree.get(e.sourceId) || 0) + 1);
      inDegree.set(e.targetId, (inDegree.get(e.targetId) || 0) + 1);
    }

    for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
      if (abortSignal?.aborted) break;

      const nextScores = new Map<string, number>();
      let diff = 0;

      for (const id of nodes.keys()) {
        const restartProb = startNodeIds.includes(id) ? RESTART / startNodeIds.length : 0;
        nextScores.set(id, restartProb);
      }

      for (const edge of validEdges) {
        const src = edge.sourceId;
        const tgt = edge.targetId;
        const weight = edge.weight ?? 1.0;

        if (direction !== "incoming") {
          const srcOut = outDegree.get(src) || 1;
          const srcScore = scores.get(src) || 0;
          // Super-node penalty: distribute score by out-degree
          const contribution = (srcScore / srcOut) * weight;
          nextScores.set(tgt, (nextScores.get(tgt) || 0) + DAMPING * contribution);
        }

        if (direction !== "outgoing") {
          const tgtOut = inDegree.get(tgt) || 1;
          const tgtScore = scores.get(tgt) || 0;
          const reverseContrib = (tgtScore / tgtOut) * weight;
          nextScores.set(src, (nextScores.get(src) || 0) + DAMPING * reverseContrib);
        }
      }

      for (const id of nodes.keys()) {
        diff += Math.abs((nextScores.get(id) || 0) - (scores.get(id) || 0));
      }

      scores = nextScores;
      if (diff < CONVERGENCE_TOLERANCE) {
        break;
      }
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
      edges: validEdges,
      orderedNodeIds,
      scores
    };
  }
}
