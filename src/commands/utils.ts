import * as vscode from "vscode";
export function getActiveWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
	const activeEditorUri = vscode.window.activeTextEditor?.document.uri;
	if (activeEditorUri) {
		return vscode.workspace.getWorkspaceFolder(activeEditorUri) ?? undefined;
	}

	const workspaceFolders = vscode.workspace.workspaceFolders;
	return workspaceFolders && workspaceFolders.length > 0 ? workspaceFolders[0] : undefined;
}
