import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, jest } from "@jest/globals";
import * as path from "node:path";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { spawnSync } from "node:child_process";
import * as vscode from "vscode";
import * as ts from "typescript";
import { COMMAND_MAP } from "../../commands/commandMap";
import { ConfigurationService } from "../../services/configurationService";
import { DEFAULT_CONFIG } from "../../config/constants";
import {
  activateExtension,
  cleanupTempWorkspaces,
  createMockExtensionContext,
  createTempWorkspace,
  expectCommandRegistered,
  getOutputChannel,
  getRegisteredWebviewProviders,
  mockWorkspaceFolders,
  seedWorkspaceFile,
  deactivateExtension
} from "../support/integrationUtils";
import { createMockWebview, loadWebviewHtml } from "../support/webviewMock";

jest.mock("@vscode/test-electron", () => ({
  runTests: jest.fn(async () => path.join(process.cwd(), ".vscode-test")),
  downloadAndUnzipVSCode: jest.fn(async () => path.join(process.cwd(), ".vscode-test"))
}));

import { runTests } from "@vscode/test-electron";

const PROJECT_ROOT = path.resolve(__dirname, "../../..");

async function ensureBuildArtifacts(): Promise<void> {
  const outDir = path.join(PROJECT_ROOT, "out");
  await fsp.mkdir(outDir, { recursive: true });

  const extensionEntry = path.join(outDir, "extension.js");
  if (!fs.existsSync(extensionEntry)) {
    const source = await fsp.readFile(path.join(PROJECT_ROOT, "src", "extension.ts"), "utf8");
    const transpiled = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        esModuleInterop: true,
        sourceMap: false
      }
    });
    await fsp.writeFile(extensionEntry, transpiled.outputText, "utf8");
  }

  const webviewIndex = path.join(outDir, "resources", "webview", "index.html");
  if (!fs.existsSync(webviewIndex)) {
    const copyScript = path.join(PROJECT_ROOT, "scripts", "copyWebviewResources.js");
    const result = spawnSync(process.execPath, [copyScript], {
      cwd: PROJECT_ROOT,
      stdio: "pipe",
      encoding: "utf8"
    });

    if (result.status !== 0) {
      throw new Error(`copyWebviewResources failed: ${result.stderr || result.stdout}`);
    }
  }
}

describe("Sprint 0 integration", () => {
  let workspaceRoot: string;
  let restoreWorkspace: (() => void) | undefined;
  let context: vscode.ExtensionContext;

  beforeAll(async () => {
    await runTests({
      version: "stable",
      extensionDevelopmentPath: PROJECT_ROOT,
      extensionTestsPath: PROJECT_ROOT
    });

    workspaceRoot = createTempWorkspace();
    await seedWorkspaceFile(workspaceRoot, "src/example.ts", "export const example = 1;\n");
    await ensureBuildArtifacts();
  }, 30000);

  beforeEach(async () => {
    restoreWorkspace = mockWorkspaceFolders(workspaceRoot);
    context = createMockExtensionContext(PROJECT_ROOT);
    await activateExtension(context);
  });

  afterEach(async () => {
    await deactivateExtension();
    restoreWorkspace?.();
    restoreWorkspace = undefined;
  });

  afterAll(() => {
    cleanupTempWorkspaces();
  });

  it("Extension activation test", () => {
    expect(context.subscriptions.length).toBeGreaterThan(0);

    const requiredCommands: string[] = [
      COMMAND_MAP.WEBVIEW_TO_HOST.GENERATE_DIGEST,
      COMMAND_MAP.WEBVIEW_TO_HOST.REFRESH_TREE,
      COMMAND_MAP.WEBVIEW_TO_HOST.LOAD_REMOTE_REPO,
      COMMAND_MAP.EXTENSION_ONLY.SELECT_ALL,
      COMMAND_MAP.EXTENSION_ONLY.DESELECT_ALL,
      COMMAND_MAP.EXTENSION_ONLY.INGEST_REMOTE_REPO,
      "codeIngest.openDashboardPanel",
      "codeIngest.flushErrorReports",
      "codeIngest.viewMetrics",
      "codeIngest.toggleRedactionOverride",
      "codeIngest.invertSelection"
    ];

    for (const commandId of requiredCommands) {
      expectCommandRegistered(commandId);
    }

    const mainChannel = getOutputChannel("Code Ingest") as { appendLine: jest.Mock } | undefined;
    const errorChannel = getOutputChannel("Code Ingest Errors") as { appendLine: jest.Mock } | undefined;
    expect(mainChannel).toBeDefined();
    expect(errorChannel).toBeDefined();

    const createdTreeViews = (vscode.window as unknown as {
      __getCreatedTreeViews?: () => Map<string, unknown>;
    }).__getCreatedTreeViews?.();
    expect(createdTreeViews?.size ?? 0).toBe(0);

    const providers = getRegisteredWebviewProviders();
    expect(providers.has("codeIngestDashboard")).toBe(true);
  });

  it("Webview resource loading test", () => {
    const mockWebview = createMockWebview();
    const initialState = { preview: { enabled: true } };
    const { html, webview } = loadWebviewHtml(
      mockWebview,
      "resources/webview/index.html",
      initialState
    );

    expect(html).toContain("Content-Security-Policy");
    expect(html).toMatch(/window.__INITIAL_STATE__ = JSON.parse/);
    expect(html).toContain("vscode-resource:");
    expect(webview.html).toBe(html);

    const cspMatch = html.match(/<meta[^>]+Content-Security-Policy[^>]+>/i);
    expect(cspMatch).not.toBeNull();
  });

  it("Configuration service test", () => {
    const errors: string[] = [];
    const warnings: string[] = [];

    const config = ConfigurationService.getWorkspaceConfig(undefined, {
      addError: (message: string) => errors.push(message),
      addWarning: (message: string) => warnings.push(message)
    });

    expect(errors).toHaveLength(0);
    expect(warnings).toHaveLength(0);
    expect(config).toMatchObject({
      include: DEFAULT_CONFIG.include,
      exclude: DEFAULT_CONFIG.exclude,
      maxDepth: DEFAULT_CONFIG.maxDepth,
      outputFormat: DEFAULT_CONFIG.outputFormat
    });

  const outputChannel = getOutputChannel("Code Ingest") as { appendLine: jest.Mock } | undefined;
  expect(outputChannel).toBeDefined();
  outputChannel!.appendLine.mockClear();

    const workspaceMock = vscode.workspace as unknown as {
      __fireConfigurationChange?: (event: { affectsConfiguration(section: string): boolean }) => void;
    };
    workspaceMock.__fireConfigurationChange?.({
      affectsConfiguration: (section: string) => section === "codeIngest"
    });

  expect(outputChannel!.appendLine).toHaveBeenCalledWith(expect.stringContaining("codeIngest configuration changed"));
  });

  it("Build artifact validation", async () => {
    const outDir = path.join(PROJECT_ROOT, "out");
    const extensionBundlePath = path.join(outDir, "extension.js");
    const extensionStats = await fsp.stat(extensionBundlePath);
    expect(extensionStats.size).toBeGreaterThan(0);

    const copiedIndexPath = path.join(outDir, "resources", "webview", "index.html");
    expect(fs.existsSync(copiedIndexPath)).toBe(true);

    const manifestPath = path.join(outDir, "resources", "webview", "externals.json");
    const manifest = JSON.parse(await fsp.readFile(manifestPath, "utf8")) as { resources: Record<string, string> };
    expect(Object.keys(manifest.resources)).toContain("index.html");

    const sizeBudget = 2 * 1024 * 1024;
    expect(extensionStats.size).toBeLessThan(sizeBudget);
  });

  it("Basic command execution", async () => {
    const commandsToExecute = [
      COMMAND_MAP.WEBVIEW_TO_HOST.REFRESH_TREE,
      COMMAND_MAP.WEBVIEW_TO_HOST.GENERATE_DIGEST,
      COMMAND_MAP.EXTENSION_ONLY.SELECT_ALL,
      "codeIngest.flushErrorReports",
      "codeIngest.viewMetrics"
    ];

    for (const commandId of commandsToExecute) {
      await expect(vscode.commands.executeCommand(commandId)).resolves.toBeUndefined();
    }

  const toggleResult = await vscode.commands.executeCommand("codeIngest.toggleRedactionOverride");
  expect(typeof toggleResult).toBe("boolean");

  const globalState = context.globalState;
  expect(globalState.get<boolean>("codeIngest.redactionOverride")).toBe(toggleResult);

    const windowMock = vscode.window as unknown as {
      showInputBox: jest.Mock;
    };

  (windowMock.showInputBox as jest.Mock).mockImplementationOnce(async () => undefined);
  await expect(vscode.commands.executeCommand("codeIngest.loadRemoteRepo")).resolves.toBeUndefined();
  expect((vscode.window as unknown as { showErrorMessage: jest.Mock }).showErrorMessage).not.toHaveBeenCalled();
  });
});
