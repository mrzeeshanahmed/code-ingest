import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { GrammarAssetResolver } from "./GrammarAssetResolver";

export interface BufferResolution {
  content: string;
  contentSource: "dirty-buffer" | "disk";
  contentHash: string;
  snapshotTimestamp: number;
  diskMtimeMsAtResolve?: number;
  grammarUri: string | undefined;
}

export class DirtyBufferResolver {
  constructor(
    private readonly workspaceRoot: vscode.Uri,
    private readonly grammarResolver: GrammarAssetResolver
  ) {}

  public async resolve(relativePath: string): Promise<BufferResolution | undefined> {
    const absolutePath = path.join(this.workspaceRoot.fsPath, relativePath);
    const document = this.findOpenDocument(absolutePath);

    if (document && document.isDirty) {
      const content = document.getText();
      const stats = await fs.stat(absolutePath);
      return {
        content,
        contentSource: "dirty-buffer",
        contentHash: this.computeHash(content),
        snapshotTimestamp: Date.now(),
        diskMtimeMsAtResolve: stats.mtimeMs,
        grammarUri: this.grammarResolver.resolve(this.detectLanguageId(relativePath))
      };
    }

    try {
      const buffer = await fs.readFile(absolutePath);
      const stats = await fs.stat(absolutePath);
      const content = buffer.toString("utf8");
      return {
        content,
        contentSource: "disk",
        contentHash: this.computeHash(content),
        snapshotTimestamp: Date.now(),
        diskMtimeMsAtResolve: stats.mtimeMs,
        grammarUri: this.grammarResolver.resolve(this.detectLanguageId(relativePath))
      };
    } catch {
      return undefined;
    }
  }

  private findOpenDocument(absolutePath: string): vscode.TextDocument | undefined {
    return vscode.workspace.textDocuments.find((doc) => doc.uri.fsPath === absolutePath);
  }

  private computeHash(content: string): string {
    return crypto.createHash("sha256").update(content).digest("hex");
  }

  private detectLanguageId(relativePath: string): string {
    const ext = path.extname(relativePath).toLowerCase();
    switch (ext) {
      case ".ts":
      case ".tsx":
        return "typescript";
      case ".js":
      case ".jsx":
        return "javascript";
      case ".py":
        return "python";
      case ".java":
        return "java";
      case ".go":
        return "go";
      case ".rs":
        return "rust";
      default:
        return ext.replace(/^\./u, "") || "plaintext";
    }
  }
}
