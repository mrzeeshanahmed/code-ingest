export const COMMAND_MAP = {
  refreshTree: "codeIngest.refreshTree",
  generateDigest: "codeIngest.generateDigest",
  openDashboard: "codeIngest.openDashboard",
  expandAll: "codeIngest.expandAll",
  collapseAll: "codeIngest.collapseAll",
  refreshPreview: "codeIngest.refreshPreview",
  selectAll: "codeIngest.selectAll",
  deselectAll: "codeIngest.deselectAll",
  ingestRemoteRepo: "codeIngest.ingestRemoteRepo"
} as const;

export type CommandKey = keyof typeof COMMAND_MAP;
export type CommandId = (typeof COMMAND_MAP)[CommandKey];
