// Auto-generated TypeScript definitions for webview commands
// Generated on: 2025-10-15T13:29:49.518Z

export interface CommandMap {
  HOST_TO_WEBVIEW: {
    restoreState: 'codeIngest.restoreState';
    showError: 'codeIngest.showError';
    updateConfig: 'codeIngest.updateConfig';
    updatePreview: 'codeIngest.updatePreview';
    updateProgress: 'codeIngest.updateProgress';
    updateTreeData: 'codeIngest.updateTreeData';
  };

  WEBVIEW_TO_HOST: {
    applyPreset: 'codeIngest.applyPreset';
    collapseAll: 'codeIngest.collapseAll';
    deselectAll: 'codeIngest.deselectAll';
    expandAll: 'codeIngest.expandAll';
    flushErrorReports: 'codeIngest.flushErrorReports';
    generateDigest: 'codeIngest.generateDigest';
    loadRemoteRepo: 'codeIngest.loadRemoteRepo';
    openDashboardPanel: 'codeIngest.openDashboardPanel';
    refreshPreview: 'codeIngest.refreshPreview';
    refreshTree: 'codeIngest.refreshTree';
  copyPreview: 'codeIngest.copyPreview';
    selectAll: 'codeIngest.selectAll';
    toggleRedactionOverride: 'codeIngest.toggleRedactionOverride';
    updateSelection: 'codeIngest.updateSelection';
    viewMetrics: 'codeIngest.viewMetrics';
    webviewReady: 'codeIngest.webviewReady';
  };
}

export type HostToWebviewCommand = CommandMap['HOST_TO_WEBVIEW'][keyof CommandMap['HOST_TO_WEBVIEW']];
export type WebviewToHostCommand = CommandMap['WEBVIEW_TO_HOST'][keyof CommandMap['WEBVIEW_TO_HOST']];

export interface MessageEnvelope<T = unknown> {
  id: string;
  type: 'command' | 'response' | 'event';
  command: string;
  payload: T;
  timestamp: number;
  token: string;
}
