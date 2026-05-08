import * as vscode from "vscode";
import { GRAPH_DEFAULTS, GraphLayout, GraphNodeMode, GraphSettings, KnowledgePrefetchMode, PIIMode } from "./constants";

export function getGraphSettings(folder?: vscode.WorkspaceFolder): GraphSettings {
  const graph = vscode.workspace.getConfiguration("codeIngest.graph", folder);
  const indexing = vscode.workspace.getConfiguration("codeIngest.indexing", folder);
  const copilot = vscode.workspace.getConfiguration("codeIngest.copilot", folder);
  const display = vscode.workspace.getConfiguration("codeIngest.display", folder);
  const pii = vscode.workspace.getConfiguration("codeIngest.pii", folder);
  const embedding = vscode.workspace.getConfiguration("codeIngest.embedding", folder);
  const knowledge = vscode.workspace.getConfiguration("codeIngest.knowledge", folder);
  const exportGov = vscode.workspace.getConfiguration("codeIngest", folder);

  return {
    hopDepth: graph.get<number>("hopDepth", GRAPH_DEFAULTS.hopDepth),
    defaultNodeMode: graph.get<GraphNodeMode>("defaultNodeMode", GRAPH_DEFAULTS.defaultNodeMode),
    maxNodes: graph.get<number>("maxNodes", GRAPH_DEFAULTS.maxNodes),
    enableVectorSearch: graph.get<boolean>("enableVectorSearch", GRAPH_DEFAULTS.enableVectorSearch),
    layout: graph.get<GraphLayout>("layout", GRAPH_DEFAULTS.layout),
    maxFileSizeKB: indexing.get<number>("maxFileSizeKB", GRAPH_DEFAULTS.maxFileSizeKB),
    maxFiles: indexing.get<number>("maxFiles", GRAPH_DEFAULTS.maxFiles),
    watcherDebounceMs: indexing.get<number>("watcherDebounceMs", GRAPH_DEFAULTS.watcherDebounceMs),
    excludePatterns: indexing.get<string[]>("excludePatterns", [...GRAPH_DEFAULTS.excludePatterns]),
    rebuildOnActivation: indexing.get<boolean>("rebuildOnActivation", GRAPH_DEFAULTS.rebuildOnActivation),
    tokenBudget: copilot.get<number>("tokenBudget", GRAPH_DEFAULTS.tokenBudget),
    includeSourceContent: copilot.get<boolean>("includeSourceContent", GRAPH_DEFAULTS.includeSourceContent),
    redactSecrets: copilot.get<boolean>("redactSecrets", GRAPH_DEFAULTS.redactSecrets),
    semanticResultCount: copilot.get<number>("semanticResultCount", GRAPH_DEFAULTS.semanticResultCount),
    showCircularDepsWarning: display.get<boolean>("showCircularDepsWarning", GRAPH_DEFAULTS.showCircularDepsWarning),
    focusModeOpacity: display.get<number>("focusModeOpacity", GRAPH_DEFAULTS.focusModeOpacity),
    autoFocusOnEditorChange: display.get<boolean>("autoFocusOnEditorChange", GRAPH_DEFAULTS.autoFocusOnEditorChange),
    allowRawExport: exportGov.get<boolean>("allowRawExport", GRAPH_DEFAULTS.allowRawExport),
    piiMode: pii.get<PIIMode>("mode", GRAPH_DEFAULTS.piiMode),
    piiStrictForExport: pii.get<boolean>("strictForExport", GRAPH_DEFAULTS.piiStrictForExport),
    embeddingMaxRetries: embedding.get<number>("maxRetries", GRAPH_DEFAULTS.embeddingMaxRetries),
    embeddingCooldownMs: embedding.get<number>("cooldownMs", GRAPH_DEFAULTS.embeddingCooldownMs),
    knowledgeMode: knowledge.get<"jit">("mode", GRAPH_DEFAULTS.knowledgeMode),
    knowledgeCooldownMs: knowledge.get<number>("cooldownMs", GRAPH_DEFAULTS.knowledgeCooldownMs),
    knowledgeSoftPrefetchMode: knowledge.get<KnowledgePrefetchMode>("softPrefetchMode", GRAPH_DEFAULTS.knowledgeSoftPrefetchMode),
    knowledgeMaxConcurrentSyntheses: knowledge.get<number>("maxConcurrentSyntheses", GRAPH_DEFAULTS.knowledgeMaxConcurrentSyntheses),
    knowledgeModelChoice: knowledge.get<string>("modelChoice", GRAPH_DEFAULTS.knowledgeModelChoice),
    copilotReserveTokensPercent: copilot.get<number>("reserveTokensPercent", GRAPH_DEFAULTS.copilotReserveTokensPercent),
    copilotReserveTokensMin: copilot.get<number>("reserveTokensMin", GRAPH_DEFAULTS.copilotReserveTokensMin),
    pauseDuringGitOperations: indexing.get<boolean>("pauseDuringGitOperations", GRAPH_DEFAULTS.pauseDuringGitOperations),
    initialBatchNodes: graph.get<number>("initialBatchNodes", GRAPH_DEFAULTS.initialBatchNodes),
    transportChunkSizeKB: graph.get<number>("transportChunkSizeKB", GRAPH_DEFAULTS.transportChunkSizeKB),
    enableSemanticZoom: graph.get<boolean>("enableSemanticZoom", GRAPH_DEFAULTS.enableSemanticZoom)
  };
}
