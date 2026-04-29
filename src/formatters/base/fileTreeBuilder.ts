import type { ProcessedFileContent } from "../../services/digestGenerator";

export interface FileTreeNode {
  name: string;
  isFile: boolean;
  children: Map<string, FileTreeNode>;
}

export interface FileTreeView {
  readonly nested: string[];
  readonly ascii: string[];
  readonly mermaid: string[];
}

export class FileTree {
  public constructor(private readonly root: FileTreeNode) {}

  public hasEntries(): boolean {
    return this.root.children.size > 0;
  }

  public toNestedList(indent = "  "): string[] {
    const lines: string[] = [];
    const traverse = (node: FileTreeNode, depth: number): void => {
      const entries = Array.from(node.children.values()).sort((a, b) => a.name.localeCompare(b.name));
      for (const child of entries) {
        lines.push(`${indent.repeat(depth)}- ${child.name}`);
        if (child.children.size > 0) {
          traverse(child, depth + 1);
        }
      }
    };

    traverse(this.root, 0);
    return lines;
  }

  public toAsciiTree(): string[] {
    if (this.root.children.size === 0) {
      return ["<no files>"];
    }

    const lines: string[] = [];
    const traverse = (node: FileTreeNode, prefix: string): void => {
      const entries = Array.from(node.children.values()).sort((a, b) => a.name.localeCompare(b.name));
      entries.forEach((child, index) => {
        const isLast = index === entries.length - 1;
        const connector = isLast ? "└──" : "├──";
        lines.push(`${prefix}${connector} ${child.name}`);
        const nextPrefix = prefix + (isLast ? "    " : "│   ");
        if (child.children.size > 0) {
          traverse(child, nextPrefix);
        }
      });
    };

    traverse(this.root, "");
    return lines;
  }

  public toMermaidLines(rootLabel = "Workspace"): string[] {
    const lines: string[] = [this.createNodeDeclaration("root", rootLabel)];

    const traverse = (node: FileTreeNode, parentId: string): void => {
      const entries = Array.from(node.children.values()).sort((a, b) => a.name.localeCompare(b.name));
      entries.forEach((child, index) => {
        const childId = `${parentId}_${this.slugify(child.name)}_${index}`;
        lines.push(this.createNodeDeclaration(childId, child.name));
        lines.push(`${parentId} --> ${childId}`);
        if (child.children.size > 0) {
          traverse(child, childId);
        }
      });
    };

    traverse(this.root, "root");
    return lines;
  }

  public toView(rootLabel = "Workspace"): FileTreeView {
    return {
      nested: this.toNestedList(),
      ascii: this.toAsciiTree(),
      mermaid: this.toMermaidLines(rootLabel)
    } satisfies FileTreeView;
  }

  private createNodeDeclaration(id: string, label: string): string {
    const escaped = label.replace(/"/g, '\\\"');
    return `${id}["${escaped}"]`;
  }

  private slugify(value: string): string {
    const slug = value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");

    return slug.length > 0 ? slug : "node";
  }
}

export class FileTreeBuilder {
  public static fromFiles(files: ProcessedFileContent[] | string[]): FileTree {
    const entries = files as Array<ProcessedFileContent | string>;
    const paths = entries.map((entry) => (typeof entry === "string" ? entry : entry.relativePath));
    return this.fromPaths(paths);
  }

  public static fromPaths(paths: string[]): FileTree {
    const root: FileTreeNode = { name: "", isFile: false, children: new Map() };

    paths.forEach((rawPath) => {
      const segments = rawPath.split(/\\|\//).filter((segment) => segment.length > 0);
      if (segments.length === 0) {
        return;
      }

      let current = root;
      segments.forEach((segment, index) => {
        if (!current.children.has(segment)) {
          current.children.set(segment, {
            name: segment,
            isFile: index === segments.length - 1,
            children: new Map()
          });
        }

        const next = current.children.get(segment)!;
        if (index === segments.length - 1) {
          next.isFile = true;
        }
        current = next;
      });
    });

    return new FileTree(root);
  }
}