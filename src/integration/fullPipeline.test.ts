import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { FileScanner, type FileNode } from "../services/fileScanner";
import { FilterService } from "../services/filterService";
import { GitignoreService } from "../services/gitignoreService";
import { DigestGenerator, type FileNode as DigestFileNode } from "../services/digestGenerator";
import { ContentProcessor } from "../services/contentProcessor";
import { TokenAnalyzer } from "../services/tokenAnalyzer";
import type { DigestConfig } from "../utils/validateConfig";

describe("Full pipeline integration", () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "code-ingest-pipeline-"));
    await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });

    await fs.writeFile(path.join(workspaceRoot, ".gitignore"), "ignored.txt\n");
    await fs.writeFile(
      path.join(workspaceRoot, "src", "main.ts"),
      [
        "const token = \"ghp_123456789012345678901234567890123456\";",
        "console.log(token);"
      ].join("\n")
    );
    await fs.writeFile(path.join(workspaceRoot, "ignored.txt"), "this file should be ignored");
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    if (workspaceRoot) {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("scans, filters, and generates a redacted digest", async () => {
    const scanner = new FileScanner(vscode.Uri.file(workspaceRoot));
    const scanSpy = jest.spyOn(scanner, "scan").mockResolvedValue(
      [
        {
          uri: path.join(workspaceRoot, "src", "main.ts"),
          name: "main.ts",
          type: "file"
        },
        {
          uri: path.join(workspaceRoot, "ignored.txt"),
          name: "ignored.txt",
          type: "file"
        }
      ] satisfies FileNode[]
    );

    const gitignoreService = new GitignoreService();
    const includePatterns = ["src/**/*.ts"];
    const excludePatterns = ["**/*.test.ts"];

    const scanned = await scanner.scan();
    expect(scanSpy).toHaveBeenCalled();

    const candidatePaths = scanned.filter((node) => node.type === "file").map((node) => node.uri);

    const filteredPaths = await FilterService.filterFileList(
      candidatePaths,
      includePatterns,
      excludePatterns,
      gitignoreService,
      workspaceRoot
    );

    expect(filteredPaths).toEqual([path.join(workspaceRoot, "src", "main.ts")]);

    const digestGenerator = new DigestGenerator(
      {
        getFileContent: (filePath: string, config: DigestConfig) => ContentProcessor.getFileContent(filePath, config)
      },
      {
        estimate: (content: string) => TokenAnalyzer.estimate(content),
        formatEstimate: (tokens: number) => TokenAnalyzer.formatEstimate(tokens),
        warnIfExceedsLimit: (tokens: number, limit: number) => TokenAnalyzer.warnIfExceedsLimit(tokens, limit)
      }
    );

    const digestConfig: DigestConfig = {
      workspaceRoot,
      sectionSeparator: "\n\n"
    };

    const digest = await digestGenerator.generate(
      filteredPaths.map((filePath) => ({ path: filePath } as DigestFileNode)),
      digestConfig
    );

    expect(digest.diagnostics).toEqual([]);
    expect(digest.totalTokens).toBeGreaterThan(0);
    expect(digest.fullContent).toContain("Files processed: 1");
    expect(digest.fullContent).toContain("main.ts");
    expect(digest.fullContent).toContain("[REDACTED]");
    expect(digest.fullContent).not.toContain("ghp_123456789012345678901234567890123456");
  });
});