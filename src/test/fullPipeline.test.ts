import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import * as path from "node:path";
import * as vscode from "vscode";

import { ContentProcessor } from "../services/contentProcessor";
import { DigestGenerator, type GenerationProgress } from "../services/digestGenerator";
import { ErrorReporter } from "../services/errorReporter";
import { FileScanner } from "../services/fileScanner";
import { FilterService } from "../services/filterService";
import { GitignoreService } from "../services/gitignoreService";
import { NotebookProcessor } from "../services/notebookProcessor";
import { TokenAnalyzer } from "../services/tokenAnalyzer";
import type { ConfigurationService } from "../services/configurationService";
import type { DigestConfig } from "../utils/validateConfig";
import { createTempWorkspace, type TempWorkspaceHandle, setWorkspaceFolder } from "./unit/testUtils";

describe("Full pipeline integration", () => {
  let workspace: TempWorkspaceHandle;

  beforeEach(async () => {
    workspace = await createTempWorkspace({
      ".gitignore": "ignored.txt\n",
      "ignored.txt": "this file should be ignored",
      src: {
        "main.ts": [
          "const token = \"AKIAIOSFODNN7EXAMPLE\";",
          "export function handler() {",
          "  return token;",
          "}"
        ].join("\n")
      }
    });

    setWorkspaceFolder(workspace.root);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await workspace.dispose();
  });

  function createGenerator(overrides: Partial<DigestConfig> = {}): DigestGenerator {
    const gitignoreService = new GitignoreService();
    const filterService = new FilterService({ workspaceRoot: workspace.root, gitignoreService });
    const fileScanner = new FileScanner(vscode.Uri.file(workspace.root));
    const contentProcessor = new ContentProcessor();
    const tokenAnalyzer = new TokenAnalyzer({ preferredAdapters: ["character-ratio", "gpt3-heuristic"] });

    const configuration: DigestConfig = {
      include: ["src/**/*.ts"],
      exclude: ["**/*.test.ts"],
      maxFiles: 50,
      outputFormat: "markdown",
      binaryFilePolicy: "skip",
      repoName: "workspace",
      followSymlinks: false,
      respectGitIgnore: true,
      includeCodeCells: true,
      includeMarkdownCells: true,
      includeCellOutputs: false,
      maxConcurrency: 2,
      sectionSeparator: "\n\n",
      workspaceRoot: workspace.root,
      ...overrides
    };

    const configurationService = {
      loadConfig: jest.fn(() => configuration)
    } as unknown as ConfigurationService;

    const errorReporter = {
      report: jest.fn()
    } as unknown as ErrorReporter;

    return new DigestGenerator(
      fileScanner,
      filterService,
      contentProcessor,
      NotebookProcessor,
      tokenAnalyzer,
      configurationService,
      errorReporter
    );
  }

  it("scans, filters, and produces a redacted digest", async () => {
    const generator = createGenerator();
    const selectedFile = path.join(workspace.root, "src", "main.ts");
    const phases: GenerationProgress["phase"][] = [];

    const result = await generator.generateDigest({
      selectedFiles: [selectedFile],
      outputFormat: "markdown",
      applyRedaction: true,
      progressCallback: (progress) => phases.push(progress.phase)
    });

    expect(result.redactionApplied).toBe(true);
    expect(result.truncationApplied).toBe(false);
    expect(result.content.files).toHaveLength(1);

    const [file] = result.content.files;
    expect(file.relativePath).toBe("src/main.ts");
    expect(file.content).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(file.content).toMatch(/<REDACTED/);
    expect(result.statistics.filesProcessed).toBe(1);
    expect(result.content.summary.overview.totalFiles).toBeGreaterThanOrEqual(1);

    const distinctPhases = new Set(phases);
    expect(distinctPhases).toEqual(
      new Set(["scanning", "processing", "analyzing", "generating", "formatting", "complete"])
    );
  });
});