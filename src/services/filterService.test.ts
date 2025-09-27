import { afterEach, describe, expect, it, jest } from "@jest/globals";
import * as path from "path";
import { FilterService } from "./filterService";
import { GitignoreService } from "./gitignoreService";

describe("FilterService", () => {
  const workspaceRoot = path.join(__dirname, "__fixtures__");

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("filters out paths ignored by git", async () => {
    const filePaths = [
      path.join(workspaceRoot, "src", "ignored.ts"),
      path.join(workspaceRoot, "src", "kept.ts")
    ];

    const gitignoreService = new GitignoreService();
    const isIgnoredSpy = jest
      .spyOn(gitignoreService, "isIgnored")
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    const result = await FilterService.filterFileList(filePaths, [], [], gitignoreService, workspaceRoot);

  expect(result).toEqual([filePaths[1]]);
  expect(isIgnoredSpy).toHaveBeenCalledTimes(2);
  });

  it("applies include and exclude globs relative to the workspace", async () => {
    const filePaths = [
      path.join(workspaceRoot, "src", "index.ts"),
      path.join(workspaceRoot, "src", "index.test.ts"),
      path.join(workspaceRoot, "scripts", "generate.js")
    ];

    const gitignoreService = new GitignoreService();
    jest.spyOn(gitignoreService, "isIgnored").mockResolvedValue(false);

    const result = await FilterService.filterFileList(
      filePaths,
      ["src/**/*.ts"],
      ["**/*.test.ts"],
      gitignoreService,
      workspaceRoot
    );

    expect(result).toEqual([path.join(workspaceRoot, "src", "index.ts")]);
  });

  it("treats errors from gitignoreService as non-ignored paths", async () => {
    const filePaths = [path.join(workspaceRoot, "src", "error.ts")];

    const gitignoreService = new GitignoreService();
    jest.spyOn(gitignoreService, "isIgnored").mockRejectedValue(new Error("boom"));

    const result = await FilterService.filterFileList(filePaths, [], [], gitignoreService, workspaceRoot);

    expect(result).toEqual(filePaths);
  });
});