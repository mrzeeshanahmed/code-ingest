import { describe, expect, it, jest } from "@jest/globals";
import * as path from "path";
import { FilterService } from "../../services/filterService";
import type { FilterServiceDependencies } from "../../services/filterService";
import type { GitignoreService } from "../../services/gitignoreService";
import { setWorkspaceFolder, withTempWorkspace } from "./testUtils";

describe("FilterService", () => {
  const createService = (overrides: Partial<FilterServiceDependencies> = {}) => {
    const root = overrides.workspaceRoot ?? process.cwd();
    const config: FilterServiceDependencies = {
      workspaceRoot: root,
      ...(overrides.gitignoreService ? { gitignoreService: overrides.gitignoreService } : {}),
      ...(overrides.loadConfiguration ? { loadConfiguration: overrides.loadConfiguration } : {}),
      ...(overrides.logger ? { logger: overrides.logger } : {}),
      ...(overrides.metrics ? { metrics: overrides.metrics } : {}),
      ...(typeof overrides.maxCacheEntries === "number" ? { maxCacheEntries: overrides.maxCacheEntries } : {})
    };
    return new FilterService(config);
  };

  it("applies precedence include -> exclude -> gitignore", async () => {
    await withTempWorkspace(
      {
        "src": {
          "keep.ts": "",
          "drop.ts": ""
        }
      },
      async (root) => {
        setWorkspaceFolder(root);
        const gitignoreMock: Partial<GitignoreService> = {
          isIgnoredBatch: jest.fn(async (paths: string[]) => {
            const map = new Map<string, boolean>();
            for (const p of paths) {
              map.set(p, p.endsWith("drop.ts"));
            }
            return map;
          })
        };
        const service = createService({ workspaceRoot: root, gitignoreService: gitignoreMock as GitignoreService });
        const results = await service.batchFilter([
          path.join(root, "src", "keep.ts"),
          path.join(root, "src", "drop.ts")
        ], {
          includePatterns: ["src/**/*.ts"],
          excludePatterns: ["**/drop.ts"],
          useGitignore: true
        });
        expect(results.get(path.join(root, "src", "keep.ts"))).toEqual({
          included: true,
          reason: "included",
          matchedPattern: "src/**/*.ts"
        });
        expect(results.get(path.join(root, "src", "drop.ts"))?.reason).toBe("excluded");
      }
    );
  });

  it("supports glob and regex patterns", async () => {
    await withTempWorkspace(
      {
        "src": {
          "feature": {
            "component.spec.ts": "",
            "component.ts": ""
          }
        }
      },
      async (root) => {
        setWorkspaceFolder(root);
        const service = createService({ workspaceRoot: root });
        const globResult = await service.shouldIncludeFile(path.join(root, "src", "feature", "component.ts"), {
          includePatterns: ["(?i)src/**"],
          excludePatterns: []
        });
        expect(globResult.included).toBe(true);

        const regexResult = await service.shouldIncludeFile(path.join(root, "src", "feature", "component.spec.ts"), {
          includePatterns: ["/spec\\.ts$/i"]
        });
        expect(regexResult.reason).toBe("included");
      }
    );
  });

  it("records batch filtering metrics", async () => {
    await withTempWorkspace(
      {
        "files": {
          "a.txt": "",
          "b.txt": ""
        }
      },
      async (root) => {
        setWorkspaceFolder(root);
        const metrics = { recordEvaluation: jest.fn() };
        const service = createService({ workspaceRoot: root, metrics });
        await service.batchFilter([
          path.join(root, "files", "a.txt"),
          path.join(root, "files", "b.txt")
        ]);
        expect(metrics.recordEvaluation).toHaveBeenCalled();
      }
    );
  });

  it("honors configuration defaults when patterns are empty", async () => {
    await withTempWorkspace(
      {
        "docs": {
          "notes.md": ""
        }
      },
      async (root) => {
        setWorkspaceFolder(root);
        const service = createService({
          workspaceRoot: root,
          loadConfiguration: () => ({
            includePatterns: ["docs/**/*.md"],
            excludePatterns: ["**/*.tmp"],
            respectGitignore: false
          })
        });
        const result = await service.shouldIncludeFile(path.join(root, "docs", "notes.md"), {
          includePatterns: [],
          excludePatterns: []
        });
        expect(result.included).toBe(true);
      }
    );
  });

  it("provides detailed explanations for decisions", async () => {
    await withTempWorkspace(
      {
        "src": {
          "debug.log": ""
        }
      },
      async (root) => {
        setWorkspaceFolder(root);
        const service = createService({ workspaceRoot: root });
        const explanation = await service.explainDecision(path.join(root, "src", "debug.log"), {
          includePatterns: ["src/**/*"],
          excludePatterns: ["**/*.log"]
        });
        expect(explanation.result.reason).toBe("excluded");
        expect(explanation.steps.find((step) => step.stage === "exclude")?.outcome).toBe("failed");
      }
    );
  });

  it("handles gitignore integration errors gracefully", async () => {
    await withTempWorkspace(
      {
        "src": {
          "file.ts": ""
        }
      },
      async (root) => {
        setWorkspaceFolder(root);
        const gitignoreMock: Partial<GitignoreService> = {
          isIgnoredBatch: jest.fn(async () => {
            throw new Error("network");
          })
        };
        const logger = jest.fn();
        const service = createService({ workspaceRoot: root, gitignoreService: gitignoreMock as GitignoreService, logger });
        const result = await service.shouldIncludeFile(path.join(root, "src", "file.ts"), {
          includePatterns: ["src/**/*"],
          useGitignore: true
        });
        expect(result.included).toBe(true);
        expect(logger).toHaveBeenCalledWith("filter.gitignore.batch.error", expect.any(Object));
      }
    );
  });

  it("supports pattern cache eviction", async () => {
    const service = createService({ workspaceRoot: process.cwd(), maxCacheEntries: 1 });
    service.compilePattern("**/*.ts");
    service.compilePattern("**/*.js");
    expect(service.getCompiledPatterns()).toHaveLength(1);
  });

  it("filters directories with depth limits", async () => {
    await withTempWorkspace(
      {
        "src": {
          "feature": {
            "nested": {
              "file.ts": ""
            }
          }
        }
      },
      async (root) => {
        setWorkspaceFolder(root);
        const service = createService({ workspaceRoot: root });
        const result = await service.shouldIncludeDirectory(path.join(root, "src", "feature", "nested"), {
          maxDepth: 1,
          includePatterns: ["src/**/*"]
        });
        expect(result.reason).toBe("depth-limit");
      }
    );
  });
});
