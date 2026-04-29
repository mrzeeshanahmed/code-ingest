import * as fs from "node:fs";
import * as vscode from "vscode";

export interface GrammarAssetManifest {
  readonly version: number;
  readonly generatedAt?: string | undefined;
  readonly grammars: Record<string, string>;
  readonly runtimes?: Record<string, string> | undefined;
}

export const BASELINE_LANGUAGE_GRAMMARS: Readonly<Record<string, string>> = Object.freeze({
  javascript: "out/grammars/tree-sitter-javascript.wasm",
  javascriptreact: "out/grammars/tree-sitter-javascript.wasm",
  typescript: "out/grammars/tree-sitter-typescript.wasm",
  typescriptreact: "out/grammars/tree-sitter-tsx.wasm"
});

const GRAMMAR_MANIFEST_SEGMENTS = ["out", "grammars", "manifest.json"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!isRecord(value)) {
    return false;
  }

  return Object.values(value).every((entry) => typeof entry === "string");
}

function isGrammarAssetManifest(value: unknown): value is GrammarAssetManifest {
  if (!isRecord(value)) {
    return false;
  }

  if (typeof value.version !== "number" || !isStringRecord(value.grammars)) {
    return false;
  }

  return value.runtimes === undefined || isStringRecord(value.runtimes);
}

function splitPackagedPath(packagedPath: string): string[] {
  return packagedPath
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function normalizeLanguageId(languageId: string): string {
  return languageId.trim().toLowerCase();
}

export class GrammarNotFoundError extends Error {
  constructor(
    public readonly languageId: string,
    public readonly expectedPath: string,
    reason = "Required packaged grammar asset is missing."
  ) {
    super(`${reason} Language \"${languageId}\" expected at ${expectedPath}.`);
    this.name = "GrammarNotFoundError";
  }
}

export class GrammarAssetResolver {
  private manifest: GrammarAssetManifest | null | undefined;

  constructor(private readonly extensionUri: vscode.Uri) {}

  public resolve(languageId: string): string | undefined {
    const normalizedLanguageId = normalizeLanguageId(languageId);
    const packagedPath = this.getPackagedGrammarPath(normalizedLanguageId);
    if (!packagedPath) {
      return undefined;
    }

    const grammarUri = vscode.Uri.joinPath(this.extensionUri, ...splitPackagedPath(packagedPath));
    if (!fs.existsSync(grammarUri.fsPath)) {
      throw new GrammarNotFoundError(normalizedLanguageId, grammarUri.toString());
    }

    return grammarUri.toString();
  }

  private getPackagedGrammarPath(languageId: string): string | undefined {
    const manifest = this.loadManifest();
    return manifest?.grammars[languageId] ?? BASELINE_LANGUAGE_GRAMMARS[languageId];
  }

  private loadManifest(): GrammarAssetManifest | undefined {
    if (this.manifest !== undefined) {
      return this.manifest ?? undefined;
    }

    const manifestUri = vscode.Uri.joinPath(this.extensionUri, ...GRAMMAR_MANIFEST_SEGMENTS);
    if (!fs.existsSync(manifestUri.fsPath)) {
      this.manifest = null;
      return undefined;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(manifestUri.fsPath, "utf8")) as unknown;
    } catch (error) {
      throw new Error(`Unable to read grammar asset manifest at ${manifestUri.fsPath}: ${(error as Error).message}`);
    }

    if (!isGrammarAssetManifest(parsed)) {
      throw new Error(`Grammar asset manifest at ${manifestUri.fsPath} is invalid.`);
    }

    this.manifest = parsed;
    return parsed;
  }
}