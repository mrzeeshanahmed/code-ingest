import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";

import {
  RemoteRepoService,
  type AuthenticationInfo,
  type SubmoduleInfo,
  type Logger,
  type RetryConfig,
  RetryableGitOperation,
  TemporaryDirectoryManager,
  GitAuthenticator,
  AdvancedGitOperations
} from "../../services/remoteRepoService";
import type { ConfigurationService } from "../../services/configurationService";
import type { ErrorReporter } from "../../services/errorReporter";
import { spawnGitPromise } from "../../utils/procRedact";

jest.mock("../../utils/procRedact", () => ({
  spawnGitPromise: jest.fn()
}));

const vscode = jest.requireMock("../../test/__mocks__/vscode.js");
const vscodeMock = vscode as { workspace: { getConfiguration: jest.Mock } };

const spawnGitPromiseMock = spawnGitPromise as jest.MockedFunction<typeof spawnGitPromise>;

type RemoteServiceDeps = ConstructorParameters<typeof RemoteRepoService>[3];

describe("RemoteRepoService", () => {
  let tempRoot: string;

  beforeEach(async () => {
    spawnGitPromiseMock.mockReset();
    vscodeMock.workspace.getConfiguration.mockImplementation(() => ({
      get: jest.fn((key: string, fallback: unknown) => fallback)
    }));
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "remote-repo-service-"));
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const createLogger = (): Logger => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  });

  const createConfigService = (): ConfigurationService => ({
    loadConfig: jest.fn()
  }) as unknown as ConfigurationService;

  const createErrorReporter = (): ErrorReporter => ({
    report: jest.fn()
  }) as unknown as ErrorReporter;

  test("performs partial clone with sparse checkout and reports progress", async () => {
    spawnGitPromiseMock.mockImplementation(async (args) => {
      if (args[0] === "ls-remote") {
        return { stdout: "abc123\trefs/heads/main\n", stderr: "" };
      }
      if (args[0] === "-C" && args[2] === "log") {
        return { stdout: "abc123\nmessage\nauthor\n2024-01-01T00:00:00Z\n", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });

    const setupCredentials = jest.fn(async () => ({
      method: "none",
      successful: true,
      credentialsUsed: false
    } satisfies AuthenticationInfo));
    const authenticator = {
      setupCredentials,
      detectAuthenticationMethod: jest.fn(async () => "none"),
      testAuthentication: jest.fn(async () => true)
    } as unknown as GitAuthenticator;

    const partialClone = jest.fn(async () => undefined);
    const standardClone = jest.fn(async () => undefined);
    const setupSparse = jest.fn(async () => undefined);
    const initSubmodules = jest.fn(async () => [] as SubmoduleInfo[]);
    const gitOperations = {
      partialClone,
      standardClone,
      setupSparseCheckout: setupSparse,
      fetchMissing: jest.fn(async () => undefined),
      initializeSubmodules: initSubmodules
    } as unknown as AdvancedGitOperations;

    const cleanup = jest.fn(async () => undefined);
    const tempManager = {
      createTempDir: jest.fn(async () => tempRoot),
      cleanup,
      cleanupAll: jest.fn(async () => undefined),
      setupProcessCleanup: jest.fn(() => undefined)
    } as unknown as TemporaryDirectoryManager;

    const dependencies: RemoteServiceDeps = {
      authenticator,
      gitOperations,
      tempDirectoryManager: tempManager,
      retryFactory: (config: RetryConfig) => new RetryableGitOperation(config, createLogger(), async () => undefined)
    };

    const progressSpy = jest.fn();

    const logger = createLogger();
    const service = new RemoteRepoService(createConfigService(), createErrorReporter(), logger, dependencies);

    const result = await service.cloneRepository({
      url: "https://example.com/repo.git",
      partialClone: true,
      sparseCheckout: ["src", "README.md"],
      progressCallback: progressSpy
    });

    expect(partialClone).toHaveBeenCalledTimes(1);
    expect(partialClone).toHaveBeenCalledWith("https://example.com/repo.git", tempRoot, expect.objectContaining({
      filterSpec: "blob:none",
      signal: expect.any(Object)
    }));
    expect(standardClone).not.toHaveBeenCalled();
    expect(setupSparse).toHaveBeenCalledWith(
      tempRoot,
      ["src", "README.md"],
      expect.objectContaining({ signal: expect.any(Object) })
    );
    expect(result.metadata.resolvedRef).toBe("abc123");
    expect(result.statistics.partialClone).toBe(true);
    expect(progressSpy).toHaveBeenCalledWith(expect.objectContaining({ phase: "complete" }));
  });

  test("retries on transient clone error and succeeds", async () => {
    spawnGitPromiseMock.mockImplementation(async (args) => {
      if (args[0] === "ls-remote") {
        return { stdout: "def456\trefs/heads/main\n", stderr: "" };
      }
      if (args[0] === "-C" && args[2] === "log") {
        return { stdout: "def456\nmessage\nauthor\n2024-02-02T00:00:00Z\n", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });

  const standardClone = jest.fn(async () => undefined);
    standardClone.mockRejectedValueOnce(new Error("connection reset"));
    standardClone.mockResolvedValueOnce(undefined);

    const gitOperations = {
      partialClone: jest.fn(async () => undefined),
      standardClone,
      setupSparseCheckout: jest.fn(async () => undefined),
      fetchMissing: jest.fn(async () => undefined),
      initializeSubmodules: jest.fn(async () => [] as SubmoduleInfo[])
    } as unknown as AdvancedGitOperations;

    const tempManager = {
      createTempDir: jest.fn(async () => tempRoot),
      cleanup: jest.fn(async () => undefined),
      cleanupAll: jest.fn(async () => undefined),
      setupProcessCleanup: jest.fn(() => undefined)
    } as unknown as TemporaryDirectoryManager;

    const dependencies: RemoteServiceDeps = {
      authenticator: {
        setupCredentials: jest.fn(async () => ({
          method: "none",
          successful: true,
          credentialsUsed: false
        } satisfies AuthenticationInfo)),
        detectAuthenticationMethod: jest.fn(async () => "none"),
        testAuthentication: jest.fn(async () => true)
      } as unknown as GitAuthenticator,
      gitOperations,
      tempDirectoryManager: tempManager,
      retryFactory: (config: RetryConfig) => new RetryableGitOperation(config, createLogger(), async () => undefined)
    };

    const logger = createLogger();
    const service = new RemoteRepoService(createConfigService(), createErrorReporter(), logger, dependencies);

    const result = await service.cloneRepository({
      url: "https://example.com/retry.git",
      partialClone: false
    });

    expect(standardClone).toHaveBeenCalledTimes(2);
    expect(result.statistics.retriesPerformed).toBe(1);
  });

  test("cleans up temporary directory when clone fails", async () => {
    spawnGitPromiseMock.mockResolvedValue({ stdout: "", stderr: "" });

    const cleanup = jest.fn(async () => undefined);
    const tempManager = {
      createTempDir: jest.fn(async () => tempRoot),
      cleanup,
      cleanupAll: jest.fn(async () => undefined),
      setupProcessCleanup: jest.fn(() => undefined)
    } as unknown as TemporaryDirectoryManager;

    const partialClone = jest.fn(async () => {
      throw new Error("network timed out");
    });

    const dependencies: RemoteServiceDeps = {
      authenticator: {
        setupCredentials: jest.fn(async () => ({
          method: "none",
          successful: true,
          credentialsUsed: false
        } satisfies AuthenticationInfo)),
        detectAuthenticationMethod: jest.fn(async () => "none"),
        testAuthentication: jest.fn(async () => true)
      } as unknown as GitAuthenticator,
      gitOperations: {
        partialClone,
        standardClone: jest.fn(async () => undefined),
        setupSparseCheckout: jest.fn(async () => undefined),
        fetchMissing: jest.fn(async () => undefined),
        initializeSubmodules: jest.fn(async () => [] as SubmoduleInfo[])
      } as unknown as AdvancedGitOperations,
      tempDirectoryManager: tempManager,
      retryFactory: (config: RetryConfig) => new RetryableGitOperation(config, createLogger(), async () => undefined)
    };

    const logger = createLogger();
    const service = new RemoteRepoService(createConfigService(), createErrorReporter(), logger, dependencies);

    await expect(
      service.cloneRepository({
        url: "https://example.com/fail.git",
        partialClone: true,
        keepTmpDir: false
      })
    ).rejects.toMatchObject({ message: expect.stringContaining("network timed out") });

    expect(cleanup).toHaveBeenCalledWith(tempRoot);
  });

  test("cancels active operations before process cleanup", async () => {
    spawnGitPromiseMock.mockResolvedValue({ stdout: "", stderr: "" });

    const beforeCleanupCalls: Array<() => Promise<void>> = [];
    const setupProcessCleanup = jest.fn((options?: { beforeCleanup?: () => Promise<void> }) => {
      if (options?.beforeCleanup) {
        beforeCleanupCalls.push(options.beforeCleanup);
      }
    });

    const partialClone = jest.fn(async (_url: string, _dir: string, options: { signal?: AbortSignal }) => {
      return new Promise<void>((_resolve, reject) => {
        const signal = options.signal;
        if (signal?.aborted) {
          reject(new Error("Operation cancelled"));
          return;
        }
        signal?.addEventListener(
          "abort",
          () => {
            reject(new Error("Operation cancelled"));
          },
          { once: true }
        );
      });
    });

    const dependencies: RemoteServiceDeps = {
      authenticator: {
        setupCredentials: jest.fn(async () => ({
          method: "none",
          successful: true,
          credentialsUsed: false
        } satisfies AuthenticationInfo)),
        detectAuthenticationMethod: jest.fn(async () => "none"),
        testAuthentication: jest.fn(async () => true)
      } as unknown as GitAuthenticator,
      gitOperations: {
        partialClone,
        standardClone: jest.fn(),
        setupSparseCheckout: jest.fn(),
        fetchMissing: jest.fn(),
        initializeSubmodules: jest.fn(async () => [] as SubmoduleInfo[])
      } as unknown as AdvancedGitOperations,
      tempDirectoryManager: {
        createTempDir: jest.fn(async () => tempRoot),
        cleanup: jest.fn(async () => undefined),
        cleanupAll: jest.fn(async () => undefined),
        setupProcessCleanup
      } as unknown as TemporaryDirectoryManager,
      retryFactory: (config: RetryConfig) => new RetryableGitOperation(config, createLogger(), async () => undefined)
    };

    const service = new RemoteRepoService(createConfigService(), createErrorReporter(), createLogger(), dependencies);

    expect(beforeCleanupCalls).toHaveLength(1);
    const beforeCleanup = beforeCleanupCalls[0];
    expect(beforeCleanup).toBeDefined();

    const clonePromise = service.cloneRepository({
      url: "https://example.com/slow.git",
      partialClone: true
    });

    await new Promise((resolve) => setImmediate(resolve));
    expect(partialClone).toHaveBeenCalledTimes(1);
    const cloneArgs = partialClone.mock.calls[0]?.[2];
    expect(cloneArgs?.signal).toBeDefined();
    expect(cloneArgs?.signal?.aborted).toBe(false);

    await beforeCleanup?.();

    await expect(clonePromise).rejects.toThrow("Operation cancelled");
    expect(cloneArgs?.signal?.aborted).toBe(true);
  });
});

describe("TemporaryDirectoryManager", () => {
  let onceSpy: jest.SpiedFunction<typeof process.once>;
  let exitSpy: jest.SpiedFunction<typeof process.exit>;

  beforeEach(() => {
    onceSpy = jest.spyOn(process, "once");
    exitSpy = jest.spyOn(process, "exit");
  });

  afterEach(() => {
    onceSpy.mockRestore();
    exitSpy.mockRestore();
  });

  test("registers cleanup handlers and performs graceful SIGINT cleanup", async () => {
    const listeners = new Map<string, (...args: unknown[]) => void>();

    onceSpy.mockImplementation(((event: string, listener: (...args: unknown[]) => void) => {
      listeners.set(event, listener);
      return process;
    }) as typeof process.once);
    exitSpy.mockImplementation((() => undefined) as typeof process.exit);

    // Save and restore exit code for test isolation
    const originalExitCode = process.exitCode;
    process.exitCode = undefined;

    const manager = new TemporaryDirectoryManager();
    const order: string[] = [];
    const beforeCleanup = jest.fn(async () => {
      order.push("before");
    });
    const cleanupAllSpy = jest.spyOn(manager, "cleanupAll").mockImplementation(async () => {
      order.push("cleanup");
    });

    manager.setupProcessCleanup({ beforeCleanup });

    const sigintHandler = listeners.get("SIGINT");
    expect(sigintHandler).toBeDefined();

    sigintHandler?.();

    await new Promise((resolve) => setImmediate(resolve));

    expect(beforeCleanup).toHaveBeenCalledTimes(1);
    expect(cleanupAllSpy).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["before", "cleanup"]);
    expect(process.exitCode).toBe(130);
    expect(exitSpy).not.toHaveBeenCalled();

    // restore exit code
    process.exitCode = originalExitCode;
  });
});
