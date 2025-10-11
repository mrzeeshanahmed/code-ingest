import * as vscode from "vscode";
import { COMMAND_MAP } from "./commandMap";
import type { CommandServices } from "./types";

export function registerGenerateDigestCommand(
  context: vscode.ExtensionContext,
  services: CommandServices
): void {
  const disposable = vscode.commands.registerCommand(COMMAND_MAP.WEBVIEW_TO_HOST.GENERATE_DIGEST, async () => {
    services.diagnostics.add("Generate digest command invoked.");
    services.webviewPanelManager.createAndShowPanel();

    await vscode.window.showInformationMessage(
      "Code Ingest: Digest generation is orchestrated from the dashboard."
    );
  });

  context.subscriptions.push(disposable);
}
