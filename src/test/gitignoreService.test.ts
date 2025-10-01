import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import { GitignoreService } from "../services/gitignoreService";

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gitignore-service-"));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
  jest.restoreAllMocks();
});

describe("GitignoreService", () => {
  it("applies hierarchical ignore and negation rules", async () => {
    await fs.writeFile(path.join(tempDir, ".gitignore"), "*.log\napps/\n");
    const nestedDir = path.join(tempDir, "apps");
    await fs.mkdir(nestedDir);
    await fs.writeFile(path.join(nestedDir, ".gitignore"), "!keep.log\n");

    const service = new GitignoreService();

    await expect(service.isIgnored(path.join(tempDir, "notes.txt"))).resolves.toBe(false);
    await expect(service.isIgnored(path.join(tempDir, "application.log"))).resolves.toBe(true);
    await expect(service.isIgnored(path.join(nestedDir, "keep.log"))).resolves.toBe(false);
    await expect(service.isIgnored(path.join(nestedDir, "drop.log"))).resolves.toBe(true);
  });

  it("uses cached matchers when preloaded and invalidates after clearing cache", async () => {
    const gitignorePath = path.join(tempDir, ".gitignore");
    await fs.writeFile(gitignorePath, "match.txt\n");

    const service = new GitignoreService();
    await service.preloadDirectory(tempDir);

    const readSpy = jest.spyOn(fs, "readFile").mockRejectedValue(new Error("should not read during cache hit"));

    const targetPath = path.join(tempDir, "match.txt");
    await expect(service.isIgnored(targetPath)).resolves.toBe(true);
    expect(readSpy).toHaveBeenCalledTimes(0);

    service.clearCache();
    readSpy.mockRestore();
    jest.spyOn(fs, "readFile").mockRejectedValue(new Error("cache cleared"));

    await expect(service.isIgnored(targetPath)).resolves.toBe(false);
  });

  it("supports custom ignore file names via options", async () => {
    const customIgnore = path.join(tempDir, ".customignore");
    await fs.writeFile(customIgnore, "ignored.txt\n");

    const service = new GitignoreService({ gitignoreFiles: [".customignore"] });

    await expect(service.isIgnored(path.join(tempDir, "ignored.txt"))).resolves.toBe(true);
    await expect(service.isIgnored(path.join(tempDir, "other.txt"))).resolves.toBe(false);
  });
});