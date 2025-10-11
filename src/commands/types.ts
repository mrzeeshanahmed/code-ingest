import type { Diagnostics } from "../services/diagnostics";
import type { GitignoreService } from "../services/gitignoreService";
import type { WorkspaceManager } from "../services/workspaceManager";
import type { WebviewPanelManager } from "../webview/webviewPanelManager";
import type { PerformanceMonitor } from "../services/performanceMonitor";
import type { DiagnosticService } from "../services/diagnosticService";

export interface CommandServices {
	diagnostics: Diagnostics;
	gitignoreService: GitignoreService;
	workspaceManager: WorkspaceManager;
	webviewPanelManager: WebviewPanelManager;
	performanceMonitor: PerformanceMonitor;
	diagnosticService: DiagnosticService;
}
