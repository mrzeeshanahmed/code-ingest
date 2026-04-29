import * as path from "node:path";
import type { Stats } from "node:fs";
import { promises as fs } from "node:fs";
import * as vscode from "vscode";

export interface FileMetadata {
  size?: number | undefined;
  modified?: number | undefined;
  created?: number | undefined;
  isBinary?: boolean | undefined;
  isSymbolicLink?: boolean | undefined;
  languageId?: string | undefined;
}

export interface FileNode {
  uri: string;
  name: string;
  type: "file" | "directory";
  children?: FileNode[] | undefined;
  placeholder?: boolean | undefined;
  placeholderKind?: "scanning" | "loadMore" | undefined;
  metadata?: FileMetadata | undefined;
  childCount?: number | undefined;
  error?: string | undefined;
  relPath?: string | undefined;
}

export interface DirectoryScanOptions {
  offset?: number | undefined;
  limit?: number | undefined;
  token?: vscode.CancellationToken | undefined;
  includeHidden?: boolean | undefined;
  followSymlinks?: boolean | undefined;
  includeFiles?: boolean | undefined;
  includeDirectories?: boolean | undefined;
}

export interface DirectoryScanResult {
  nodes: FileNode[];
  total: number;
  hasMore: boolean;
  nextOffset: number;
}

export interface WorkspaceScanOptions {
  token?: vscode.CancellationToken | undefined;
  onProgress?: (processed: number, total?: number, currentPath?: string) => void;
  maxEntries?: number | undefined;
}

const DEFAULT_PAGE_SIZE = 200;

function detectLanguageId(fileName: string): string | undefined {
  const ext = path.extname(fileName).toLowerCase();
  switch (ext) {
    case ".ts":
    case ".tsx":
      return "typescript";
    case ".js":
    case ".jsx":
      return "javascript";
    case ".json":
      return "json";
    case ".md":
      return "markdown";
    case ".py":
      return "python";
    case ".java":
      return "java";
    case ".cs":
      return "csharp";
    case ".ipynb":
      return "notebook";
    default:
      return undefined;
  }
}

async function statSafe(target: string): Promise<Stats | undefined> {
  try {
    return await fs.stat(target);
  } catch {
    return undefined;
  }
}

function ensureNotCancelled(token?: vscode.CancellationToken): void {
  if (token?.isCancellationRequested) {
    throw new vscode.CancellationError();
  }
}

export class FileScanner {
  constructor(private readonly workspaceUri: vscode.Uri) {}

  async scanDirectoryShallow(uri: vscode.Uri, options: DirectoryScanOptions = {}): Promise<DirectoryScanResult> {
    const { offset = 0, limit = DEFAULT_PAGE_SIZE, includeHidden = false, followSymlinks = false, includeFiles = true, includeDirectories = true, token } = options;

    ensureNotCancelled(token);

    const absolutePath = uri.scheme === "file" ? uri.fsPath : uri.path;
    const entries = await fs.readdir(absolutePath, { withFileTypes: true });
    const total = entries.length;

    const slice = entries.slice(offset, offset + limit);
    const nodes: FileNode[] = [];

    for (const entry of slice) {
      ensureNotCancelled(token);

      const name = entry.name;
      if (!includeHidden && name.startsWith(".")) {
        continue;
      }

      const childPath = path.join(absolutePath, name);
      const childUri = vscode.Uri.file(childPath);
      const isDirectory = entry.isDirectory();
      const isSymbolicLink = entry.isSymbolicLink();

      if (isDirectory && !includeDirectories) {
        continue;
      }

      if (!isDirectory && !includeFiles) {
        continue;
      }

      if (isSymbolicLink && !followSymlinks) {
        nodes.push({
          uri: childUri.toString(),
          name,
          type: "file",
          metadata: { isSymbolicLink: true },
          relPath: path.relative(this.workspaceUri.fsPath, childPath)
        });
        continue;
      }

      const stats = await statSafe(childPath);
      const metadata: FileMetadata = {
        size: stats?.size,
        modified: stats?.mtimeMs,
        created: stats?.ctimeMs,
        isSymbolicLink,
        languageId: detectLanguageId(name),
        isBinary: stats ? (!stats.isDirectory() ? this.isBinaryByExtension(name) : undefined) : undefined
      };

      let childCount: number | undefined;
      if (isDirectory) {
        try {
          const childEntries = await fs.readdir(childPath);
          childCount = childEntries.length;
        } catch {
          childCount = undefined;
        }
      }

      nodes.push({
        uri: childUri.toString(),
        name,
        type: isDirectory ? "directory" : "file",
        metadata,
        relPath: path.relative(this.workspaceUri.fsPath, childPath),
        childCount
      });
    }

    const hasMore = offset + limit < total;
    const nextOffset = hasMore ? offset + limit : total;

    return {
      nodes,
      total,
      hasMore,
      nextOffset
    };
  }

  async scan(options: WorkspaceScanOptions = {}): Promise<FileNode[]> {
    const { token, onProgress, maxEntries } = options;
    ensureNotCancelled(token);

  const root = await this.scanDirectoryShallow(this.workspaceUri, { token });
    const queue: Array<{ node: FileNode; offset: number }> = [];
    const collected: FileNode[] = [];

    const clamp = (value: number | undefined, fallback: number) => (typeof value === "number" ? value : fallback);
    let processed = 0;

    const enqueueChildren = async (directoryNode: FileNode): Promise<void> => {
      ensureNotCancelled(token);
      queue.push({ node: directoryNode, offset: 0 });

      while (queue.length > 0) {
        ensureNotCancelled(token);
        const current = queue.shift();
        if (!current) {
          break;
        }
        const { node, offset } = current;
        if (node.type !== "directory") {
          continue;
        }

  const result = await this.scanDirectoryShallow(vscode.Uri.parse(node.uri), { offset, token });
  const enrichedNode: FileNode = { ...node, children: result.nodes, childCount: result.total };
  collected.push(...result.nodes);
        processed += result.nodes.length;
        onProgress?.(processed, undefined, node.uri);

        if (typeof maxEntries === "number" && processed >= maxEntries) {
          return;
        }

        for (const child of enrichedNode.children ?? []) {
          if (child.type === "directory") {
            queue.push({ node: child, offset: 0 });
          }
        }
      }
    };

    await enqueueChildren({ ...this.createWorkspaceRootNode(root) });

    const limited = typeof maxEntries === "number" ? collected.slice(0, clamp(maxEntries, collected.length)) : collected;
    return limited;
  }

  private createWorkspaceRootNode(result: DirectoryScanResult): FileNode {
    return {
      uri: this.workspaceUri.toString(),
      name: path.basename(this.workspaceUri.fsPath),
      type: "directory",
      children: result.nodes,
      childCount: result.total
    } satisfies FileNode;
  }

  private isBinaryByExtension(name: string): boolean {
    const binaryExtensions = new Set([
      ".png",
      ".jpg",
      ".jpeg",
      ".gif",
      ".bmp",
      ".ico",
      ".exe",
      ".dll",
      ".class",
      ".zip",
      ".tar",
      ".gz",
      ".7z",
      ".rar",
      ".pdf"
    ]);
    return binaryExtensions.has(path.extname(name).toLowerCase());
  }
}