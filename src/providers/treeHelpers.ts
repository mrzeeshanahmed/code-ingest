import * as vscode from "vscode";
import type { FileNode } from "../services/fileScanner";

export function createTreeIcon(fileNode: FileNode): vscode.ThemeIcon {
  if (fileNode.type === "directory") {
    return new vscode.ThemeIcon("folder");
  }

  return new vscode.ThemeIcon("file");
}

export function formatTooltip(fileNode: FileNode): vscode.MarkdownString {
  const tooltip = new vscode.MarkdownString();
  tooltip.supportHtml = false;
  tooltip.supportThemeIcons = true;
  tooltip.appendMarkdown(`**${fileNode.name}**\n\n`);
  tooltip.appendMarkdown(`URI: \`${fileNode.uri}\``);
  return tooltip;
}
