import * as vscode from "vscode";
import * as path from "node:path";
import type { FileMetadata, FileNode } from "../services/fileScanner";

const languageIconMap = new Map<string, string>([
  ["typescript", "file-code"],
  ["javascript", "file-code"],
  ["python", "file-code"],
  ["java", "file-code"],
  ["csharp", "file-code"],
  ["markdown", "book"],
  ["json", "settings"],
  ["notebook", "notebook"],
  ["yaml", "gear"],
  ["xml", "code"],
  ["sql", "database"],
  ["dockerfile", "terminal"],
  ["shellscript", "terminal"]
]);

const binaryIcon = new vscode.ThemeIcon("file-binary");
const symlinkIcon = new vscode.ThemeIcon("link");
const notebookIcon = new vscode.ThemeIcon("notebook");
const directoryIcon = new vscode.ThemeIcon("folder");
const directoryOpenIcon = new vscode.ThemeIcon("folder-opened");

export function createTreeIcon(fileNode: FileNode, isExpanded: boolean): vscode.ThemeIcon {
  if (fileNode.placeholder) {
    return new vscode.ThemeIcon(fileNode.placeholderKind === "loadMore" ? "arrow-down" : "sync");
  }

  if (fileNode.type === "directory") {
    return isExpanded ? directoryOpenIcon : directoryIcon;
  }

  const metadata = fileNode.metadata ?? {};
  if (metadata.isSymbolicLink) {
    return symlinkIcon;
  }

  if (metadata.isBinary) {
    return binaryIcon;
  }

  if (fileNode.name.toLowerCase().endsWith(".ipynb")) {
    return notebookIcon;
  }

  const iconId = metadata.languageId ? languageIconMap.get(metadata.languageId) : undefined;
  if (iconId) {
    return new vscode.ThemeIcon(iconId);
  }

  const ext = path.extname(fileNode.name).toLowerCase();
  switch (ext) {
    case ".md":
      return new vscode.ThemeIcon("book");
    case ".json":
    case ".yaml":
    case ".yml":
      return new vscode.ThemeIcon("settings");
    case ".sh":
    case ".bash":
    case ".zsh":
      return new vscode.ThemeIcon("terminal");
    case ".sql":
      return new vscode.ThemeIcon("database");
    default:
      return new vscode.ThemeIcon("file");
  }
}

function formatSize(size?: number): string | undefined {
  if (typeof size !== "number" || Number.isNaN(size)) {
    return undefined;
  }
  if (size < 1024) {
    return `${size} bytes`;
  }
  const kb = size / 1024;
  if (kb < 1024) {
    return `${kb.toFixed(1)} KB`;
  }
  const mb = kb / 1024;
  if (mb < 1024) {
    return `${mb.toFixed(1)} MB`;
  }
  const gb = mb / 1024;
  return `${gb.toFixed(1)} GB`;
}

function formatTimestamp(timestamp?: number): string | undefined {
  if (typeof timestamp !== "number" || Number.isNaN(timestamp)) {
    return undefined;
  }
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short"
    }).format(new Date(timestamp));
  } catch {
    return undefined;
  }
}

function appendMetadataLines(markdown: vscode.MarkdownString, metadata?: FileMetadata): void {
  if (!metadata) {
    return;
  }
  const size = formatSize(metadata.size);
  const modified = formatTimestamp(metadata.modified);
  const created = formatTimestamp(metadata.created);

  if (size) {
    markdown.appendMarkdown(`*Size:* ${size}\n`);
  }
  if (modified) {
    markdown.appendMarkdown(`*Modified:* ${modified}\n`);
  }
  if (created && created !== modified) {
    markdown.appendMarkdown(`*Created:* ${created}\n`);
  }
  if (metadata.isSymbolicLink) {
    markdown.appendMarkdown(`*Symlink:* Yes\n`);
  }
  if (metadata.isBinary) {
    markdown.appendMarkdown(`*Binary:* Yes\n`);
  }
  if (metadata.languageId) {
    markdown.appendMarkdown(`*Language:* ${metadata.languageId}\n`);
  }
}

export function formatTooltip(fileNode: FileNode): vscode.MarkdownString {
  const tooltip = new vscode.MarkdownString();
  tooltip.supportHtml = false;
  tooltip.supportThemeIcons = true;
  tooltip.appendMarkdown(`**${fileNode.name}**\n\n`);
  tooltip.appendMarkdown(`*Path:* \`${fileNode.relPath ?? fileNode.uri}\`\n`);
  if (typeof fileNode.childCount === "number") {
    tooltip.appendMarkdown(`*Children:* ${fileNode.childCount}\n`);
  }
  appendMetadataLines(tooltip, fileNode.metadata);
  return tooltip;
}
