import type { Diagnostics } from "../services/diagnostics";
import type { GitignoreService } from "../services/gitignoreService";
import type { WorkspaceManager } from "../services/workspaceManager";
import type { WebviewPanelManager } from "../webview/webviewPanelManager";
import type { PerformanceMonitor } from "../services/performanceMonitor";
import type { DiagnosticService } from "../services/diagnosticService";
import type { ConfigurationService } from "../services/configurationService";
import type { ErrorReporter } from "../services/errorReporter";
import type * as vscode from "vscode";
import type { OutputWriter } from "../services/outputWriter";

export interface CommandServices {
	diagnostics: Diagnostics;
	gitignoreService: GitignoreService;
	workspaceManager: WorkspaceManager;
	webviewPanelManager: WebviewPanelManager;
	performanceMonitor: PerformanceMonitor;
	diagnosticService: DiagnosticService;
	configurationService: ConfigurationService;
	errorReporter: ErrorReporter;
	extensionUri: vscode.Uri;
	outputWriter: OutputWriter;
}
