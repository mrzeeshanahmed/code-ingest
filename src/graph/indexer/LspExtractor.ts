import * as vscode from "vscode";
import { NodeType } from "../models/Node";

export interface ExtractedSymbol {
  name: string;
  type: NodeType;
  startLine: number;
  endLine: number;
}

export class LspExtractor {
  constructor(private readonly outputChannel?: { appendLine(message: string): void }) {}

  public async extract(uri: vscode.Uri, languageId: string, content?: string): Promise<ExtractedSymbol[]> {
    const commandResult = await this.extractViaLsp(uri);
    if (commandResult.length > 0) {
      return commandResult;
    }

    this.outputChannel?.appendLine(`[indexer] LSP symbols unavailable for ${uri.fsPath}; using heuristic fallback.`);
    return this.extractViaFallback(languageId, content ?? "");
  }

  private async extractViaLsp(uri: vscode.Uri): Promise<ExtractedSymbol[]> {
    try {
      const response = await vscode.commands.executeCommand<unknown[]>("vscode.executeDocumentSymbolProvider", uri);
      if (!Array.isArray(response) || response.length === 0) {
        return [];
      }

      return this.flattenDocumentSymbols(response);
    } catch (error) {
      this.outputChannel?.appendLine(`[indexer] DocumentSymbolProvider failed for ${uri.fsPath}: ${(error as Error).message}`);
      return [];
    }
  }

  private flattenDocumentSymbols(symbols: unknown[], bucket: ExtractedSymbol[] = []): ExtractedSymbol[] {
    for (const entry of symbols) {
      if (!entry || typeof entry !== "object") {
        continue;
      }

      const candidate = entry as {
        name?: unknown;
        kind?: unknown;
        range?: { start?: { line?: unknown }; end?: { line?: unknown } };
        children?: unknown[];
      };

      if (typeof candidate.name !== "string") {
        continue;
      }

      const type = this.mapSymbolKind(candidate.kind);
      if (!type) {
        continue;
      }

      const startLine = typeof candidate.range?.start?.line === "number" ? candidate.range.start.line + 1 : 1;
      const endLine = typeof candidate.range?.end?.line === "number" ? candidate.range.end.line + 1 : startLine;

      bucket.push({
        name: candidate.name,
        type,
        startLine,
        endLine
      });

      if (Array.isArray(candidate.children)) {
        this.flattenDocumentSymbols(candidate.children, bucket);
      }
    }

    return bucket;
  }

  private mapSymbolKind(kind: unknown): NodeType | undefined {
    const numeric = typeof kind === "number" ? kind : Number.NaN;
    switch (numeric) {
      case vscode.SymbolKind.Function:
        return "function";
      case vscode.SymbolKind.Method:
        return "method";
      case vscode.SymbolKind.Class:
        return "class";
      case vscode.SymbolKind.Interface:
        return "interface";
      default:
        return undefined;
    }
  }

  private extractViaFallback(languageId: string, content: string): ExtractedSymbol[] {
    if (!content.trim()) {
      return [];
    }

    const patterns = this.getFallbackPatterns(languageId);
    const lines = content.split(/\r?\n/u);
    const results: ExtractedSymbol[] = [];

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      for (const pattern of patterns) {
        const match = pattern.regex.exec(line);
        if (!match || !match[1]) {
          continue;
        }

        results.push({
          name: match[1],
          type: pattern.type,
          startLine: index + 1,
          endLine: Math.min(lines.length, index + 1)
        });
      }
    }

    return results;
  }

  private getFallbackPatterns(languageId: string): Array<{ regex: RegExp; type: NodeType }> {
    switch (languageId) {
      case "typescript":
      case "javascript":
      case "typescriptreact":
      case "javascriptreact":
        return [
          { regex: /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)/u, type: "function" },
          { regex: /^\s*(?:export\s+)?class\s+([A-Za-z0-9_$]+)/u, type: "class" },
          { regex: /^\s*(?:export\s+)?interface\s+([A-Za-z0-9_$]+)/u, type: "interface" },
          { regex: /^\s*(?:public|private|protected)?\s*(?:async\s+)?([A-Za-z0-9_$]+)\s*\([^)]*\)\s*\{/u, type: "method" }
        ];
      case "python":
        return [
          { regex: /^\s*def\s+([A-Za-z0-9_]+)/u, type: "function" },
          { regex: /^\s*class\s+([A-Za-z0-9_]+)/u, type: "class" }
        ];
      default:
        return [
          { regex: /^\s*(?:class|struct)\s+([A-Za-z0-9_]+)/u, type: "class" },
          { regex: /^\s*(?:func|function|def)\s+([A-Za-z0-9_]+)/u, type: "function" }
        ];
    }
  }
}
