import * as vscode from "vscode";
import { GRAPH_DEFAULTS, GraphLayout, GraphNodeMode, GraphSettings } from "./constants";

export function getGraphSettings(folder?: vscode.WorkspaceFolder): GraphSettings {
  const graph = vscode.workspace.getConfiguration("codeIngest.graph", folder);
  const indexing = vscode.workspace.getConfiguration("codeIngest.indexing", folder);
  const copilot = vscode.workspace.getConfiguration("codeIngest.copilot", folder);
  const display = vscode.workspace.getConfiguration("codeIngest.display", folder);

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
    autoFocusOnEditorChange: display.get<boolean>("autoFocusOnEditorChange", GRAPH_DEFAULTS.autoFocusOnEditorChange)
  };
}
