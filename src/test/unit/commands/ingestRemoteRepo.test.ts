import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import * as vscode from "vscode";
import { COMMAND_MAP } from "../../../commands/commandMap";
import { registerIngestRemoteRepoCommand, __testing as ingestRemoteTesting } from "../../../commands/ingestRemoteRepo";
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
  beforeEach(() => {
    ingestRemoteTesting.resetRemoteIngestQueue();
  });

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

  it("queues remote ingestion tasks sequentially", async () => {
    const events: string[] = [];
    let releaseFirst: (() => void) | undefined;

    const firstTask = ingestRemoteTesting.enqueueRemoteIngestion(async () => {
      events.push("first-start");
      await new Promise<void>((resolve) => {
        releaseFirst = () => {
          events.push("first-end");
          resolve();
        };
      });
    });

    const secondTask = ingestRemoteTesting.enqueueRemoteIngestion(async () => {
      events.push("second-start");
      events.push("second-end");
    });

    await Promise.resolve();
    expect(events).toEqual(["first-start"]);
    releaseFirst?.();
    await Promise.all([firstTask, secondTask]);

    expect(events).toEqual(["first-start", "first-end", "second-start", "second-end"]);
  });
});

function createServiceHarness() {
  const diagnostics = { add: jest.fn(), clear: jest.fn(), getAll: jest.fn(() => []) };
  const webviewPanelManager = {
    sendCommand: jest.fn(),
    setStateSnapshot: jest.fn(),
    createAndShowPanel: jest.fn(),
    getStateSnapshot: jest.fn(),
    tryRestoreState: jest.fn(() => false)
  };

  const services: CommandServices = {
    diagnostics: diagnostics as unknown as CommandServices["diagnostics"],
    gitignoreService: {} as CommandServices["gitignoreService"],
    workspaceManager: {} as CommandServices["workspaceManager"],
    webviewPanelManager: webviewPanelManager as unknown as CommandServices["webviewPanelManager"],
    performanceMonitor: {} as CommandServices["performanceMonitor"],
    diagnosticService: {} as CommandServices["diagnosticService"],
    configurationService: {} as CommandServices["configurationService"],
    errorReporter: {} as CommandServices["errorReporter"],
    extensionUri: vscode.Uri.file("/ext"),
    outputWriter: {} as CommandServices["outputWriter"]
  };

  return {
    services,
    diagnostics,
    webviewPanelManager
  };
}
