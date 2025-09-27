import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import { GitignoreService } from "./gitignoreService";

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gitignore-service-"));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
  jest.restoreAllMocks();
});

describe("GitignoreService", () => {
  it("applies ignore and negation rules from gitignore files", async () => {
    await fs.writeFile(path.join(tempDir, ".gitignore"), "*.log\n!keep.log\n");

    const service = new GitignoreService();

    await expect(service.isIgnored(path.join(tempDir, "application.log"))).resolves.toBe(true);
    await expect(service.isIgnored(path.join(tempDir, "keep.log"))).resolves.toBe(false);
    await expect(service.isIgnored(path.join(tempDir, "notes.txt"))).resolves.toBe(false);
  });

  it("uses cached matchers when preloaded and falls back after clearing cache", async () => {
    const gitignorePath = path.join(tempDir, ".gitignore");
    await fs.writeFile(gitignorePath, "# placeholder\n");

    const service = new GitignoreService();
    service.preloadDir(tempDir, (file) => (file.endsWith("match.txt") ? true : null));

    jest.spyOn(fs, "readFile").mockRejectedValue(new Error("not reachable"));

    const targetPath = path.join(tempDir, "match.txt");
    await expect(service.isIgnored(targetPath)).resolves.toBe(true);

    service.clearCache();

    await expect(service.isIgnored(targetPath)).resolves.toBe(false);
  });
});