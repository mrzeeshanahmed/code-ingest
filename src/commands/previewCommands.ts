import * as vscode from "vscode";

import { COMMAND_MAP } from "./commandMap";
import type { CommandRegistrar, CommandServices } from "./types";
import { wrapError } from "../utils/errorHandling";

export function registerPreviewCommands(
  _context: vscode.ExtensionContext,
  services: CommandServices,
  registerCommand: CommandRegistrar
): void {
  registerCommand(COMMAND_MAP.WEBVIEW_TO_HOST.COPY_PREVIEW, async () => {
    const snapshot = services.webviewPanelManager.getStateSnapshot();
    const preview = snapshot?.preview as { content?: string; format?: string } | undefined;
    const content = typeof preview?.content === "string" ? preview.content : "";

    if (!content.trim()) {
      const message = "Generate a digest before copying the preview.";
      services.webviewPanelManager.sendCommand(COMMAND_MAP.HOST_TO_WEBVIEW.SHOW_ERROR, {
        title: "Preview unavailable",
        message
      });
      const error = wrapError(new Error(message), {
        command: COMMAND_MAP.WEBVIEW_TO_HOST.COPY_PREVIEW,
        stage: "validate"
      });
      (error as { handledByHost?: boolean }).handledByHost = true;
      throw error;
    }

    try {
      const result = await services.outputWriter.writeToClipboard(content);
      if (!result.success) {
        throw new Error(result.error ?? "Clipboard copy failed");
      }
      services.diagnostics.add("Copied digest preview to clipboard.");
      await vscode.window.showInformationMessage("Code Ingest: Preview copied to clipboard.");
    } catch (error) {
      const wrapped = wrapError(error, {
        command: COMMAND_MAP.WEBVIEW_TO_HOST.COPY_PREVIEW,
        stage: "writeClipboard"
      });
      services.errorReporter.report(wrapped, {
        source: "copyPreview",
        metadata: { outcome: "failed" }
      });
      throw wrapped;
    }
  });
}
