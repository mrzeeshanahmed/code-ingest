import { jest } from "@jest/globals";
import * as path from "node:path";
import * as vscode from "vscode";

interface WorkspaceMock {
  getConfiguration: jest.MockedFunction<typeof vscode.workspace.getConfiguration>;
  workspaceFolders: Array<vscode.WorkspaceFolder> | undefined;
  rootPath?: string;
  getWorkspaceFolder: jest.MockedFunction<typeof vscode.workspace.getWorkspaceFolder>;
}

const workspaceMock = vscode.workspace as unknown as WorkspaceMock;

const baseConfigurationSnapshot: Record<string, unknown> = {
  binaryFilePolicy: "skip",
  maxFileSize: 5 * 1024 * 1024,
  streamingThreshold: 512 * 1024,
  detectLanguage: true,
  encoding: "utf8",
  processingTimeout: 30_000,
  processingConcurrency: 4,
  cache: {
    enabled: true,
    persistToDisk: false,
    compressionLevel: 3
  },
  includeCodeCells: true,
  includeMarkdownCells: true,
  includeCellOutputs: true,
  notebookIncludeCodeCells: true,
  notebookIncludeMarkdownCells: true,
  notebookIncludeOutputs: true,
  notebookIncludeNonTextOutputs: false,
  binaryWhitelist: [],
  binaryBlacklist: []
};

let currentConfigurationSnapshot: Record<string, unknown> = { ...baseConfigurationSnapshot };

workspaceMock.getConfiguration.mockImplementation(((section?: string) => {
  void section;
  return {
    get: <T>(key: string, fallback?: T) => (currentConfigurationSnapshot[key] as T | undefined) ?? fallback,
    has: jest.fn((key: string) => Object.prototype.hasOwnProperty.call(currentConfigurationSnapshot, key)),
    inspect: jest.fn(() => undefined),
    update: jest.fn(() => Promise.resolve())
  } as unknown as vscode.WorkspaceConfiguration;
}) as never);

export function configureWorkspaceEnvironment(workspaceRoot?: string, overrides: Record<string, unknown> = {}): void {
  currentConfigurationSnapshot = { ...baseConfigurationSnapshot, ...overrides };

  if (workspaceRoot) {
    const folder: vscode.WorkspaceFolder = {
      uri: vscode.Uri.file(workspaceRoot),
      index: 0,
      name: path.basename(workspaceRoot)
    };

    workspaceMock.workspaceFolders = [folder];
    workspaceMock.getWorkspaceFolder.mockReturnValue(folder);
    workspaceMock.rootPath = workspaceRoot;
  } else {
    workspaceMock.workspaceFolders = [];
    workspaceMock.getWorkspaceFolder.mockReturnValue(undefined as never);
    delete workspaceMock.rootPath;
  }
}

export function resetWorkspaceEnvironment(): void {
  configureWorkspaceEnvironment();
}
