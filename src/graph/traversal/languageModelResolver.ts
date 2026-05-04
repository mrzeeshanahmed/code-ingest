import * as vscode from "vscode";
import { buildContextFooter } from "../../utils/escapeHtml";

export async function resolveLanguageModel(
  modelFamily: string,
  token: vscode.CancellationToken
): Promise<vscode.LanguageModelChat | undefined> {
  try {
    const models = await vscode.lm.selectChatModels({ vendor: "copilot", family: modelFamily });
    if (models.length === 0) {
      return undefined;
    }
    if (token.isCancellationRequested) {
      return undefined;
    }
    return models[0];
  } catch {
    return undefined;
  }
}

export function formatContextFooter(params: {
  files: string[];
  nodeCount: number;
  depth: number;
  semanticMatches: boolean;
  promptTokens: number;
  piiPolicy: string;
}): string {
  return buildContextFooter({
    files: params.files,
    graphNodes: params.nodeCount,
    retrievalDepth: params.depth,
    semanticMatchesIncluded: params.semanticMatches,
    promptTokens: params.promptTokens,
    piiPolicy: params.piiPolicy
  });
}
