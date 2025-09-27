import * as vscode from "vscode";
import { registerRefreshCommand } from "./refreshCommand";
import { registerGenerateDigestCommand } from "./generateDigest";
import { registerSelectionCommands } from "./selectionCommands";
import { registerIngestRemoteRepoCommand } from "./ingestRemoteRepo";
import type { CommandServices } from "./types";

export function registerAllCommands(context: vscode.ExtensionContext, services: CommandServices): void {
  registerRefreshCommand(context, services);
  registerGenerateDigestCommand(context, services);
  registerSelectionCommands(context, services);
  registerIngestRemoteRepoCommand(context, services);
}
