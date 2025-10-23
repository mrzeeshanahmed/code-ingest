import { describe, expect, it, jest } from "@jest/globals";
import * as vscode from "vscode";
import { COMMAND_MAP } from "../../../commands/commandMap";
import { registerIngestRemoteRepoCommand } from "../../../commands/ingestRemoteRepo";
import type { CommandServices } from "../../../commands/types";

jest.mock("../../../services/githubService", () => ({
  authenticate: jest.fn(async () => "token"),
  partialClone: jest.fn(async () => ({ tempDir: "/tmp/repo" })),
  resolveRefToSha: jest.fn(async () => "deadbeef")
}));

jest.mock("../../../utils/procRedact", () => ({
  spawnGitPromise: jest.fn(async () => undefined)
}));

describe("ingestRemoteRepo command", () => {
  it("rejects payloads without repoUrl", async () => {
    const harness = createServiceHarness();
    const handlers = new Map<string, (...args: unknown[]) => unknown | Promise<unknown>>();

    registerIngestRemoteRepoCommand(
      { subscriptions: [] } as unknown as vscode.ExtensionContext,
      harness.services,
      (commandId, handler) => {
        handlers.set(commandId, handler);
        return { dispose: jest.fn() } as unknown as vscode.Disposable;
      }
    );

    const handler = handlers.get(COMMAND_MAP.WEBVIEW_TO_HOST.LOAD_REMOTE_REPO);
    expect(handler).toBeDefined();

    let capturedError: unknown;
    try {
      await handler?.({ ref: "main" });
    } catch (error) {
      capturedError = error;
    }

    expect(capturedError).toBeInstanceOf(Error);
    expect((capturedError as { handledByHost?: boolean }).handledByHost).toBe(true);
    expect(harness.webviewPanelManager.sendCommand).toHaveBeenCalledWith(
      COMMAND_MAP.HOST_TO_WEBVIEW.SHOW_ERROR,
      expect.objectContaining({
        title: "Remote ingestion failed",
        message: expect.stringContaining("repository URL")
      })
    );
    expect(harness.diagnostics.add).toHaveBeenCalledWith(
      expect.stringContaining("Remote ingest rejected")
    );
  });

  it("delegates execution through the workspace digest queue", async () => {
    const queueDigestOperation = jest.fn(async () => ({ ok: true }));
    const harness = createServiceHarness({
      workspaceManager: { queueDigestOperation } as unknown as CommandServices["workspaceManager"]
    });
    const handlers = new Map<string, (...args: unknown[]) => unknown | Promise<unknown>>();

    registerIngestRemoteRepoCommand(
      { subscriptions: [] } as unknown as vscode.ExtensionContext,
      harness.services,
      (commandId, handler) => {
        handlers.set(commandId, handler);
        return { dispose: jest.fn() } as unknown as vscode.Disposable;
      }
    );

    const handler = handlers.get(COMMAND_MAP.WEBVIEW_TO_HOST.LOAD_REMOTE_REPO);
    expect(handler).toBeDefined();

    await handler?.({ repoUrl: "https://github.com/acme/project", ref: "main" });

  expect(queueDigestOperation).toHaveBeenCalledTimes(1);
  const call = queueDigestOperation.mock.calls[0] as unknown[];
  expect(typeof call[0]).toBe("function");
  });
});

function createServiceHarness(overrides?: Partial<CommandServices>) {
  const diagnostics = { add: jest.fn(), clear: jest.fn(), getAll: jest.fn(() => []) };
  const webviewPanelManager = {
    sendCommand: jest.fn(),
    setStateSnapshot: jest.fn(),
    updateOperationState: jest.fn(),
    updateOperationProgress: jest.fn(),
    clearOperationProgress: jest.fn(),
    createAndShowPanel: jest.fn(),
    getStateSnapshot: jest.fn(),
    tryRestoreState: jest.fn(() => false)
  };

  const defaultWorkspaceManager = {
    queueDigestOperation: jest.fn(async () => ({ ok: true }))
  };

  const services: CommandServices = {
    diagnostics: diagnostics as unknown as CommandServices["diagnostics"],
    gitignoreService: {} as CommandServices["gitignoreService"],
    workspaceManager: (overrides?.workspaceManager ?? (defaultWorkspaceManager as unknown as CommandServices["workspaceManager"])),
    webviewPanelManager: (overrides?.webviewPanelManager ?? (webviewPanelManager as unknown as CommandServices["webviewPanelManager"])),
    performanceMonitor: overrides?.performanceMonitor ?? ({} as CommandServices["performanceMonitor"]),
    diagnosticService: overrides?.diagnosticService ?? ({} as CommandServices["diagnosticService"]),
    configurationService: overrides?.configurationService ?? ({} as CommandServices["configurationService"]),
    errorReporter: overrides?.errorReporter ?? ({} as CommandServices["errorReporter"]),
    extensionUri: overrides?.extensionUri ?? vscode.Uri.file("/ext"),
    outputWriter: overrides?.outputWriter ?? ({} as CommandServices["outputWriter"])
  };

  return {
    services,
    diagnostics,
    webviewPanelManager,
    workspaceManager: services.workspaceManager
  };
}
