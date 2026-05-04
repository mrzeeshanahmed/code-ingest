import * as vscode from "vscode";
import { Language, Node, Parser } from "web-tree-sitter";
import { GrammarAssetResolver, GrammarNotFoundError } from "./GrammarAssetResolver";

export interface ExtractedSymbol {
  name: string;
  type: "function" | "class" | "interface" | "method";
  startLine: number;
  endLine: number;
  parentName?: string;
}

export interface ExtractionResult {
  symbols: ExtractedSymbol[];
}

export class TreeSitterExtractor {
  private grammarResolver: GrammarAssetResolver;
  private parser: Parser | undefined;
  private languageCache = new Map<string, Language>();
  private initialized = false;

  constructor(extensionUri: vscode.Uri, private readonly outputChannel?: { appendLine(message: string): void }) {
    this.grammarResolver = new GrammarAssetResolver(extensionUri);
  }

  public async initialize(): Promise<void> {
    if (this.initialized) return;
    await Parser.init();
    this.parser = new Parser();
    this.initialized = true;
  }

  public async extract(filePath: string, languageId: string, content: string): Promise<ExtractionResult> {
    if (!this.initialized) {
      await this.initialize();
    }

    const grammarPath = this.grammarResolver.resolve(languageId);
    if (!grammarPath) {
      return { symbols: [] };
    }

    let language: Language;
    try {
      language = await this.getLanguage(grammarPath);
    } catch (error) {
      if (error instanceof GrammarNotFoundError) {
        return { symbols: [] };
      }
      this.outputChannel?.appendLine(`[TreeSitterExtractor] Failed to load language ${languageId}: ${(error as Error).message}`);
      return { symbols: [] };
    }

    this.parser!.setLanguage(language);
    const tree = this.parser!.parse(content);
    if (!tree) {
      return { symbols: [] };
    }
    const symbols = this.extractSymbols(tree.rootNode);
    tree.delete();

    return { symbols };
  }

  private async getLanguage(grammarPath: string): Promise<Language> {
    const cached = this.languageCache.get(grammarPath);
    if (cached) return cached;
    const language = await Language.load(grammarPath);
    this.languageCache.set(grammarPath, language);
    return language;
  }

  private extractSymbols(node: Node): ExtractedSymbol[] {
    const symbols: ExtractedSymbol[] = [];
    this.walkNode(node, symbols);
    return symbols;
  }

  private walkNode(node: Node, symbols: ExtractedSymbol[]): void {
    const symbol = this.tryExtractSymbol(node);
    if (symbol) {
      symbols.push(symbol);
    }
    for (let i = 0; i < node.childCount; i++) {
      this.walkNode(node.child(i)!, symbols);
    }
  }

  private tryExtractSymbol(node: Node): ExtractedSymbol | undefined {
    switch (node.type) {
      case "function_declaration":
      case "function_expression":
      case "arrow_function":
      case "method_definition":
        return this.extractFunctionSymbol(node);
      case "class_declaration":
      case "class_expression":
        return this.extractClassSymbol(node);
      case "interface_declaration":
        return this.extractInterfaceSymbol(node);
      default:
        return undefined;
    }
  }

  private extractFunctionSymbol(node: Node): ExtractedSymbol | undefined {
    const nameNode = node.childForFieldName("name");
    if (!nameNode) return undefined;
    const symbol: ExtractedSymbol = {
      name: nameNode.text,
      type: node.type === "method_definition" ? "method" : "function",
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1
    };
    const parentName = this.findParentName(node);
    if (parentName) {
      symbol.parentName = parentName;
    }
    return symbol;
  }

  private extractClassSymbol(node: Node): ExtractedSymbol | undefined {
    const nameNode = node.childForFieldName("name");
    if (!nameNode) return undefined;
    const symbol: ExtractedSymbol = {
      name: nameNode.text,
      type: "class",
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1
    };
    const parentName = this.findParentName(node);
    if (parentName) {
      symbol.parentName = parentName;
    }
    return symbol;
  }

  private extractInterfaceSymbol(node: Node): ExtractedSymbol | undefined {
    const nameNode = node.childForFieldName("name");
    if (!nameNode) return undefined;
    const symbol: ExtractedSymbol = {
      name: nameNode.text,
      type: "interface",
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1
    };
    const parentName = this.findParentName(node);
    if (parentName) {
      symbol.parentName = parentName;
    }
    return symbol;
  }

  private findParentName(node: Node): string | undefined {
    let parent = node.parent;
    while (parent) {
      if (parent.type === "class_declaration" || parent.type === "class_expression") {
        const nameNode = parent.childForFieldName("name");
        if (nameNode) return nameNode.text;
      }
      parent = parent.parent;
    }
    return undefined;
  }
}
