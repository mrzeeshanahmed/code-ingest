import * as vscode from "vscode";
import { COMMAND_MAP } from "./commandMap";
import type { CommandRegistrar, CommandServices } from "./types";
import type { WorkspaceManager } from "../services/workspaceManager";

const REDACTION_STATE_KEY = "codeIngest.redactionOverride";

type TogglePayload = {
  readonly enabled?: boolean;
};

export function registerRedactionCommands(
  context: vscode.ExtensionContext,
  services: CommandServices,
  registerCommand: CommandRegistrar
): void {
  const pushStateToWebview = (override: boolean) => {
    const configSnapshot = { ...services.configurationService.getConfig(), redactionOverride: override };

    services.webviewPanelManager.setStateSnapshot({
      config: configSnapshot,
      redactionOverride: override
    });
  };

  const persistOverride = async (override: boolean): Promise<void> => {
    await context.globalState.update(REDACTION_STATE_KEY, override);
  };

  const applyOverride = async (override: boolean): Promise<boolean> => {
    services.workspaceManager.setRedactionOverride(override);
    pushStateToWebview(override);
    await persistOverride(override);
    services.diagnostics.add(`Redaction override ${override ? "enabled" : "disabled"}.`);
    return override;
  };

  const toggleOverride = async (): Promise<boolean> => {
    const next = !services.workspaceManager.getRedactionOverride();
    await applyOverride(next);
    void vscode.window.showInformationMessage(
      `Code Ingest: Redaction override ${next ? "enabled" : "disabled"}.`
    );
    return next;
  };

  const handlePayload = async (payload?: TogglePayload): Promise<boolean> => {
    if (payload && typeof payload.enabled === "boolean") {
      return applyOverride(payload.enabled);
    }
    return toggleOverride();
  };

  const toggleCommandIds = new Set([
    COMMAND_MAP.WEBVIEW_TO_HOST.TOGGLE_REDACTION,
    "codeIngest.toggleRedactionOverride"
  ]);

  toggleCommandIds.forEach((commandId) => {
    registerCommand(commandId, async (...args: unknown[]) => {
      const payload = (args[0] ?? undefined) as TogglePayload | undefined;
      return handlePayload(payload);
    });
  });

  // Ensure the webview receives the initial state when commands are registered.
  pushStateToWebview(services.workspaceManager.getRedactionOverride());
}

export function hydrateRedactionOverride(
  context: vscode.ExtensionContext,
  workspaceManager: WorkspaceManager
): void {
  const persisted = context.globalState.get<boolean>(REDACTION_STATE_KEY, false);
  workspaceManager.setRedactionOverride(persisted);
}
