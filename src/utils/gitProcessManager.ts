import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { once } from "node:events";
import * as path from "node:path";
import type * as vscode from "vscode";

import { wrapError } from "./errorHandling";
import type { ErrorReporter } from "../services/errorReporter";

export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

export interface GitCommandOptions {
  cwd: string;
  timeout?: number;
  env?: Record<string, string>;
  maxBuffer?: number;
  retries?: number;
  logCommand?: boolean;
  expectLargeOutput?: boolean;
  progressCallback?: (output: string) => void;
  cancellationToken?: vscode.CancellationToken;
}

export interface GitCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  command: string;
  duration: number;
  retryCount: number;
}

export interface GitProcessMetrics {
  totalCommands: number;
  failedCommands: number;
  averageDuration: number;
  commandFrequency: Map<string, number>;
  errorTypes: Map<string, number>;
}

const DEFAULT_TIMEOUT = 120_000;
const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024; // 10 MB
const RETRY_DELAY_BASE = 500;
const STREAM_YIELD_FREQUENCY_MS = 5;

export enum GitErrorType {
  AUTHENTICATION = "authentication",
  NETWORK = "network",
  NOT_FOUND = "not_found",
  PERMISSION = "permission",
  DISK_SPACE = "disk_space",
  TIMEOUT = "timeout",
  CANCELLED = "cancelled",
  UNKNOWN = "unknown"
}

class CredentialScrubber {
  private sensitivePatterns: RegExp[] = [
    /https:\/\/[^@]+@/g,
    /ssh:\/\/[^@]+@/g,
    /password[=:]\s*[^\s]+/gi,
    /token[=:]\s*[^\s]+/gi,
    /key[=:]\s*[^\s]+/gi,
    /ghp_[a-zA-Z0-9]{36}/g,
    /-----BEGIN [A-Z\s]+ PRIVATE KEY-----[\s\S]*?-----END [A-Z\s]+ PRIVATE KEY-----/g
  ];

  scrubCommand(args: string[]): string[] {
    return args.map((arg) => this.scrubSensitiveInfo(arg));
  }

  scrubOutput(output: string): string {
    let scrubbed = output;
    for (const pattern of this.sensitivePatterns) {
      scrubbed = scrubbed.replace(pattern, "[REDACTED]");
    }
    return scrubbed;
  }

  scrubError(error: Error): Error {
    const scrubbedError = new Error(this.scrubSensitiveInfo(error.message));
    scrubbedError.name = error.name;
    if (error.stack) {
      scrubbedError.stack = this.scrubSensitiveInfo(error.stack);
    }
    return scrubbedError;
  }

  addCustomPattern(pattern: RegExp): void {
    this.sensitivePatterns.push(pattern);
  }

  private scrubSensitiveInfo(text: string): string {
    let result = text;
    for (const pattern of this.sensitivePatterns) {
      result = result.replace(pattern, "[REDACTED]");
    }
    return result;
  }
}

class GitCommandValidator {
  private readonly allowedCommands = new Set([
    "clone",
    "fetch",
    "checkout",
    "rev-parse",
    "ls-remote",
    "config",
    "sparse-checkout",
    "submodule",
    "remote",
    "branch",
    "status",
    "log",
    "show",
    "diff"
  ]);

  private readonly dangerousOptions = new Set([
    "--exec",
    "--upload-pack",
    "--receive-pack",
    "--separate-git-dir"
  ]);

  validateCommand(args: string[], cwd: string): void {
    if (args.length === 0) {
      throw new Error("Empty git command");
    }

    const command = args[0];
    if (!this.allowedCommands.has(command)) {
      throw new Error(`Git command '${command}' is not allowed`);
    }

    const dangerousOption = args.find((arg) => {
      if (!arg.startsWith("--")) {
        return false;
      }
      const [option] = arg.split("=");
      return this.dangerousOptions.has(option);
    });

    if (dangerousOption) {
      throw new Error(`Git option '${dangerousOption}' is not allowed for security reasons`);
    }

    for (const arg of args) {
      if (!arg.includes("..")) {
        continue;
      }
      if (/^[a-z]+:\/\//i.test(arg)) {
        continue;
      }
      const resolved = path.resolve(cwd, arg);
      const normalisedCwd = path.resolve(cwd);
      if (!resolved.startsWith(normalisedCwd)) {
        throw new Error(`Path '${arg}' attempts to escape working directory`);
      }
    }
  }
}

class GitErrorClassifier {
  private readonly errorPatterns = new Map<GitErrorType, RegExp[]>([
    [
      GitErrorType.AUTHENTICATION,
      [/authentication failed/i, /permission denied/i, /invalid username or password/i, /bad credentials/i]
    ],
    [
      GitErrorType.NETWORK,
      [
        /connection timed out/i,
        /network is unreachable/i,
        /temporary failure in name resolution/i,
        /could not resolve host/i
      ]
    ],
    [GitErrorType.NOT_FOUND, [/repository not found/i, /remote repository does not exist/i, /404/]],
    [GitErrorType.PERMISSION, [/permission denied/i, /access denied/i, /forbidden/i]],
    [GitErrorType.DISK_SPACE, [/no space left on device/i, /disk full/i, /insufficient disk space/i]]
  ]);

  classifyError(error: Error): GitErrorType {
    const message = error.message.toLowerCase();

    for (const [type, patterns] of this.errorPatterns.entries()) {
      if (patterns.some((pattern) => pattern.test(message))) {
        return type;
      }
    }

    if (message.includes("timeout")) {
      return GitErrorType.TIMEOUT;
    }

    if (message.includes("cancel")) {
      return GitErrorType.CANCELLED;
    }

    return GitErrorType.UNKNOWN;
  }

  isRetryableError(errorType: GitErrorType): boolean {
    return [GitErrorType.NETWORK, GitErrorType.TIMEOUT, GitErrorType.UNKNOWN].includes(errorType);
  }

  getErrorMessage(errorType: GitErrorType): string {
    const messages: Record<GitErrorType, string> = {
      [GitErrorType.AUTHENTICATION]: "Authentication failed. Please check your credentials.",
      [GitErrorType.NETWORK]: "Network error occurred. Please check your connection.",
      [GitErrorType.NOT_FOUND]: "Repository not found or not accessible.",
      [GitErrorType.PERMISSION]: "Permission denied. Check repository access rights.",
      [GitErrorType.DISK_SPACE]: "Insufficient disk space for the operation.",
      [GitErrorType.TIMEOUT]: "Operation timed out. Try increasing the timeout or check your connection.",
      [GitErrorType.CANCELLED]: "Operation was cancelled.",
      [GitErrorType.UNKNOWN]: "An unexpected error occurred."
    };

    return messages[errorType] ?? messages[GitErrorType.UNKNOWN];
  }
}

class GitPerformanceMonitor {
  private readonly commandMetrics = new Map<
    string,
    { count: number; totalDuration: number; failures: number; lastExecuted: Date }
  >();

  recordExecution(command: string, duration: number, failed: boolean): void {
    const entry = this.commandMetrics.get(command) ?? {
      count: 0,
      totalDuration: 0,
      failures: 0,
      lastExecuted: new Date()
    };

    entry.count += 1;
    entry.totalDuration += duration;
    entry.lastExecuted = new Date();

    if (failed) {
      entry.failures += 1;
    }

    this.commandMetrics.set(command, entry);
  }

  getMetrics(): GitProcessMetrics {
    const totals = Array.from(this.commandMetrics.values());
    const totalCommands = totals.reduce((sum, metric) => sum + metric.count, 0);
    const failedCommands = totals.reduce((sum, metric) => sum + metric.failures, 0);
    const totalDuration = totals.reduce((sum, metric) => sum + metric.totalDuration, 0);
    const averageDuration = totalCommands > 0 ? totalDuration / totalCommands : 0;

    const commandFrequency = new Map<string, number>(
      Array.from(this.commandMetrics.entries()).map(([command, metric]) => [command, metric.count])
    );

    return {
      totalCommands,
      failedCommands,
      averageDuration,
      commandFrequency,
      errorTypes: new Map()
    };
  }
}

interface ProcessControllerOptions {
  progressCallback?: (output: string) => void;
  cancellationToken?: vscode.CancellationToken;
  maxBuffer?: number;
  expectLargeOutput?: boolean;
  logger: Logger;
}

class ProcessController {
  constructor(
    private readonly process: ChildProcess,
    private readonly timeout: number,
    private readonly scrubber: CredentialScrubber,
    private readonly options: ProcessControllerOptions
  ) {}

  async executeWithTimeout(commandLabel: string, retryCount: number): Promise<GitCommandResult> {
    const startedAt = Date.now();
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const maxBuffer = this.resolveMaxBuffer();

    return new Promise<GitCommandResult>((resolve, reject) => {
      let finished = false;
      let stdoutBytes = 0;
      let stderrBytes = 0;

      const timeoutId = this.timeout > 0 ? setTimeout(() => this.handleTimeout(reject), this.timeout) : null;

      const cancellationListener = this.options.cancellationToken?.onCancellationRequested(() => {
        if (!finished) {
          finished = true;
          this.killProcess("SIGTERM");
          if (timeoutId) {
            clearTimeout(timeoutId);
          }
          reject(new Error("Git command was cancelled"));
        }
      });

      const collectChunk = (collection: string[], chunk: unknown, tracker: "stdout" | "stderr") => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
        const size = buffer.length;
        if (tracker === "stdout") {
          stdoutBytes += size;
        } else {
          stderrBytes += size;
        }
        if (stdoutBytes + stderrBytes > maxBuffer) {
          finished = true;
          if (timeoutId) {
            clearTimeout(timeoutId);
          }
          cancellationListener?.dispose();
          this.killProcess("SIGTERM");
          reject(new Error("Git command output exceeded configured buffer limit"));
          return;
        }
        const text = buffer.toString("utf8");
        const scrubbed = this.scrubber.scrubOutput(text);
        collection.push(scrubbed);
        try {
          this.options.progressCallback?.(scrubbed);
        } catch {
          // ignore consumer progress errors
        }
      };

      this.process.stdout?.on("data", (chunk) => collectChunk(stdoutChunks, chunk, "stdout"));
      this.process.stderr?.on("data", (chunk) => collectChunk(stderrChunks, chunk, "stderr"));

      this.process.on("error", (error) => {
        if (finished) {
          return;
        }
        finished = true;
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        cancellationListener?.dispose();
        reject(this.scrubber.scrubError(error as Error));
      });

      this.process.on("close", (code, signal) => {
        if (finished) {
          return;
        }
        finished = true;
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        cancellationListener?.dispose();

        if (signal) {
          reject(new Error(`Git command terminated with signal ${signal}`));
          return;
        }

        const stdout = stdoutChunks.join("");
        const stderr = stderrChunks.join("");

        if (code === 0) {
          resolve({
            stdout,
            stderr,
            exitCode: 0,
            command: commandLabel,
            duration: Date.now() - startedAt,
            retryCount
          });
          return;
        }

        const message = stderr || stdout || `Git command failed with exit code ${code ?? -1}`;
        reject(new Error(this.scrubber.scrubOutput(message)));
      });
    });
  }

  private resolveMaxBuffer(): number {
    const base = this.options.maxBuffer ?? DEFAULT_MAX_BUFFER;
    if (this.options.expectLargeOutput) {
      return base * 4;
    }
    return base;
  }

  private handleTimeout(reject: (reason?: unknown) => void): void {
    this.options.logger.warn("git.process.timeout", {});
    this.killProcess("SIGTERM");
    setTimeout(() => {
      this.killProcess("SIGKILL");
    }, 5_000).unref?.();
    reject(new Error(`Git command timed out after ${this.timeout}ms`));
  }

  private killProcess(signal: NodeJS.Signals): void {
    try {
      if (this.process.pid && !this.process.killed) {
        process.kill(this.process.pid, signal);
      }
    } catch (error) {
      const err = error as Error;
      this.options.logger.warn("git.process.kill_failed", { message: err.message });
    }
  }
}

export class GitProcessManager {
  private static readonly instances = new Set<GitProcessManager>();
  private static cleanupRegistered = false;

  private readonly activeProcesses = new Map<string, ChildProcess>();
  private readonly credentialScrubber = new CredentialScrubber();
  private readonly validator = new GitCommandValidator();
  private readonly errorClassifier = new GitErrorClassifier();
  private readonly performanceMonitor = new GitPerformanceMonitor();
  private readonly errorTypeCounts = new Map<string, number>();
  private metrics: GitProcessMetrics;
  private processCounter = 0;

  constructor(private readonly logger: Logger, private readonly errorReporter: ErrorReporter) {
    this.metrics = {
      totalCommands: 0,
      failedCommands: 0,
      averageDuration: 0,
      commandFrequency: new Map(),
      errorTypes: new Map()
    } satisfies GitProcessMetrics;
    GitProcessManager.instances.add(this);
    this.setupProcessCleanup();
  }

  async executeGitCommand(args: string[], options: GitCommandOptions): Promise<GitCommandResult> {
    const processId = this.generateProcessId();
    const startTime = Date.now();
    this.validator.validateCommand(args, options.cwd);
    const scrubbedCommand = this.buildCommandLabel(args);
    if (options.logCommand) {
      this.logger.info("git.process.start", { command: scrubbedCommand, cwd: options.cwd });
    } else {
      this.logger.debug("git.process.start", { command: scrubbedCommand, cwd: options.cwd });
    }

    try {
      const result = await this.executeWithRetry(args, options, processId);
      const duration = Date.now() - startTime;
      this.updateMetrics(args, duration, false);
      this.logger.debug("git.process.success", { command: scrubbedCommand, duration, exitCode: result.exitCode });
      return {
        ...result,
        command: scrubbedCommand,
        duration
      } satisfies GitCommandResult;
    } catch (error) {
      const duration = Date.now() - startTime;
      const classified = error instanceof Error ? error : new Error(String(error));
      const scrubbed = this.credentialScrubber.scrubError(classified);
      const errorType = this.errorClassifier.classifyError(scrubbed);
      this.updateMetrics(args, duration, true, errorType);
      const enhanced = this.enhanceError(scrubbed, args, options, errorType);
      this.logger.error("git.process.failure", {
        command: scrubbedCommand,
        duration,
        errorType,
        message: enhanced.message
      });
      this.errorReporter.report(enhanced, {
        source: "gitProcessManager",
        metadata: { command: scrubbedCommand, cwd: options.cwd, errorType }
      });
      throw enhanced;
    } finally {
      this.activeProcesses.delete(processId);
    }
  }

  async *executeGitCommandStream(
    args: string[],
    options: GitCommandOptions
  ): AsyncIterable<string> {
    const processId = this.generateProcessId();
    const startTime = Date.now();
    this.validator.validateCommand(args, options.cwd);

    const child = this.spawnGitProcess(args, options);
    this.activeProcesses.set(processId, child);

    const scrubbedCommand = this.buildCommandLabel(args);
    if (options.logCommand) {
      this.logger.info("git.process.stream.start", { command: scrubbedCommand, cwd: options.cwd });
    } else {
      this.logger.debug("git.process.stream.start", { command: scrubbedCommand, cwd: options.cwd });
    }

    const timeout = options.timeout ?? DEFAULT_TIMEOUT;
    const stderrChunks: string[] = [];
    const cancellationToken = options.cancellationToken;
    let timeoutId: NodeJS.Timeout | null = null;
    let finished = false;

    const cleanup = () => {
      finished = true;
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      cancellationListener?.dispose();
      this.activeProcesses.delete(processId);
    };

    const onTimeout = () => {
      if (finished) {
        return;
      }
      this.logger.warn("git.process.stream.timeout", { command: scrubbedCommand, timeout });
      this.safeKill(child, "SIGTERM");
      setTimeout(() => this.safeKill(child, "SIGKILL"), 5_000).unref?.();
    };

    if (timeout > 0) {
      timeoutId = setTimeout(onTimeout, timeout);
    }

    const cancellationListener = cancellationToken?.onCancellationRequested(() => {
      if (finished) {
        return;
      }
      this.logger.warn("git.process.stream.cancelled", { command: scrubbedCommand });
      this.safeKill(child, "SIGTERM");
    });

    child.stderr?.on("data", (chunk) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      const scrubbed = this.credentialScrubber.scrubOutput(text);
      stderrChunks.push(scrubbed);
      try {
        options.progressCallback?.(scrubbed);
      } catch {
        // ignore consumer errors
      }
    });

    let emittedError: Error | undefined;
    child.on("error", (error) => {
      emittedError = this.credentialScrubber.scrubError(error as Error);
    });

    try {
      const stdout = child.stdout;
      if (!stdout) {
        throw new Error("Git process has no stdout stream");
      }

      for await (const chunk of stdout) {
        const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
        const scrubbedChunk = this.credentialScrubber.scrubOutput(text);
        try {
          options.progressCallback?.(scrubbedChunk);
        } catch {
          // ignore consumer errors
        }
        yield scrubbedChunk;
        await this.delay(STREAM_YIELD_FREQUENCY_MS);
      }

      const [code, signal] = (await once(child, "close")) as [number | null, NodeJS.Signals | null];
      cleanup();

      if (signal) {
        throw new Error(`Git command terminated with signal ${signal}`);
      }

      if ((code ?? 0) !== 0) {
        const message = stderrChunks.join("") || `Git command failed with exit code ${code ?? -1}`;
        throw new Error(message);
      }

      const duration = Date.now() - startTime;
      this.updateMetrics(args, duration, false);
      this.logger.debug("git.process.stream.success", { command: scrubbedCommand, duration });
    } catch (error) {
      cleanup();
      const duration = Date.now() - startTime;
      const baseError = emittedError ?? (error instanceof Error ? error : new Error(String(error)));
      const scrubbed = this.credentialScrubber.scrubError(baseError);
      const errorType = this.errorClassifier.classifyError(scrubbed);
      this.updateMetrics(args, duration, true, errorType);
      const enhanced = this.enhanceError(scrubbed, args, options, errorType);
      this.logger.error("git.process.stream.failure", {
        command: scrubbedCommand,
        duration,
        errorType,
        message: enhanced.message
      });
      this.errorReporter.report(enhanced, {
        source: "gitProcessManager.stream",
        metadata: { command: scrubbedCommand, cwd: options.cwd, errorType }
      });
      throw enhanced;
    }
  }

  getMetrics(): GitProcessMetrics {
    return {
      ...this.metrics,
      commandFrequency: new Map(this.metrics.commandFrequency),
      errorTypes: new Map(this.metrics.errorTypes)
    };
  }

  addCredentialPattern(pattern: RegExp): void {
    this.credentialScrubber.addCustomPattern(pattern);
  }

  private async executeWithRetry(
    args: string[],
    options: GitCommandOptions,
    processId: string
  ): Promise<GitCommandResult> {
    const retries = Math.max(1, options.retries ?? 1);
    let attempt = 0;
    let lastError: Error | undefined;

    while (attempt < retries) {
      attempt += 1;
      const child = this.spawnGitProcess(args, options);
      this.activeProcesses.set(processId, child);

      try {
        const controllerOptions: ProcessControllerOptions = {
          logger: this.logger
        };

        if (options.cancellationToken) {
          controllerOptions.cancellationToken = options.cancellationToken;
        }
        if (options.progressCallback) {
          controllerOptions.progressCallback = options.progressCallback;
        }
        if (typeof options.maxBuffer === "number") {
          controllerOptions.maxBuffer = options.maxBuffer;
        }
        if (typeof options.expectLargeOutput === "boolean") {
          controllerOptions.expectLargeOutput = options.expectLargeOutput;
        }

        const controller = new ProcessController(
          child,
          options.timeout ?? DEFAULT_TIMEOUT,
          this.credentialScrubber,
          controllerOptions
        );

        const commandLabel = this.buildCommandLabel(args);
        const result = await controller.executeWithTimeout(commandLabel, attempt - 1);
        return result;
      } catch (error) {
        const classified = error instanceof Error ? error : new Error(String(error));
        const scrubbed = this.credentialScrubber.scrubError(classified);
        const errorType = this.errorClassifier.classifyError(scrubbed);
        lastError = scrubbed;
        this.logger.warn("git.process.retry", {
          command: this.buildCommandLabel(args),
          attempt,
          retries,
          errorType,
          message: scrubbed.message
        });
        if (!this.errorClassifier.isRetryableError(errorType) || attempt >= retries) {
          throw scrubbed;
        }
        await this.delay(this.getRetryDelay(attempt));
      } finally {
        this.activeProcesses.delete(processId);
      }
    }

    throw lastError ?? new Error("Git command failed without providing an error");
  }

  private spawnGitProcess(args: string[], options: GitCommandOptions): ChildProcess {
    try {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        ...(options.env ?? {})
      };

      const spawnOptions: SpawnOptions = {
        cwd: options.cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        windowsHide: true
      };

      return spawn("git", args, spawnOptions);
    } catch (error) {
      throw this.credentialScrubber.scrubError(error as Error);
    }
  }

  private updateMetrics(args: string[], duration: number, failed: boolean, errorType?: GitErrorType): void {
    const command = args[0] ?? "unknown";
    this.performanceMonitor.recordExecution(command, duration, failed);

    if (failed && errorType) {
      const previous = this.errorTypeCounts.get(errorType) ?? 0;
      this.errorTypeCounts.set(errorType, previous + 1);
    }

    const snapshot = this.performanceMonitor.getMetrics();
    this.metrics = {
      ...snapshot,
      errorTypes: new Map(this.errorTypeCounts)
    };
  }

  private enhanceError(
    error: Error,
    args: string[],
    options: GitCommandOptions,
    errorType?: GitErrorType
  ): Error {
    const command = this.buildCommandLabel(args);
    const metadata: Record<string, unknown> = {
      scope: "gitProcessManager",
      command,
      cwd: options.cwd
    };

    if (errorType) {
      metadata.errorType = errorType;
      metadata.errorDescription = this.errorClassifier.getErrorMessage(errorType);
    }

    const annotated = wrapError(error, metadata);
    return annotated;
  }

  private buildCommandLabel(args: string[]): string {
    const scrubbed = this.credentialScrubber.scrubCommand(["git", ...args]);
    return scrubbed.join(" ");
  }

  private generateProcessId(): string {
    this.processCounter += 1;
    return `${Date.now()}-${this.processCounter}`;
  }

  private getRetryDelay(attempt: number): number {
    return RETRY_DELAY_BASE * Math.pow(2, attempt - 1);
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private setupProcessCleanup(): void {
    if (!GitProcessManager.cleanupRegistered) {
      GitProcessManager.cleanupRegistered = true;
      const cleanup = () => GitProcessManager.cleanupAll();
      process.on("exit", cleanup);
      process.on("SIGINT", () => {
        cleanup();
        process.exit(130);
      });
    }
  }

  private safeKill(child: ChildProcess, signal: NodeJS.Signals): void {
    try {
      if (child.pid && !child.killed) {
        process.kill(child.pid, signal);
      }
    } catch (error) {
      const err = error as Error;
      this.logger.warn("git.process.kill_failed", { message: err.message, signal });
    }
  }

  private static cleanupAll(): void {
    for (const instance of GitProcessManager.instances) {
      instance.killAllActiveProcesses();
    }
  }

  private killAllActiveProcesses(): void {
    for (const [, child] of this.activeProcesses.entries()) {
      this.safeKill(child, "SIGTERM");
    }
    this.activeProcesses.clear();
  }
}
