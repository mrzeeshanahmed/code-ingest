// Auto-generated TypeScript definitions for webview commands
// Generated on: 2025-10-09T14:20:47.878Z

export interface CommandMap {
  HOST_TO_WEBVIEW: {
    arrowDown: 'ArrowDown';
    arrowLeft: 'ArrowLeft';
    arrowRight: 'ArrowRight';
    arrowUp: 'ArrowUp';
    enter: 'Enter';
    array: 'array';
    boolean: 'boolean';
    clearSelection: 'clear-selection';
    enum: 'enum';
    number: 'number';
    object: 'object';
    selectAll: 'select-all';
    string: 'string';
    unknown: 'unknown';
  };

  WEBVIEW_TO_HOST: {
    flushErrorReports: 'codeIngest.flushErrorReports';
    generateDigest: 'codeIngest.generateDigest';
    invertSelection: 'codeIngest.invertSelection';
    loadRemoteRepo: 'codeIngest.loadRemoteRepo';
    openDashboardPanel: 'codeIngest.openDashboardPanel';
    refreshTree: 'codeIngest.refreshTree';
    selectAll: 'codeIngest.selectAll';
    selectNone: 'codeIngest.selectNone';
    toggleRedactionOverride: 'codeIngest.toggleRedactionOverride';
    treeLoadMore: 'codeIngest.tree.loadMore';
    treeRetryDirectory: 'codeIngest.tree.retryDirectory';
    viewMetrics: 'codeIngest.viewMetrics';
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
