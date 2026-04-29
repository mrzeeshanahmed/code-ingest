import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { promises as fs } from "fs";
import type { PathLike, Stats } from "fs";
import * as os from "os";
import * as path from "path";
import { FilterService } from "../services/filterService";
import type { GitignoreService } from "../services/gitignoreService";

type GitignoreSubset = Pick<GitignoreService, "isIgnored" | "isIgnoredBatch">;

describe("FilterService", () => {
  let workspaceRoot: string;
  let gitignoreMock: jest.Mocked<GitignoreSubset>;

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "filter-service-"));
    gitignoreMock = {
      isIgnored: jest.fn(async () => false),
      isIgnoredBatch: jest.fn(async (paths: string[]) => new Map(paths.map((p) => [p, false])))
    } as unknown as jest.Mocked<GitignoreSubset>;
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  function createService(): FilterService {
    const service = new FilterService({
      workspaceRoot,
      gitignoreService: gitignoreMock as unknown as GitignoreService
    });
    return service;
  }

  it("applies precedence: depth and symlink checks before pattern and gitignore evaluation", async () => {
    const deepDir = path.join(workspaceRoot, "a", "b");
    await fs.mkdir(deepDir, { recursive: true });
    const target = path.join(deepDir, "file.ts");
    await fs.writeFile(target, "console.log('hi');");

    const service = createService();
    const depthResult = await service.shouldIncludeFile(target, { includePatterns: ["**/*.ts"], maxDepth: 1 });
    expect(depthResult).toEqual({ included: false, reason: "depth-limit" });
    expect(gitignoreMock.isIgnored).not.toHaveBeenCalled();

    const linkPath = path.join(workspaceRoot, "linked.ts");
    const realLstat = fs.lstat;
    jest.spyOn(fs, "lstat").mockImplementation(async (p: PathLike) => {
      if (path.normalize(String(p)) === path.normalize(linkPath)) {
        return { isSymbolicLink: () => true } as unknown as Stats;
      }
      return realLstat(p);
    });
    const symlinkResult = await service.shouldIncludeFile(linkPath, { includePatterns: ["**/*.ts"], followSymlinks: false });
    expect(symlinkResult).toEqual({ included: false, reason: "symlink-skipped" });
  });

  it("matches include, exclude, and regex patterns with correct precedence", async () => {
    const keepPath = path.join(workspaceRoot, "src", "index.ts");
    const ignorePath = path.join(workspaceRoot, "src", "index.test.ts");
    await fs.mkdir(path.dirname(keepPath), { recursive: true });
    await fs.writeFile(keepPath, "export const keep = true;\n");
    await fs.writeFile(ignorePath, "export const ignore = true;\n");

  const service = createService();
  const includePattern = "(?i)src/**/*.ts";
  const excludeRegex = "/\\.test\\.ts$/";

    const includeDecision = await service.shouldIncludeFile(keepPath, {
      includePatterns: [includePattern],
      excludePatterns: [excludeRegex]
    });
    expect(includeDecision).toEqual({ included: true, reason: "included", matchedPattern: includePattern });

    const excludeDecision = await service.shouldIncludeFile(ignorePath, {
      includePatterns: [includePattern],
      excludePatterns: [excludeRegex]
    });
    expect(excludeDecision).toEqual({ included: false, reason: "excluded", matchedPattern: excludeRegex });

    expect(service.validatePattern(includePattern)).toEqual({ ok: true, type: "glob" });
    expect(service.validatePattern(excludeRegex)).toEqual({ ok: true, type: "regex" });
  });

  it("leverages gitignore batch evaluation when enabled", async () => {
    const target = path.join(workspaceRoot, "notes.md");
    await fs.writeFile(target, "# notes\n");
    const other = path.join(workspaceRoot, "keep.txt");
    await fs.writeFile(other, "keep\n");

    gitignoreMock.isIgnoredBatch.mockResolvedValue(
      new Map([
        [target, true],
        [other, false]
      ])
    );

    const service = createService();
    const results = await service.batchFilter([target, other], { useGitignore: true });
    expect(gitignoreMock.isIgnoredBatch).toHaveBeenCalledTimes(1);
    expect(results.get(target)).toEqual({ included: false, reason: "gitignored" });
  expect(results.get(other)).toEqual(expect.objectContaining({ included: true, reason: "included" }));
  });

  it("produces an explanatory trace for decisions", async () => {
    const target = path.join(workspaceRoot, "docs", "guide.md");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, "content\n");

    const service = createService();
    const explanation = await service.explainDecision(target, {
      includePatterns: ["docs/**/*.md"],
      excludePatterns: ["/docs/private/**"],
      useGitignore: false
    });

    expect(explanation.path).toBe(path.resolve(target));
    expect(explanation.relativePath).toBe("docs/guide.md");
    expect(explanation.result).toEqual({ included: true, reason: "included", matchedPattern: "docs/**/*.md" });
    expect(explanation.steps.map((step) => step.stage)).toEqual([
      "depth",
      "symlink",
      "include",
      "exclude",
      "gitignore"
    ]);
  });
});