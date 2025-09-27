import * as vscode from "vscode";
import type { CodeIngestTreeProvider } from "../tree/codeIngestTreeProvider";

export function getActiveWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
	const activeEditorUri = vscode.window.activeTextEditor?.document.uri;
	if (activeEditorUri) {
		return vscode.workspace.getWorkspaceFolder(activeEditorUri) ?? undefined;
	}

	const workspaceFolders = vscode.workspace.workspaceFolders;
	return workspaceFolders && workspaceFolders.length > 0 ? workspaceFolders[0] : undefined;
}

export function getActiveProvider(
	treeProviders: Map<string, CodeIngestTreeProvider>
): CodeIngestTreeProvider | undefined {
	const workspaceFolder = getActiveWorkspaceFolder();
	if (!workspaceFolder) {
		return undefined;
	}

	return treeProviders.get(workspaceFolder.uri.fsPath);
}
