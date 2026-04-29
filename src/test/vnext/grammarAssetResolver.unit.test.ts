import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { GrammarAssetResolver, GrammarNotFoundError } from "../../graph/indexer/GrammarAssetResolver";

describe("GrammarAssetResolver", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "grammar-asset-resolver-"));
    await fs.mkdir(path.join(tempDir, "out", "grammars"), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test("returns undefined for unsupported languages", () => {
    const resolver = new GrammarAssetResolver(vscode.Uri.file(tempDir));

    expect(resolver.resolve("python")).toBeUndefined();
  });

  test("resolves packaged grammar URIs from the generated manifest", async () => {
    const manifestPath = path.join(tempDir, "out", "grammars", "manifest.json");
    const grammarPath = path.join(tempDir, "out", "grammars", "tree-sitter-typescript.wasm");

    await fs.writeFile(
      manifestPath,
      JSON.stringify(
        {
          version: 1,
          grammars: {
            typescript: "out/grammars/tree-sitter-typescript.wasm"
          },
          runtimes: {
            "tree-sitter-web": "out/wasm/web-tree-sitter.wasm"
          }
        },
        null,
        2
      ),
      "utf8"
    );
    await fs.writeFile(grammarPath, "wasm-binary-placeholder", "utf8");

    const resolver = new GrammarAssetResolver(vscode.Uri.file(tempDir));
    const resolved = resolver.resolve("typescript");

    expect(resolved).toContain(path.join("out", "grammars", "tree-sitter-typescript.wasm"));
  });

  test("throws a typed error when a required packaged grammar is missing", () => {
    const resolver = new GrammarAssetResolver(vscode.Uri.file(tempDir));

    expect(() => resolver.resolve("typescript")).toThrow(GrammarNotFoundError);
  });
});