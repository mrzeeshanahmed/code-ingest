import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { promises as fs } from "fs";
import * as path from "path";
import * as minimatch from "minimatch";
import { GitignoreService } from "../../services/gitignoreService";
import { withTempWorkspace } from "./testUtils";

describe("GitignoreService", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("discovers hierarchical ignore files in root-to-leaf order", async () => {
    await withTempWorkspace({}, async (root) => {
      await fs.mkdir(path.join(root, "packages", "service", "src"), { recursive: true });
      await fs.writeFile(path.join(root, ".gitignore"), "*.log\n", "utf8");
      await fs.writeFile(path.join(root, "packages", "service", ".gitignore"), "dist/\n", "utf8");

      const service = new GitignoreService();
      const ignoreFiles = await service.findGitignoreFiles(path.join(root, "packages", "service", "src"));
      expect(ignoreFiles).toEqual([
        path.join(root, ".gitignore"),
        path.join(root, "packages", "service", ".gitignore")
      ]);
    });
  });

  it("applies pattern precedence from root to leaf", async () => {
    await withTempWorkspace({}, async (root) => {
      await fs.mkdir(path.join(root, "packages", "feature"), { recursive: true });
      await fs.writeFile(path.join(root, ".gitignore"), "*.log\n", "utf8");
      await fs.writeFile(path.join(root, "packages", "feature", ".gitignore"), "!keep.log\n", "utf8");
      await fs.writeFile(path.join(root, "packages", "feature", "drop.log"), "", "utf8");
      await fs.writeFile(path.join(root, "packages", "feature", "keep.log"), "", "utf8");

      const service = new GitignoreService();
      const ignored = await service.isIgnored(path.join(root, "packages", "feature", "drop.log"));
      const kept = await service.isIgnored(path.join(root, "packages", "feature", "keep.log"));
      expect(ignored).toBe(true);
      expect(kept).toBe(false);
    });
  });

  it("handles negation and anchored patterns", async () => {
    await withTempWorkspace({}, async (root) => {
      await fs.mkdir(path.join(root, "build"), { recursive: true });
      await fs.mkdir(path.join(root, "docs"), { recursive: true });
  await fs.writeFile(path.join(root, ".gitignore"), "build/**\n!build/keep.txt\n", "utf8");
      await fs.writeFile(path.join(root, "build", "artifact.bin"), "", "utf8");
      await fs.writeFile(path.join(root, "build", "keep.txt"), "", "utf8");
      await fs.writeFile(path.join(root, "docs", "build.log"), "", "utf8");

      const service = new GitignoreService();
      const ignored = await service.isIgnored(path.join(root, "build", "artifact.bin"));
      const restored = await service.isIgnored(path.join(root, "build", "keep.txt"));
      const outside = await service.isIgnored(path.join(root, "docs", "build.log"));
      expect(ignored).toBe(true);
      expect(restored).toBe(false);
      expect(outside).toBe(false);
    });
  });

  it("supports custom ignore file names", async () => {
    await withTempWorkspace({}, async (root) => {
      await fs.mkdir(path.join(root, "nested"), { recursive: true });
      await fs.writeFile(path.join(root, ".customignore"), "custom.txt\n", "utf8");
      await fs.writeFile(path.join(root, "nested", "custom.txt"), "", "utf8");

      const service = new GitignoreService({ gitignoreFiles: [".customignore"] });
      const ignored = await service.isIgnored(path.join(root, "nested", "custom.txt"));
      expect(ignored).toBe(true);
    });
  });

  it("logs malformed patterns but continues", async () => {
    await withTempWorkspace({}, async (root) => {
      const originalMinimatch = minimatch.Minimatch;
      jest.spyOn(minimatch, "Minimatch").mockImplementation((pattern, options) => {
        if (pattern === "[") {
          throw new Error("invalid pattern");
        }
        return new originalMinimatch(pattern, options);
      });

      await fs.writeFile(path.join(root, ".gitignore"), "[", "utf8");
      await fs.writeFile(path.join(root, "any.txt"), "", "utf8");

      const logger = jest.fn();
      const service = new GitignoreService({ logger });
      const ignored = await service.isIgnored(path.join(root, "any.txt"));
      expect(ignored).toBe(false);
      expect(logger).toHaveBeenCalledWith(
        "gitignore.pattern.invalid",
        expect.objectContaining({ pattern: "[" })
      );
    });
  });

  it("caches matcher results and evicts after exceeding capacity", async () => {
    await withTempWorkspace({}, async (root) => {
      await fs.mkdir(path.join(root, "a"), { recursive: true });
      await fs.mkdir(path.join(root, "b"), { recursive: true });
      await fs.mkdir(path.join(root, "c"), { recursive: true });
      await fs.writeFile(path.join(root, "a", ".gitignore"), "foo\n", "utf8");
      await fs.writeFile(path.join(root, "b", ".gitignore"), "bar\n", "utf8");
      await fs.writeFile(path.join(root, "c", ".gitignore"), "baz\n", "utf8");

      const service = new GitignoreService({ maxCacheEntries: 2 });
      await service.isIgnored(path.join(root, "a", "foo"));
      await service.isIgnored(path.join(root, "b", "bar"));
      await service.isIgnored(path.join(root, "c", "baz"));
      const snapshot = service.getCacheSnapshot();
      expect(Object.keys(snapshot)).toHaveLength(2);
    });
  });

  it("invalidates cache entries when ignore file changes", async () => {
    await withTempWorkspace({}, async (root) => {
      await fs.writeFile(path.join(root, ".gitignore"), "temp.txt\n", "utf8");
      const service = new GitignoreService();
      const filePath = path.join(root, "temp.txt");
      await fs.writeFile(filePath, "", "utf8");
      expect(await service.isIgnored(filePath)).toBe(true);

      await fs.writeFile(path.join(root, ".gitignore"), "!temp.txt\n", "utf8");
      const decision = await service.isIgnored(filePath);
      expect(decision).toBe(false);
    });
  });

  it("evaluates batches efficiently", async () => {
    await withTempWorkspace({}, async (root) => {
      await fs.writeFile(path.join(root, ".gitignore"), "*.log\n", "utf8");
      await Promise.all([
        fs.writeFile(path.join(root, "a.log"), "", "utf8"),
        fs.writeFile(path.join(root, "b.txt"), "", "utf8"),
        fs.writeFile(path.join(root, "c.log"), "", "utf8")
      ]);

      const service = new GitignoreService();
      const files = ["a.log", "b.txt", "c.log"].map((name) => path.join(root, name));
      const results = await service.isIgnoredBatch(files);
      expect(results.get(path.join(root, "a.log"))).toBe(true);
      expect(results.get(path.join(root, "b.txt"))).toBe(false);
      expect(results.get(path.join(root, "c.log"))).toBe(true);
    });
  });

  it("handles concurrent access", async () => {
    await withTempWorkspace({}, async (root) => {
      await fs.writeFile(path.join(root, ".gitignore"), "*.tmp\n", "utf8");
      const service = new GitignoreService();
      const files = await Promise.all(
        new Array(20).fill(null).map(async (_, index) => {
          const file = path.join(root, `file-${index}.tmp`);
          await fs.writeFile(file, "", "utf8");
          return file;
        })
      );
      const decisions = await Promise.all(files.map((file) => service.isIgnored(file)));
      expect(decisions.every(Boolean)).toBe(true);
    });
  });
});