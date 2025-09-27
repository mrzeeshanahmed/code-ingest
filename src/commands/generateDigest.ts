import * as vscode from "vscode";
import { COMMAND_MAP } from "./commandMap";
import type { CommandServices } from "./types";
import { getActiveProvider } from "./utils";

export function registerGenerateDigestCommand(
  context: vscode.ExtensionContext,
  services: CommandServices
): void {
  const disposable = vscode.commands.registerCommand(COMMAND_MAP.generateDigest, async () => {
    const provider = getActiveProvider(services.treeProviders);

    if (!provider) {
      void vscode.window.showWarningMessage(
        "Code Ingest: No active workspace tree available to generate a digest."
      );
      return;
    }

    services.diagnostics.add("Generate digest command invoked.");
    services.webviewPanelManager.createAndShowPanel();

    void vscode.window.showInformationMessage(
      "Code Ingest: Digest generation flow is not implemented yet."
    );
    provider.refresh();
  });

  context.subscriptions.push(disposable);
}
