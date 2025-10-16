import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";
import * as vscode from "vscode";

import { wrapError } from "../utils/errorHandling";
import { spawnGitPromise } from "../utils/procRedact";
import { ConfigurationService } from "./configurationService";
import { ErrorReporter } from "./errorReporter";

/**
 * Minimal structured logger interface expected by the remote repo service.
 */
export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

/**
 * Options describing how a remote repository should be cloned.
 */
export interface RemoteRepoOptions {
  url: string;
  ref?: string;
  sparseCheckout?: string[];
  includeSubmodules?: boolean;
  partialClone?: boolean;
  maxDepth?: number;
  keepTmpDir?: boolean;
  timeout?: number;
  retryCount?: number;
  progressCallback?: (progress: CloneProgress) => void;
  cancellationToken?: vscode.CancellationToken;
}

/**
 * Structured progress information emitted while cloning.
 */
export interface CloneProgress {
  phase: "authenticating" | "cloning" | "checking-out" | "submodules" | "complete";
  percent: number;
  message: string;
  currentFile?: string;
}

/**
 * Summary information about a cloned repository.
 */
export interface RemoteRepoResult {
  localPath: string;
  metadata: RepositoryMetadata;
  statistics: CloneStatistics;
  warnings: string[];
  authenticationUsed: boolean;
}

/**
 * Metadata describing the repository that was cloned.
 */
export interface RepositoryMetadata {
  url: string;
  resolvedRef: string;
  cloneSize: number;
  fileCount: number;
  lastCommit: {
    sha: string;
    message: string;
    author: string;
    date: Date;
  };
  submodules: SubmoduleInfo[];
}

/**
 * Basic submodule information discovered during clone.
 */
export interface SubmoduleInfo {
  name: string;
  path: string;
  url: string;
  commit: string;
  initialized: boolean;
}

/**
 * Clone statistics collected during operations.
 */
export interface CloneStatistics {
  attempts: number;
  durationMs: number;
  partialClone: boolean;
  sparseCheckout: boolean;
  retriesPerformed: number;
  startTime: Date;
  endTime: Date;
}

/**
 * Authentication metadata returned by {@link GitAuthenticator}.
 */
export interface AuthenticationInfo {
  method: "none" | "token" | "ssh-key" | "credentials";
  successful: boolean;
  username?: string;
  credentialsUsed: boolean;
  env?: NodeJS.ProcessEnv;
}

/**
 * Result of validating a remote repository URL.
 */
export interface RepositoryValidation {
  isValid: boolean;
  exists: boolean;
  isAccessible: boolean;
  size?: number;
  defaultBranch?: string;
  availableRefs: string[];
  requiresAuthentication: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Configuration snapshot sourced from VS Code settings.
 */
interface RemoteRepoConfigSnapshot {
  maxTimeout: number;
  maxRetries: number;
  usePartialClone: boolean;
  defaultSparsePatterns: string[];
  keepTempDirs: boolean;
  retryableErrors: string[];
}

interface RemoteOperationHandle {
  cancel(): void;
  completion: Promise<void>;
  abortSignal: AbortSignal;
  cancellationToken: vscode.CancellationToken;
  markFinished(): void;
  markFailed(reason?: unknown): void;
}

interface MergedRemoteRepoOptions {
  url: string;
  ref?: string;
  sparseCheckout: string[];
  includeSubmodules: boolean;
  partialClone: boolean;
  maxDepth?: number;
  keepTmpDir: boolean;
  timeout: number;
  retryCount: number;
  progressCallback?: (progress: CloneProgress) => void;
  cancellationToken?: vscode.CancellationToken;
}

/**
 * Internal dependencies that can be overridden for testing.
 */
interface RemoteRepoServiceDependencies {
  authenticator?: GitAuthenticator;
  gitOperations?: AdvancedGitOperations;
  validator?: RepositoryValidator;
  tempDirectoryManager?: TemporaryDirectoryManager;
  retryFactory?: (config: RetryConfig) => RetryableGitOperation;
  progressTrackerFactory?: (callback?: (progress: CloneProgress) => void, token?: vscode.CancellationToken) => ProgressTracker;
}

/**
 * Error thrown when git cannot be invoked.
 */
export class GitNotAvailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitNotAvailableError";
  }
}

/**
 * Remote repository cloning service with authentication and sparse/partial clone support.
 */
export class RemoteRepoService {
  private readonly authenticator: GitAuthenticator;
  private readonly gitOperations: AdvancedGitOperations;
  private readonly validator: RepositoryValidator;
  private readonly tempDirectoryManager: TemporaryDirectoryManager;
  private readonly retryFactory: (config: RetryConfig) => RetryableGitOperation;
  private readonly progressTrackerFactory: (callback?: (progress: CloneProgress) => void, token?: vscode.CancellationToken) => ProgressTracker;
  private readonly activeOperations = new Set<RemoteOperationHandle>();

  constructor(
    private readonly configService: ConfigurationService,
    private readonly errorReporter: ErrorReporter,
    private readonly logger: Logger,
    dependencies: RemoteRepoServiceDependencies = {}
  ) {
    this.authenticator = dependencies.authenticator ?? new GitAuthenticator(configService, logger);
    this.gitOperations = dependencies.gitOperations ?? new AdvancedGitOperations(logger);
    this.validator = dependencies.validator ?? new RepositoryValidator(logger);
    this.tempDirectoryManager =
      dependencies.tempDirectoryManager ?? new TemporaryDirectoryManager(logger, errorReporter);
    this.tempDirectoryManager.setupProcessCleanup({
      beforeCleanup: () => this.cancelActiveOperations()
    });
    this.retryFactory = dependencies.retryFactory ?? ((config) => new RetryableGitOperation(config, logger));
    this.progressTrackerFactory =
      dependencies.progressTrackerFactory ?? ((callback, token) => new ProgressTracker(callback, token));
  }
  /**
   * Clones a remote repository according to the provided options and returns metadata about the clone.
   */
  async cloneRepository(options: RemoteRepoOptions): Promise<RemoteRepoResult> {
    const started = Date.now();
    const settings = this.getRemoteRepoSettings();
    const merged = this.mergeOptions(options, settings);
    const operationScope = this.createOperationHandle();
    const externalCancellationDisposables: vscode.Disposable[] = [];

    if (merged.cancellationToken) {
      if (merged.cancellationToken.isCancellationRequested) {
        operationScope.cancel();
      } else {
        const disposable = merged.cancellationToken.onCancellationRequested(() => {
          operationScope.cancel();
        });
        externalCancellationDisposables.push(disposable);
      }
    }

    const tracker = this.progressTrackerFactory(merged.progressCallback, operationScope.cancellationToken);
    const sanitizedUrl = sanitizeUrl(merged.url);
    const warnings: string[] = [];

    this.logger.info("remoteRepo.clone.start", { url: sanitizedUrl, ref: merged.ref ?? "HEAD" });

    tracker.reportProgress("authenticating", 5, "Preparing authentication");
    const authInfo = await this.authenticateIfNeeded(merged.url);

    tracker.reportProgress("cloning", 10, "Creating temporary directory");
    const tmpDir = await this.tempDirectoryManager.createTempDir();

    const retryConfig: RetryConfig = {
      maxAttempts: merged.retryCount,
      baseDelay: 500,
      maxDelay: 5_000,
      backoffMultiplier: 2,
      retryableErrors: settings.retryableErrors
    } satisfies RetryConfig;
    const retryHelper = this.retryFactory(retryConfig);

    let attempts = 0;
    let resolvedRef = merged.ref ?? "";
    try {
      tracker.reportProgress("cloning", 20, merged.partialClone ? "Starting partial clone" : "Starting clone");
      await retryHelper.executeWithRetry(async () => {
        attempts += 1;
        tracker.checkCancellation();
        try {
          const baseOptions: CloneExecutionOptions = {
            singleBranch: Boolean(merged.ref),
            signal: operationScope.abortSignal
          };
          if (merged.ref) {
            baseOptions.branch = merged.ref;
          }
          if (typeof merged.maxDepth === "number") {
            baseOptions.depth = merged.maxDepth;
          }
          if (authInfo.env) {
            baseOptions.env = authInfo.env;
          }

          if (merged.partialClone) {
            await this.gitOperations.partialClone(merged.url, tmpDir, {
              ...baseOptions,
              filterSpec: "blob:none"
            });
          } else {
            await this.gitOperations.standardClone(merged.url, tmpDir, baseOptions);
          }
        } catch (error) {
          throw wrapError(error, { stage: "clone", url: sanitizedUrl });
        }
      }, "remoteRepo.clone");

  tracker.reportProgress("checking-out", 70, "Resolving commit");
  resolvedRef = await this.resolveRef(merged.url, merged.ref ?? "HEAD", operationScope.abortSignal);

      if (merged.sparseCheckout.length > 0) {
        tracker.reportProgress("checking-out", 75, "Configuring sparse checkout");
        await this.setupSparseCheckout(tmpDir, merged.sparseCheckout, authInfo.env, operationScope.abortSignal);
      }

      if (merged.includeSubmodules) {
        tracker.reportProgress("submodules", 85, "Initializing submodules");
      }
      const submodules = merged.includeSubmodules
        ? await this.initializeSubmodules(tmpDir, authInfo.env, operationScope.abortSignal)
        : [];

      const metadata = await this.collectRepositoryMetadata(
        tmpDir,
        merged.url,
        resolvedRef,
        submodules,
        authInfo.env,
        operationScope.abortSignal
      );

      tracker.reportProgress("complete", 100, "Clone completed successfully");

      const result: RemoteRepoResult = {
        localPath: tmpDir,
        metadata,
        statistics: {
          attempts,
          durationMs: Date.now() - started,
          partialClone: merged.partialClone,
          sparseCheckout: merged.sparseCheckout.length > 0,
          retriesPerformed: attempts > 0 ? attempts - 1 : 0,
          startTime: new Date(started),
          endTime: new Date()
        },
        warnings,
        authenticationUsed: authInfo.credentialsUsed
      } satisfies RemoteRepoResult;

      this.logger.info("remoteRepo.clone.success", {
        url: sanitizedUrl,
        attempts,
        resolvedRef,
        durationMs: result.statistics.durationMs
      });

      return result;
    } catch (error) {
      const wrapped = wrapError(error, { scope: "remoteRepo.clone", url: sanitizedUrl });
      operationScope.markFailed(wrapped);
      this.logger.error("remoteRepo.clone.failed", { url: sanitizedUrl, message: wrapped.message });
      this.errorReporter.report(wrapped, { source: "remoteRepo.clone", metadata: { url: sanitizedUrl } });
      if (!merged.keepTmpDir) {
        await this.safeCleanup(tmpDir);
      } else {
        warnings.push("Clone failed but temporary directory retained for inspection.");
      }
      throw wrapped;
    } finally {
      for (const disposable of externalCancellationDisposables) {
        try {
          disposable.dispose();
        } catch {
          // ignore cancellation disposal errors
        }
      }
      operationScope.markFinished();
    }
  }

  /**
   * Validate a repository URL, returning structural and access diagnostics.
   */
  async validateRepository(url: string): Promise<RepositoryValidation> {
    return this.validator.validateRepository(url);
  }

  /**
   * Resolves a reference (branch, tag, or commit) to an absolute commit SHA.
   */
  async resolveRef(url: string, ref: string, signal?: AbortSignal): Promise<string> {
    try {
      const response = await spawnGitPromise(["ls-remote", url, ref], {
        secretsToRedact: [url],
        ...(signal ? { signal } : {})
      });
      const line = response.stdout.split(/\r?\n/).find((entry) => entry.trim().length > 0);
      if (!line) {
        throw new Error(`Unable to resolve reference '${ref}' for ${sanitizeUrl(url)}`);
      }
      return line.split(/\s+/)[0];
    } catch (error) {
      const wrapped = wrapError(error, { scope: "remoteRepo.resolveRef", ref, url: sanitizeUrl(url) });
      this.errorReporter.report(wrapped, { source: "remoteRepo.resolveRef", metadata: { ref, url: sanitizeUrl(url) } });
      throw wrapped;
    }
  }

  /**
   * Ensures authentication is configured when required for the URL.
   */
  async authenticateIfNeeded(url: string): Promise<AuthenticationInfo> {
    return this.authenticator.setupCredentials(url);
  }

  /**
   * Configures sparse checkout for an existing clone.
   */
  async setupSparseCheckout(localPath: string, patterns: string[], env?: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<void> {
    const options = env || signal ? { ...(env ? { env } : {}), ...(signal ? { signal } : {}) } : undefined;
    await this.gitOperations.setupSparseCheckout(localPath, patterns, options);
  }

  /**
   * Initializes submodules and returns discovered metadata.
   */
  async initializeSubmodules(localPath: string, env?: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<SubmoduleInfo[]> {
    const options = env || signal ? { ...(env ? { env } : {}), ...(signal ? { signal } : {}) } : undefined;
    return this.gitOperations.initializeSubmodules(localPath, options);
  }

  /**
   * Cleans up a previously created temporary directory.
   */
  async cleanup(localPath: string): Promise<void> {
    await this.safeCleanup(localPath);
  }

  private mergeOptions(options: RemoteRepoOptions, settings: RemoteRepoConfigSnapshot): MergedRemoteRepoOptions {
    const sparseFromOptions = options.sparseCheckout ?? [];
    const defaultSparse = Array.isArray(settings.defaultSparsePatterns) ? settings.defaultSparsePatterns : [];
    const sparse = sparseFromOptions.length > 0 ? sparseFromOptions : defaultSparse;
    const merged: MergedRemoteRepoOptions = {
      url: options.url,
      sparseCheckout: [...sparse],
      includeSubmodules: options.includeSubmodules ?? false,
      partialClone: options.partialClone ?? settings.usePartialClone,
      keepTmpDir: options.keepTmpDir ?? settings.keepTempDirs,
      timeout: Math.max(1, options.timeout ?? settings.maxTimeout),
      retryCount: Math.max(1, options.retryCount ?? settings.maxRetries)
    };

    if (typeof options.maxDepth === "number") {
      merged.maxDepth = options.maxDepth;
    }
    if (options.ref) {
      merged.ref = options.ref;
    }
    if (options.progressCallback) {
      merged.progressCallback = options.progressCallback;
    }
    if (options.cancellationToken) {
      merged.cancellationToken = options.cancellationToken;
    }

    return merged;
  }

  private getRemoteRepoSettings(): RemoteRepoConfigSnapshot {
    const workspaceConfig = vscode.workspace.getConfiguration("codeIngest.remoteRepo");
    const maxTimeoutRaw = workspaceConfig.get<number>("maxTimeout");
    const maxRetriesRaw = workspaceConfig.get<number>("maxRetries");
    const usePartialCloneRaw = workspaceConfig.get<boolean>("usePartialClone");
    const defaultSparseRaw = workspaceConfig.get<string[]>("defaultSparsePatterns");
    const keepTempDirsRaw = workspaceConfig.get<boolean>("keepTempDirs");
    const retryableErrorsRaw = workspaceConfig.get<string[]>("retryableErrors");

    const maxTimeout = typeof maxTimeoutRaw === "number" && Number.isFinite(maxTimeoutRaw) && maxTimeoutRaw > 0 ? maxTimeoutRaw : 300_000;
    const maxRetries = typeof maxRetriesRaw === "number" && Number.isFinite(maxRetriesRaw) && maxRetriesRaw > 0 ? maxRetriesRaw : 3;
    const usePartialClone = typeof usePartialCloneRaw === "boolean" ? usePartialCloneRaw : true;
    const defaultSparsePatterns = Array.isArray(defaultSparseRaw) ? defaultSparseRaw : [];
    const keepTempDirs = typeof keepTempDirsRaw === "boolean" ? keepTempDirsRaw : false;
    const retryableErrors = Array.isArray(retryableErrorsRaw) && retryableErrorsRaw.length > 0
      ? retryableErrorsRaw
      : ["timed out", "connection reset", "temporary failure", "remote hung up"];

    return {
      maxTimeout,
      maxRetries,
      usePartialClone,
      defaultSparsePatterns,
      keepTempDirs,
      retryableErrors
    } satisfies RemoteRepoConfigSnapshot;
  }

  private async collectRepositoryMetadata(
    localPath: string,
    url: string,
    resolvedRef: string,
    submodules: SubmoduleInfo[],
    env?: NodeJS.ProcessEnv,
    signal?: AbortSignal
  ): Promise<RepositoryMetadata> {
    const headInfo = await this.getLastCommit(localPath, env, signal);
    const cloneSize = await this.calculateDirectorySize(localPath);
    const fileCount = await this.countFiles(localPath);

    return {
      url: sanitizeUrl(url),
      resolvedRef,
      cloneSize,
      fileCount,
      lastCommit: headInfo,
      submodules
    } satisfies RepositoryMetadata;
  }

  private async getLastCommit(localPath: string, env?: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<RepositoryMetadata["lastCommit"]> {
    try {
      const options: { secretsToRedact: string[]; env?: NodeJS.ProcessEnv; signal?: AbortSignal } = { secretsToRedact: [localPath] };
      if (env) {
        options.env = env;
      }
      if (signal) {
        options.signal = signal;
      }
      const { stdout } = await spawnGitPromise([
        "-C",
        localPath,
        "log",
        "-1",
        "--pretty=format:%H%n%s%n%an%n%aI"
      ], options);
      const [sha, message, author, date] = stdout.split(/\r?\n/);
      return {
        sha: sha ?? "",
        message: message ?? "",
        author: author ?? "",
        date: date ? new Date(date) : new Date()
      };
    } catch (error) {
      const wrapped = wrapError(error, { scope: "remoteRepo.lastCommit", localPath });
      this.logger.warn("remoteRepo.lastCommit.failed", { localPath, message: wrapped.message });
      this.errorReporter.report(wrapped, { source: "remoteRepo.metadata", metadata: { stage: "lastCommit" } });
      return {
        sha: "unknown",
        message: "Unable to read last commit",
        author: "unknown",
        date: new Date()
      };
    }
  }

  private async calculateDirectorySize(root: string): Promise<number> {
    let total = 0;
    const stack: string[] = [root];
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current) {
        continue;
      }
      try {
        const entries = await fs.readdir(current, { withFileTypes: true });
        for (const entry of entries) {
          const entryPath = path.join(current, entry.name);
          if (entry.isDirectory()) {
            stack.push(entryPath);
            continue;
          }
          if (entry.isFile()) {
            const stat = await fs.stat(entryPath);
            total += stat.size;
          }
        }
      } catch {
        // Ignore inaccessible files.
      }
    }
    return total;
  }

  private async countFiles(root: string): Promise<number> {
    let count = 0;
    const stack: string[] = [root];
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current) {
        continue;
      }
      try {
        const entries = await fs.readdir(current, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            stack.push(path.join(current, entry.name));
          } else if (entry.isFile()) {
            count += 1;
          }
        }
      } catch {
        // Ignore.
      }
    }
    return count;
  }

  private async safeCleanup(localPath: string): Promise<void> {
    try {
      await this.tempDirectoryManager.cleanup(localPath);
    } catch (error) {
      const wrapped = wrapError(error, { scope: "remoteRepo.cleanup", path: localPath });
      this.logger.warn("remoteRepo.cleanup.failed", { path: localPath, message: wrapped.message });
      this.errorReporter.report(wrapped, { source: "remoteRepo.cleanup", metadata: { path: localPath } });
    }
  }

  private createOperationHandle(): RemoteOperationHandle {
    const abortController = new AbortController();
    const cancellationSource = new vscode.CancellationTokenSource();
    let settled = false;
    let resolveCompletion!: () => void;
    let rejectCompletion!: (reason?: unknown) => void;
    const completion = new Promise<void>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    void completion.catch(() => undefined);

    const handle: RemoteOperationHandle = {
      abortSignal: abortController.signal,
      cancellationToken: cancellationSource.token,
      completion,
      cancel: () => {
        if (!cancellationSource.token.isCancellationRequested) {
          cancellationSource.cancel();
        }
        if (!abortController.signal.aborted) {
          abortController.abort();
        }
      },
      markFinished: () => {
        if (settled) {
          return;
        }
        settled = true;
        resolveCompletion();
        this.activeOperations.delete(handle);
        cancellationSource.dispose();
      },
      markFailed: (reason?: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        rejectCompletion(reason);
        this.activeOperations.delete(handle);
        cancellationSource.dispose();
      }
    } satisfies RemoteOperationHandle;

    this.activeOperations.add(handle);
    return handle;
  }

  private async cancelActiveOperations(): Promise<void> {
    const operations = Array.from(this.activeOperations);
    if (operations.length === 0) {
      return;
    }

    for (const operation of operations) {
      try {
        operation.cancel();
      } catch {
        // Ignore cancellation errors during shutdown
      }
    }

    await Promise.allSettled(
      operations.map((operation) =>
        operation.completion.catch(() => {
          // Swallow rejection when coordinating shutdown
        })
      )
    );
  }
}

/**
 * Authentication helper for git operations.
 */
export class GitAuthenticator {
  constructor(private readonly configService: ConfigurationService, private readonly logger: Logger) {}

  async detectAuthenticationMethod(url: string): Promise<"none" | "token" | "ssh-key"> {
    if (url.startsWith("git@")) {
      return "ssh-key";
    }
    const config = vscode.workspace.getConfiguration("codeIngest.remoteRepo");
    const token = config.get<string | undefined>("authToken");
    if (token && url.startsWith("http")) {
      return "token";
    }
    return "none";
  }

  async setupCredentials(url: string): Promise<AuthenticationInfo> {
    const method = await this.detectAuthenticationMethod(url);
    const sanitizedUrl = sanitizeUrl(url);
    if (method === "none") {
      return { method, successful: true, credentialsUsed: false };
    }

    if (method === "token") {
      const config = vscode.workspace.getConfiguration("codeIngest.remoteRepo");
      const token = config.get<string | undefined>("authToken");
      if (!token) {
        this.logger.warn("remoteRepo.auth.tokenMissing", { url: sanitizedUrl });
        return { method: "none", successful: false, credentialsUsed: false };
      }
      const env = {
        ...process.env,
        GIT_ASKPASS: path.join(os.tmpdir(), `code-ingest-askpass-${randomUUID()}.cmd`),
        GIT_TERMINAL_PROMPT: "0"
      };
      await createAskPassScript(env.GIT_ASKPASS, token);
      this.logger.debug("remoteRepo.auth.tokenConfigured", { url: sanitizedUrl });
      return { method: "token", successful: true, credentialsUsed: true, env };
    }

    if (method === "ssh-key") {
      await this.setupSSHAgent();
      this.logger.debug("remoteRepo.auth.sshConfigured", { url: sanitizedUrl });
      return { method: "ssh-key", successful: true, credentialsUsed: true };
    }

    return { method: "none", successful: false, credentialsUsed: false };
  }

  async testAuthentication(url: string): Promise<boolean> {
    try {
      await spawnGitPromise(["ls-remote", url, "HEAD"], { secretsToRedact: [url] });
      return true;
    } catch (error) {
      this.logger.warn("remoteRepo.auth.testFailed", { url: sanitizeUrl(url), message: (error as Error).message });
      return false;
    }
  }

  private async setupGitCredentialHelper(): Promise<void> {
    await spawnGitPromise(["config", "--global", "credential.useHttpPath", "true"]);
  }

  private async setupSSHAgent(): Promise<void> {
    try {
      await this.setupGitCredentialHelper();
    } catch (error) {
      this.logger.warn("remoteRepo.auth.helper", { message: (error as Error).message });
    }
  }
}

/**
 * Collection of low-level git operations with support for sparse and partial clones.
 */
interface CloneExecutionOptions {
  filterSpec?: string;
  depth?: number;
  singleBranch?: boolean;
  branch?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

interface GitOperationOptions {
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

export class AdvancedGitOperations {
  constructor(private readonly logger: Logger) {}

  async partialClone(
    url: string,
    localPath: string,
    options: CloneExecutionOptions
  ): Promise<void> {
    const args = ["clone", "--progress", "--no-checkout"];
    if (options.filterSpec) {
      args.push(`--filter=${options.filterSpec}`);
    }
    if (options.depth) {
      args.push(`--depth=${options.depth}`);
    }
    if (options.singleBranch) {
      args.push("--single-branch");
    }
    if (options.branch) {
      args.push("--branch", options.branch);
    }
    args.push(url, localPath);

    this.logger.debug("remoteRepo.git.partialClone", { url: sanitizeUrl(url) });
    await this.execGit(args, {
      ...(options.env ? { env: options.env } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      secretsToRedact: [url]
    });
  }

  async standardClone(
    url: string,
    localPath: string,
    options: CloneExecutionOptions
  ): Promise<void> {
    const args = ["clone", "--progress"];
    if (options.depth) {
      args.push(`--depth=${options.depth}`);
    }
    if (options.singleBranch) {
      args.push("--single-branch");
    }
    if (options.branch) {
      args.push("--branch", options.branch);
    }
    args.push(url, localPath);
    this.logger.debug("remoteRepo.git.clone", { url: sanitizeUrl(url) });
    await this.execGit(args, {
      ...(options.env ? { env: options.env } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      secretsToRedact: [url]
    });
  }

  async setupSparseCheckout(localPath: string, patterns: string[], options?: GitOperationOptions): Promise<void> {
    if (patterns.length === 0) {
      return;
    }
    const normalised = patterns.map((pattern) => pattern.trim()).filter((pattern) => pattern.length > 0);
    if (normalised.length === 0) {
      return;
    }
    const execOptions = options?.env ? { env: options.env } : undefined;
    await this.execGit(["-C", localPath, "sparse-checkout", "init", "--cone"], {
      ...(execOptions ?? {}),
      ...(options?.signal ? { signal: options.signal } : {})
    });
    await this.execGit(["-C", localPath, "sparse-checkout", "set", ...normalised], {
      ...(execOptions ?? {}),
      ...(options?.signal ? { signal: options.signal } : {})
    });
  }

  async fetchMissing(localPath: string, paths: string[], options?: GitOperationOptions): Promise<void> {
    if (paths.length === 0) {
      return;
    }
    const sanitized = paths.map((p) => p.replace(/\s+/g, ""));
    await this.execGit(["-C", localPath, "fetch", "origin", "--depth=1", ...sanitized], {
      ...(options?.env ? { env: options.env } : {}),
      ...(options?.signal ? { signal: options.signal } : {})
    });
  }

  async initializeSubmodules(localPath: string, options?: GitOperationOptions): Promise<SubmoduleInfo[]> {
    try {
      await this.execGit(["-C", localPath, "submodule", "update", "--init", "--recursive"], {
        ...(options?.env ? { env: options.env } : {}),
        ...(options?.signal ? { signal: options.signal } : {})
      });
    } catch (error) {
      this.logger.warn("remoteRepo.submodules.initFailed", { path: localPath, message: (error as Error).message });
      return [];
    }

    try {
      const { stdout } = await this.execGit([
        "-C",
        localPath,
        "config",
        "--file",
        ".gitmodules",
        "--get-regexp",
        "path"
      ], {
        ...(options?.env ? { env: options.env } : {}),
        ...(options?.signal ? { signal: options.signal } : {})
      });
      const lines = stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
      const submodules: SubmoduleInfo[] = [];
      for (const line of lines) {
        const [, key, modulePath] = line.match(/submodule\.(.+?)\.path\s+(.+)/) ?? [];
        if (!key || !modulePath) {
          continue;
        }
        const urlResult = await this.execGit([
          "-C",
          localPath,
          "config",
          "--file",
          ".gitmodules",
          "submodule." + key + ".url"
        ], {
          ...(options?.env ? { env: options.env } : {}),
          ...(options?.signal ? { signal: options.signal } : {})
        });
        const commitResult = await this.execGit(["-C", localPath, "rev-parse", "HEAD"], {
          ...(options?.env ? { env: options.env } : {}),
          ...(options?.signal ? { signal: options.signal } : {})
        });
        submodules.push({
          name: key,
          path: modulePath,
          url: urlResult.stdout.trim(),
          commit: commitResult.stdout.trim(),
          initialized: true
        });
      }
      return submodules;
    } catch (error) {
      this.logger.warn("remoteRepo.submodules.parseFailed", { message: (error as Error).message });
      return [];
    }
  }

  private async execGit(
    args: string[],
    options?: { env?: NodeJS.ProcessEnv; secretsToRedact?: string[]; signal?: AbortSignal }
  ): Promise<{ stdout: string; stderr: string }> {
    try {
      const spawnOptions: { env?: NodeJS.ProcessEnv; secretsToRedact?: string[]; signal?: AbortSignal } = {};
      if (options?.env) {
        spawnOptions.env = options.env;
      }
      if (options?.secretsToRedact && options.secretsToRedact.length > 0) {
        spawnOptions.secretsToRedact = options.secretsToRedact;
      }
      if (options?.signal) {
        spawnOptions.signal = options.signal;
      }
      if (Object.keys(spawnOptions).length === 0) {
        return await spawnGitPromise(args);
      }
      return await spawnGitPromise(args, spawnOptions);
    } catch (error) {
      if (isGitNotAvailable(error)) {
        throw new GitNotAvailableError("git executable not available in PATH");
      }
      throw error;
    }
  }
}

/**
 * Retry configuration for git operations.
 */
export interface RetryConfig {
  maxAttempts: number;
  baseDelay: number;
  maxDelay: number;
  backoffMultiplier: number;
  retryableErrors: string[];
}

/**
 * Helper that retries git operations on transient failures.
 */
export class RetryableGitOperation {
  constructor(
    private readonly retryConfig: RetryConfig,
    private readonly logger: Logger,
    private readonly delayFn: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  ) {}

  async executeWithRetry<T>(operation: () => Promise<T>, context: string): Promise<T> {
    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= this.retryConfig.maxAttempts; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error as Error;
        if (!this.isRetryableError(lastError) || attempt === this.retryConfig.maxAttempts) {
          throw lastError;
        }
        const delay = this.calculateDelay(attempt);
        this.logger.warn("remoteRepo.retry", {
          context,
          attempt,
          delay,
          message: lastError.message
        });
        await this.delayFn(delay);
      }
    }
    throw lastError ?? new Error("Operation failed without error");
  }

  private isRetryableError(error: Error): boolean {
    const message = error.message.toLowerCase();
    return this.retryConfig.retryableErrors.some((pattern) => message.includes(pattern.toLowerCase()));
  }

  private calculateDelay(attempt: number): number {
    const delay = this.retryConfig.baseDelay * Math.pow(this.retryConfig.backoffMultiplier, attempt - 1);
    return Math.min(delay, this.retryConfig.maxDelay);
  }
}

/**
 * Repository validation utilities.
 */
export class RepositoryValidator {
  constructor(private readonly logger: Logger) {}

  async validateRepository(url: string): Promise<RepositoryValidation> {
    const validation: RepositoryValidation = {
      isValid: false,
      exists: false,
      isAccessible: false,
      availableRefs: [],
      requiresAuthentication: false,
      errors: [],
      warnings: []
    } satisfies RepositoryValidation;

    const sanitizedUrl = sanitizeUrl(url);

    try {
      await this.testRepositoryAccess(url);
      validation.exists = true;
      validation.isAccessible = true;
      const info = await this.getRepositoryInfo(url);
      validation.availableRefs = info.refs;
      if (typeof info.size === "number") {
        validation.size = info.size;
      }
      if (info.defaultBranch) {
        validation.defaultBranch = info.defaultBranch;
      }
      validation.isValid = true;
    } catch (error) {
      const message = (error as Error).message;
      this.logger.warn("remoteRepo.validate.failed", { url: sanitizedUrl, message });
      if (message.toLowerCase().includes("authentication")) {
        validation.requiresAuthentication = true;
        validation.errors.push("Repository requires authentication");
      } else if (message.toLowerCase().includes("not found")) {
        validation.errors.push("Repository does not exist or is not accessible");
      } else {
        validation.errors.push(`Validation failed: ${message}`);
      }
    }

    return validation;
  }

  private async testRepositoryAccess(url: string): Promise<void> {
    await spawnGitPromise(["ls-remote", url, "HEAD"], { secretsToRedact: [url] });
  }

  private async getRepositoryInfo(url: string): Promise<{ size?: number; defaultBranch?: string; refs: string[] }> {
    const { stdout } = await spawnGitPromise(["ls-remote", url], { secretsToRedact: [url] });
    const refs: string[] = [];
    let defaultBranch: string | undefined;
    for (const line of stdout.split(/\r?\n/)) {
      const [sha, ref] = line.trim().split(/\s+/);
      if (!sha || !ref) {
        continue;
      }
      refs.push(ref);
      if (ref === "HEAD") {
        defaultBranch = sha;
      }
    }
    const result: { size?: number; defaultBranch?: string; refs: string[] } = { refs };
    if (defaultBranch) {
      result.defaultBranch = defaultBranch;
    }
    return result;
  }
}

/**
 * Keeps track of temporary directories used during cloning.
 */
export class TemporaryDirectoryManager {
  private readonly activeDirs = new Set<string>();
  private readonly cleanupHandlers = new Map<string, () => Promise<void>>();
  private processCleanupRegistered = false;
  private sigintCleanupInFlight = false;
  private cleanupPromise: Promise<void> | null = null;
  private cleanupCompleted = false;

  constructor(private readonly logger?: Logger, private readonly errorReporter?: ErrorReporter) {}

  async createTempDir(prefix = "code-ingest-"): Promise<string> {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    this.activeDirs.add(tmpDir);
    this.cleanupHandlers.set(tmpDir, async () => {
      await fs.rm(tmpDir, { recursive: true, force: true });
    });
    return tmpDir;
  }

  async cleanup(dirPath: string, force = false): Promise<void> {
    if (!this.activeDirs.has(dirPath) && !force) {
      return;
    }

    const handler = this.cleanupHandlers.get(dirPath);
    if (handler) {
      try {
        await handler();
        this.cleanupHandlers.delete(dirPath);
        this.activeDirs.delete(dirPath);
        return;
      } catch (error) {
        throw this.createCleanupError(error, { path: dirPath, force, phase: "handler" });
      }
    }

    if (force) {
      try {
        await fs.rm(dirPath, { recursive: true, force: true });
        this.cleanupHandlers.delete(dirPath);
        this.activeDirs.delete(dirPath);
        return;
      } catch (error) {
        throw this.createCleanupError(error, { path: dirPath, force, phase: "force" });
      }
    }

    this.cleanupHandlers.delete(dirPath);
    this.activeDirs.delete(dirPath);
  }

  async cleanupAll(): Promise<void> {
    const operations = Array.from(this.activeDirs).map((dir) => this.cleanup(dir, true));
    await Promise.allSettled(operations);
  }

  setupProcessCleanup(options: { beforeCleanup?: () => Promise<void> } = {}): void {
    if (this.processCleanupRegistered) {
      return;
    }
    this.processCleanupRegistered = true;

    const performCleanup = async (signal?: NodeJS.Signals): Promise<void> => {
      if (this.cleanupPromise) {
        await this.cleanupPromise;
        return;
      }

      this.cleanupPromise = (async () => {
        if (this.sigintCleanupInFlight) {
          return;
        }
        this.sigintCleanupInFlight = true;
        try {
          if (typeof options.beforeCleanup === "function") {
            try {
              await options.beforeCleanup();
            } catch {
              // Ignore errors triggered by cooperative cleanup hooks.
            }
          }
          await this.cleanupAll();
          this.cleanupCompleted = true;
        } finally {
          this.sigintCleanupInFlight = false;
          if (signal === "SIGINT" && typeof process.exitCode !== "number") {
            process.exitCode = 130;
          }
          this.cleanupPromise = null;
        }
      })();

      await this.cleanupPromise;
    };

    process.once("beforeExit", () => {
      void performCleanup();
    });

    process.once("SIGINT", () => {
      void performCleanup("SIGINT");
    });

    process.once("exit", () => {
      if (!this.cleanupCompleted) {
        this.cleanupAllSync();
      }
    });
  }

  private cleanupAllSync(): void {
    for (const dir of this.activeDirs) {
      try {
        void fs
          .rm(dir, { recursive: true, force: true })
          .catch((error) => {
            this.createCleanupError(error, { path: dir, force: true, phase: "sync" });
          });
      } catch (error) {
        this.createCleanupError(error, { path: dir, force: true, phase: "sync" });
      }
    }
    this.activeDirs.clear();
    this.cleanupHandlers.clear();
  }

  private createCleanupError(
    error: unknown,
    context: { path: string; force: boolean; phase: "handler" | "force" | "sync" }
  ): Error {
    const metadata = {
      path: context.path,
      force: context.force,
      phase: context.phase
    } as const;
    const wrapped = wrapError(error, {
      scope: `remoteRepo.tempDir.cleanup.${context.phase}`,
      ...metadata
    });
    this.logger?.warn("remoteRepo.tempDir.cleanup_failed", {
      ...metadata,
      message: wrapped.message
    });
    this.errorReporter?.report(wrapped, {
      source: `remoteRepo.tempDir.cleanup.${context.phase}`,
      metadata: { ...metadata }
    });
    return wrapped;
  }
}

/**
 * Tracks progress callbacks and cancellation requests.
 */
export class ProgressTracker {
  constructor(private readonly callback?: (progress: CloneProgress) => void, private readonly cancellationToken?: vscode.CancellationToken) {}

  reportProgress(phase: CloneProgress["phase"], percent: number, message: string, currentFile?: string): void {
    this.checkCancellation();
    if (!this.callback) {
      return;
    }
    try {
      this.callback({ phase, percent, message, ...(currentFile ? { currentFile } : {}) });
    } catch {
      // Ignore listener failures.
    }
  }

  checkCancellation(): void {
    if (this.cancellationToken?.isCancellationRequested) {
      throw wrapError(new Error("Operation was cancelled"), { scope: "remoteRepo.progress" });
    }
  }
}

function sanitizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = parsed.username ? "***" : "";
    parsed.password = parsed.password ? "***" : "";
    return parsed.toString();
  } catch {
    return url.replace(/:[^@]+@/, ":***@");
  }
}

function isGitNotAvailable(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return message.includes("not found") || message.includes("command not recognized");
}

async function createAskPassScript(scriptPath: string, token: string): Promise<void> {
  const content = process.platform === "win32"
    ? `@echo off\necho %1| findstr /b "Username" >nul\nif %errorlevel% == 0 (echo.) else (echo ${token})\n`
    : `#!/bin/sh\nif [ "$1" = "Username for 'https://" ]; then\n  echo\nelse\n  echo "${token}"\nfi\n`;
  await fs.writeFile(scriptPath, content, { mode: 0o700 });
}
