import * as vscode from "vscode";
import { registerRefreshCommand } from "./refreshCommand";
import { registerGenerateDigestCommand } from "./generateDigest";
import { registerSelectionCommands } from "./selectionCommands";
import { registerIngestRemoteRepoCommand } from "./ingestRemoteRepo";
import { registerRedactionCommands } from "./redactionCommands";
import type { CommandRegistrar, CommandServices } from "./types";

export function registerAllCommands(
  context: vscode.ExtensionContext,
  services: CommandServices,
  registerCommand: CommandRegistrar
): void {
  registerRefreshCommand(context, services, registerCommand);
  registerGenerateDigestCommand(context, services, registerCommand);
  registerSelectionCommands(context, services, registerCommand);
  registerIngestRemoteRepoCommand(context, services, registerCommand);
  registerRedactionCommands(context, services, registerCommand);
}
