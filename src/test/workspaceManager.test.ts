import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import * as path from "node:path";
import vscode from "vscode";

import { Diagnostics } from "../services/diagnostics";
import type { GitignoreService } from "../services/gitignoreService";
import { WorkspaceManager } from "../services/workspaceManager";
import { DEFAULT_CONFIG } from "../config/constants";

describe("WorkspaceManager", () => {
  let diagnostics: Diagnostics;
  let gitignoreService: GitignoreService;
  let root: string;

  beforeEach(() => {
  (vscode as unknown as { __reset?: () => void }).__reset?.();
    diagnostics = new Diagnostics();
    gitignoreService = {
      isIgnored: jest.fn(async () => false),
      isIgnoredBatch: jest.fn(async (paths: string[]) => new Map(paths.map((filePath) => [filePath, false]))),
      clearCache: jest.fn()
    } as unknown as GitignoreService;

    root = path.join(process.cwd(), "virtual-workspace");
    (vscode.workspace as unknown as { workspaceFolders: Array<{ uri: vscode.Uri; name: string; index: number }> }).workspaceFolders = [
      { uri: vscode.Uri.file(root), name: "workspace", index: 0 }
    ];

    const directoryMap = new Map<string, [string, number][]>([
      [root, [
        ["src", vscode.FileType.Directory],
        ["README.md", vscode.FileType.File]
      ]],
      [path.join(root, "src"), [
        ["index.ts", vscode.FileType.File],
        ["notes.md", vscode.FileType.File],
        ["dist", vscode.FileType.Directory]
      ]],
      [path.join(root, "src", "dist"), [["bundle.js", vscode.FileType.File]]]
    ]);

    const readDirectoryMock = jest.fn(async (uri: vscode.Uri) => directoryMap.get(uri.fsPath) ?? []);
    (vscode.workspace.fs as unknown as { readDirectory: typeof readDirectoryMock }).readDirectory = readDirectoryMock;

    const statMock = jest.fn(async () => ({
      type: vscode.FileType.File,
      ctime: 0,
      mtime: 0,
      size: 100
    }));
    (vscode.workspace.fs as unknown as { stat: typeof statMock }).stat = statMock;
  });

  it("filters the workspace tree using include and exclude patterns", async () => {
    const config = {
      ...DEFAULT_CONFIG,
      include: ["src/**/*.ts"],
      exclude: ["src/dist/**"],
      followSymlinks: false,
      respectGitIgnore: true
    } satisfies typeof DEFAULT_CONFIG;

    const manager = new WorkspaceManager(diagnostics, gitignoreService, {
      loadConfiguration: () => ({ ...config })
    });

    await manager.initialize();

    const tree = manager.getTree();
    expect(tree).toHaveLength(1);
    const srcNode = tree[0];
    expect(srcNode?.relPath).toBe("src");
    expect(srcNode?.children?.map((child) => child.relPath)).toEqual(["src/index.ts"]);

    const warnings = manager.getWarnings();
    expect(warnings.some((message) => message.includes("include patterns"))).toBe(true);
    expect(warnings.some((message) => message.includes("exclude patterns"))).toBe(true);

    const selection = await manager.selectAll();
    expect(selection).toEqual(["src/index.ts"]);
  });

  it("drops stale selections when configuration changes", async () => {
    const config = {
      ...DEFAULT_CONFIG,
      include: ["**/*.md"],
      exclude: ["src/dist/**"],
      followSymlinks: false,
      respectGitIgnore: true
    } satisfies typeof DEFAULT_CONFIG;

    const manager = new WorkspaceManager(diagnostics, gitignoreService, {
      loadConfiguration: () => ({ ...config })
    });

    await manager.initialize();

    await manager.selectAll();
    expect(manager.getSelection().sort()).toEqual(["README.md", "src/notes.md"].sort());

    config.include = ["src/**/*.ts"];
    await manager.refreshWorkspaceTree();

    expect(manager.getSelection()).toEqual([]);

    const sanitized = manager.setSelection(["README.md", "src/index.ts"]);
    expect(sanitized).toEqual(["src/index.ts"]);

    const refreshedSelection = await manager.selectAll();
    expect(refreshedSelection).toEqual(["src/index.ts"]);
  });
});