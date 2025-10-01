import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { promises as fs } from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { FileScanner } from "../../services/fileScanner";
import { measurePerformance, setWorkspaceFolder, withTempWorkspace, createCancellationTokenSource } from "./testUtils";

jest.mock("../../services/gitignoreService");

describe("FileScanner", () => {
  const originalReaddir = fs.readdir;

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("scanDirectoryShallow", () => {
    it("handles batch processing with varying limits", async () => {
      await withTempWorkspace(
        {
          "src": {
            "a.ts": "export const a = 1;",
            "b.ts": "export const b = 2;",
            "c.ts": "export const c = 3;"
          }
        },
        async (root) => {
          setWorkspaceFolder(root);
          const scanner = new FileScanner(vscode.Uri.file(root));
          const uri = vscode.Uri.file(path.join(root, "src"));

          const firstBatch = await scanner.scanDirectoryShallow(uri, { limit: 2, offset: 0 });
          expect(firstBatch.nodes).toHaveLength(2);
          expect(firstBatch.hasMore).toBe(true);

          const secondBatch = await scanner.scanDirectoryShallow(uri, { limit: 2, offset: firstBatch.nextOffset });
          expect(secondBatch.nodes).toHaveLength(1);
          expect(secondBatch.hasMore).toBe(false);
        }
      );
    });

    it("honors cancellation tokens", async () => {
      await withTempWorkspace(
        {
          "src": {
            "a.ts": "export const a = 1;"
          }
        },
        async (root) => {
          setWorkspaceFolder(root);
          const scanner = new FileScanner(vscode.Uri.file(root));
          const uri = vscode.Uri.file(path.join(root, "src"));
          const source = createCancellationTokenSource();
          source.cancel();

          await expect(scanner.scanDirectoryShallow(uri, { token: source.token })).rejects.toThrow(vscode.CancellationError);
        }
      );
    });

    it("collects metadata and detects binaries", async () => {
      await withTempWorkspace(
        {
          "data": {
            "image.png": Buffer.from([0, 1, 2]),
            "readme.md": "# hello"
          }
        },
        async (root) => {
          setWorkspaceFolder(root);
          const scanner = new FileScanner(vscode.Uri.file(root));
          const uri = vscode.Uri.file(path.join(root, "data"));

          const result = await scanner.scanDirectoryShallow(uri, { limit: 10 });
          const png = result.nodes.find((node) => node.name === "image.png");
          const md = result.nodes.find((node) => node.name === "readme.md");
          expect(png?.metadata?.isBinary).toBe(true);
          expect(md?.metadata?.languageId).toBe("markdown");
        }
      );
    });

    it("respects symlink settings", async () => {
      await withTempWorkspace(
        {
          "real": { "file.ts": "// hi" },
          "link.ts": { symlinkTo: "real/file.ts" }
        },
        async (root) => {
          setWorkspaceFolder(root);
          const scanner = new FileScanner(vscode.Uri.file(root));
          const uri = vscode.Uri.file(root);

          const skipResult = await scanner.scanDirectoryShallow(uri, { limit: 10, followSymlinks: false });
          const linkNode = skipResult.nodes.find((node) => node.name === "link.ts");
          expect(linkNode?.metadata?.isSymbolicLink).toBe(true);

          const followResult = await scanner.scanDirectoryShallow(uri, { limit: 10, followSymlinks: true });
          const followNode = followResult.nodes.find((node) => node.name === "link.ts");
          expect(followNode?.metadata?.isSymbolicLink).toBe(true);
        }
      );
    });

    it("bubbles permission errors", async () => {
      await withTempWorkspace(
        {
          "secure": {}
        },
        async (root) => {
          setWorkspaceFolder(root);
          const scanner = new FileScanner(vscode.Uri.file(root));
          const target = path.join(root, "secure");

          const readdirSpy = jest.spyOn(fs, "readdir").mockImplementation(async (dir, opts) => {
            if (typeof dir === "string" && dir === target) {
              throw Object.assign(new Error("EACCES"), { code: "EACCES" });
            }
            return originalReaddir.call(fs, dir as never, opts as never);
          });

          await expect(scanner.scanDirectoryShallow(vscode.Uri.file(target))).rejects.toThrow("EACCES");
          readdirSpy.mockRestore();
        }
      );
    });
  });

  describe("scan", () => {
    it("reports progress and enforces max entry limits", async () => {
      await withTempWorkspace(
        {
          "src": {
            "a.ts": "export const a = 1;",
            "b.ts": "export const b = 1;",
            "nested": {
              "c.ts": "export const c = 1;"
            }
          }
        },
        async (root) => {
          setWorkspaceFolder(root);
          const scanner = new FileScanner(vscode.Uri.file(root));
          const progressCalls: Array<{ processed: number; path?: string }> = [];

          const results = await scanner.scan({
            maxEntries: 2,
            onProgress: (processed, _total, currentPath) => {
              if (typeof currentPath === "string") {
                progressCalls.push({ processed, path: currentPath });
              } else {
                progressCalls.push({ processed });
              }
            }
          });

          expect(results).toHaveLength(2);
          expect(progressCalls.length).toBeGreaterThan(0);
          expect(progressCalls[progressCalls.length - 1].processed).toBeGreaterThan(0);
        }
      );
    });

    it("supports cancellation mid traversal", async () => {
      await withTempWorkspace(
        {
          "src": Object.fromEntries(new Array(10).fill(null).map((_, index) => [`f${index}.ts`, "export {}"]))
        },
        async (root) => {
          setWorkspaceFolder(root);
          const scanner = new FileScanner(vscode.Uri.file(root));
          const source = createCancellationTokenSource();

          const promise = scanner.scan({
            token: source.token,
            onProgress: (processed) => {
              if (processed > 0) {
                source.cancel();
              }
            }
          });

          await expect(promise).rejects.toThrow(vscode.CancellationError);
        }
      );
    });

    it("performs within acceptable bounds on large directories", async () => {
      await withTempWorkspace(
        {
          "large": Object.fromEntries(
            new Array(200).fill(null).map((_, index) => [
              `file-${index}.ts`,
              `export const v${index} = ${index};`
            ])
          )
        },
        async (root) => {
          setWorkspaceFolder(root);
          const scanner = new FileScanner(vscode.Uri.file(root));
          const measurement = await measurePerformance(1, async () => {
            await scanner.scan();
          });

          expect(measurement.durationMs).toBeLessThan(1500);
        }
      );
    });
  });
});
