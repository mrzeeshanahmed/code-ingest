import * as path from "path";

export class Formatters {
  /**
   * Builds a standardized header for a file section in the digest.
   */
  public static buildFileHeader(filePath: string, tokenCount: number): string {
    return `--- FILE: ${filePath} (${Formatters.formatTokenCount(tokenCount)}) ---`;
  }

  /**
   * Builds a textual summary block for the digest.
   */
  public static buildSummary(totalFiles: number, totalTokens: number): string {
    return [
      "Summary",
      "-------",
      `Files processed: ${totalFiles}`,
      `Total tokens: ${Formatters.formatTokenCount(totalTokens)}`
    ].join("\n");
  }

  /**
   * Builds an ASCII tree from the provided file paths relative to the workspace root.
   */
  public static buildFileTree(filePaths: string[], workspaceRoot: string): string {
    const header = ["File Tree", "---------"];
    if (!filePaths || filePaths.length === 0) {
      return [...header, "<no files>", ""].join("\n");
    }

    const normalizedRoot = path.resolve(workspaceRoot || ".");
    const relPaths = filePaths
      .map((filePath) => {
        const rel = path.relative(normalizedRoot, path.resolve(filePath)).split(path.sep).join("/");
        return rel.length === 0 ? path.basename(filePath) : rel;
      })
      .filter((rel) => rel.length > 0)
      .sort((a, b) => a.localeCompare(b));

    type TreeNode = {
      name: string;
      isFile: boolean;
      children: Map<string, TreeNode>;
    };

    const rootNode: TreeNode = { name: "", isFile: false, children: new Map() };

    for (const relPath of relPaths) {
      const segments = relPath.split("/");
      let current = rootNode;
      segments.forEach((segment, index) => {
        const isFile = index === segments.length - 1;
        if (!current.children.has(segment)) {
          current.children.set(segment, {
            name: segment,
            isFile,
            children: new Map()
          });
        }
        const next = current.children.get(segment)!;
        if (isFile) {
          next.isFile = true;
        }
        current = next;
      });
    }

    const lines: string[] = [];

    const traverse = (node: TreeNode, prefix: string) => {
      const entries = Array.from(node.children.values()).sort((a, b) => a.name.localeCompare(b.name));
      entries.forEach((child, index) => {
        const isLast = index === entries.length - 1;
        const connector = isLast ? "└── " : "├── ";
        lines.push(`${prefix}${connector}${child.name}`);
        const nextPrefix = prefix + (isLast ? "    " : "│   ");
        if (child.children.size > 0) {
          traverse(child, nextPrefix);
        }
      });
    };

    traverse(rootNode, "");

    return [...header, ...lines, ""].join("\n");
  }

  private static formatTokenCount(value: number): string {
    const abs = Math.abs(value);
    if (abs < 1_000) {
      return `${value} tokens`;
    }
    if (abs < 1_000_000) {
      return `${Formatters.formatWithPrecision(value / 1_000)}k tokens`;
    }
    if (abs < 1_000_000_000) {
      return `${Formatters.formatWithPrecision(value / 1_000_000)}M tokens`;
    }
    return `${Formatters.formatWithPrecision(value / 1_000_000_000)}B tokens`;
  }

  private static formatWithPrecision(value: number): string {
    const rounded = Math.round(value * 10) / 10;
    return Number.isInteger(rounded) ? `${rounded.toFixed(0)}` : `${rounded.toFixed(1)}`;
  }
}
