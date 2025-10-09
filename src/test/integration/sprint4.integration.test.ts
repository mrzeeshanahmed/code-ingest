import { afterAll, afterEach, beforeAll, describe, expect, it, jest } from "@jest/globals";

jest.mock("../../utils/procRedact", () => ({
  spawnGitPromise: jest.fn()
}));

jest.mock("node:child_process", () => ({
  spawn: jest.fn()
}));

import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";

import { spawn } from "node:child_process";
import * as vscode from "vscode";
import { spawnGitPromise } from "../../utils/procRedact";
import { ConfigurationService } from "../../services/configurationService";
import { DEFAULT_CONFIG } from "../../config/constants";
import { ErrorReporter, type ErrorReport } from "../../services/errorReporter";
import { ErrorCategory } from "../../utils/errorHandler";
import { GitProcessManager, type GitCommandOptions, type Logger as GitLogger } from "../../utils/gitProcessManager";
import { PerformanceMonitor } from "../../services/performanceMonitor";
import {
  RemoteRepoService,
  TemporaryDirectoryManager,
  type AuthenticationInfo,
  type CloneProgress,
  type RepositoryValidation,
  GitAuthenticator,
  AdvancedGitOperations,
  RepositoryValidator,
  RetryableGitOperation,
  type RetryConfig
} from "../../services/remoteRepoService";
import { RepositoryAnalyzer } from "../../services/repositoryAnalyzer";
import { ContentProcessor } from "../../services/contentProcessor";
import { FileScanner } from "../../services/fileScanner";
import type { Logger } from "../../utils/gitProcessManager";
import type { DigestConfig, Diagnostics } from "../../utils/validateConfig";
import { configureWorkspaceEnvironment, resetWorkspaceEnvironment } from "../support/workspaceEnvironment";

const spawnMock = jest.mocked(spawn);
const mockedSpawnGitPromise = spawnGitPromise as jest.MockedFunction<typeof spawnGitPromise>;

// Helper logger implementation capturing structured logs for assertions.
class TestLogger implements Logger {
  private entries: Array<{ level: string; message: string; context?: Record<string, unknown> }> = [];

  debug(message: string, context?: Record<string, unknown>): void {
    this.entries.push({ level: "debug", message, ...(context ? { context } : {}) });
  }

  info(message: string, context?: Record<string, unknown>): void {
    this.entries.push({ level: "info", message, ...(context ? { context } : {}) });
  }

  warn(message: string, context?: Record<string, unknown>): void {
    this.entries.push({ level: "warn", message, ...(context ? { context } : {}) });
  }

  error(message: string, context?: Record<string, unknown>): void {
    this.entries.push({ level: "error", message, ...(context ? { context } : {}) });
  }

  getEntries(): Array<{ level: string; message: string; context?: Record<string, unknown> }> {
    return [...this.entries];
  }

  clear(): void {
    this.entries = [];
  }
}

interface MockCloneRecord {
  readonly url: string;
  readonly localPath: string;
  readonly partial: boolean;
  readonly sparsePatterns: string[];
}

interface MockRepoDefinition {
  readonly name: string;
  readonly url: string;
  readonly rootPath: string;
  readonly requiresAuth: boolean;
  readonly defaultBranch: string;
  readonly branches: string[];
  readonly tags: string[];
  readonly lastCommit: {
    sha: string;
    message: string;
    author: string;
    date: Date;
  };
  readonly firstCommitSha: string;
  readonly firstCommitDate: Date;
  readonly contributors: Array<{ name: string; commits: number }>;
  readonly sizePack: number;
  readonly licensePath?: string;
  readonly statistics: {
    totalFiles: number;
    cloneSize: number;
  };
}

class MockGitHubService {
  private readonly repos = new Map<string, MockRepoDefinition>();
  private readonly repoByPath = new Map<string, MockRepoDefinition>();
  private readonly cloneRecords: MockCloneRecord[] = [];
  private readonly requestCounts = new Map<string, number>();
  private readonly failurePlans = new Map<string, number>();
  private credentials: { username: string; token: string } | null = null;
  private forceAuthFailure = false;

  constructor(private readonly workspace: string) {}

  async initialize(): Promise<void> {
    await this.registerDefaultRepositories();
  }

  async dispose(): Promise<void> {
    for (const repo of this.repos.values()) {
      await fs.rm(repo.rootPath, { recursive: true, force: true });
    }
    this.repos.clear();
    this.repoByPath.clear();
    this.cloneRecords.length = 0;
    this.requestCounts.clear();
    this.failurePlans.clear();
  }

  getTestRepoUrl(): string {
    return this.getUrlByName("test-repo");
  }

  getPrivateRepoUrl(): string {
    return this.getUrlByName("private-repo");
  }

  getLargeRepoUrl(): string {
    return this.getUrlByName("large-repo");
  }

  getVeryLargeRepoUrl(): string {
    return this.getUrlByName("very-large-repo");
  }

  getMultiLanguageRepoUrl(): string {
    return this.getUrlByName("multilang-repo");
  }

  getUnreliableRepoUrl(): string {
    return this.getUrlByName("unreliable-repo");
  }

  getSlowRepoUrl(): string {
    return this.getUrlByName("slow-repo");
  }

  setCredentials(username: string, token: string): void {
    this.credentials = { username, token };
    this.forceAuthFailure = false;
  }

  clearCredentials(): void {
    this.credentials = null;
  }

  configureFailures(url: string, count: number): void {
    this.failurePlans.set(url, Math.max(0, count));
  }

  simulateAuthenticationFailure(): void {
    this.forceAuthFailure = true;
  }

  getRequestCount(url?: string): number {
    if (url) {
      return this.requestCounts.get(url) ?? 0;
    }
    let total = 0;
    for (const value of this.requestCounts.values()) {
      total += value;
    }
    return total;
  }

  recordClone(record: MockCloneRecord): void {
    this.cloneRecords.push(record);
  }

  getCloneRecords(): MockCloneRecord[] {
    return [...this.cloneRecords];
  }

  requiresAuthentication(url: string): boolean {
    const repo = this.repos.get(url);
    return Boolean(repo?.requiresAuth);
  }

  hasValidCredentials(url: string): boolean {
    if (!this.credentials) {
      return false;
    }
    if (this.forceAuthFailure) {
      return false;
    }
    const repo = this.repos.get(url);
    return Boolean(repo && repo.requiresAuth);
  }

  getCredentialToken(): string | undefined {
    return this.credentials?.token;
  }

  requestClone(url: string, hasCredentials: boolean): MockRepoDefinition {
    const repo = this.repos.get(url);
    if (!repo) {
      throw new Error(`Unknown repository for URL ${url}`);
    }
    const currentCount = this.requestCounts.get(url) ?? 0;
    this.requestCounts.set(url, currentCount + 1);

    const failureBudget = this.failurePlans.get(url);
    if (failureBudget && failureBudget > 0) {
      this.failurePlans.set(url, failureBudget - 1);
      throw new Error("network: temporary failure in name resolution");
    }

    if (repo.requiresAuth && (!hasCredentials || !this.hasValidCredentials(url))) {
      throw new Error("authentication required for repository");
    }

    return repo;
  }

  registerLocalClone(localPath: string, repo: MockRepoDefinition): void {
    this.repoByPath.set(localPath, repo);
  }

  unregisterLocalClone(localPath: string): void {
    this.repoByPath.delete(localPath);
  }

  resolveByLocalPath(localPath: string): MockRepoDefinition | undefined {
    return this.repoByPath.get(localPath);
  }

  private getUrlByName(name: string): string {
    for (const repo of this.repos.values()) {
      if (repo.name === name) {
        return repo.url;
      }
    }
    throw new Error(`Repository named ${name} not registered`);
  }

  private async registerDefaultRepositories(): Promise<void> {
    await this.registerRepository("test-repo", {
      requiresAuth: false,
      files: [
        { relativePath: "README.md", content: "# Test Repo\nThis is a test repository." },
        {
          relativePath: "package.json",
          content: JSON.stringify({
            name: "test-repo",
            version: "1.0.0",
            dependencies: { express: "^4.0.0" }
          }, null, 2)
        },
        { relativePath: "src/index.js", content: "const express = require('express');\nmodule.exports = express();" },
        { relativePath: "test/app.test.js", content: "describe('app', () => it('works', () => expect(true).toBe(true)));" }
      ],
      defaultBranch: "main",
      branches: ["refs/heads/main", "refs/heads/feature/x"],
      tags: ["v1.0.0"],
      lastCommit: {
        sha: "1111111111111111111111111111111111111111",
        message: "chore: initial commit",
        author: "Tester",
        date: new Date("2024-01-01T00:00:00.000Z")
      },
      firstCommitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      firstCommitDate: new Date("2023-12-01T00:00:00.000Z"),
      contributors: [
        { name: "Tester", commits: 10 },
        { name: "Helper", commits: 5 }
      ],
      license: "MIT"
    });

    await this.registerRepository("private-repo", {
      requiresAuth: true,
      files: [
        { relativePath: "README.md", content: "# Private Repo" },
        { relativePath: "src/secret.ts", content: "export const token = 'secret';" }
      ],
      defaultBranch: "main",
      branches: ["refs/heads/main"],
      tags: [],
      lastCommit: {
        sha: "2222222222222222222222222222222222222222",
        message: "feat: private",
        author: "Owner",
        date: new Date("2024-02-01T00:00:00.000Z")
      },
      firstCommitSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      firstCommitDate: new Date("2024-01-15T00:00:00.000Z"),
      contributors: [{ name: "Owner", commits: 3 }]
    });

    await this.registerRepository("unreliable-repo", {
      requiresAuth: false,
      files: [
        { relativePath: "README.md", content: "# Flaky Repo" },
        { relativePath: "src/info.js", content: "module.exports = 'flaky';" }
      ],
      defaultBranch: "main",
      branches: ["refs/heads/main"],
      tags: [],
      lastCommit: {
        sha: "3333333333333333333333333333333333333333",
        message: "chore: stability",
        author: "Network",
        date: new Date("2024-03-01T00:00:00.000Z")
      },
      firstCommitSha: "cccccccccccccccccccccccccccccccccccccccc",
      firstCommitDate: new Date("2024-02-01T00:00:00.000Z"),
      contributors: [{ name: "Network", commits: 2 }]
    });

    await this.registerRepository("large-repo", {
      requiresAuth: false,
      files: [
        { relativePath: "docs/readme.md", content: "# Large Repo" },
        { relativePath: "src/app.ts", content: "export const app = () => 'large';" },
        { relativePath: "src/components/Button.tsx", content: "export const Button = () => null;" },
        { relativePath: "src/components/Card.tsx", content: "export const Card = () => null;" },
        { relativePath: "scripts/build.js", content: "console.log('build');" }
      ],
      defaultBranch: "develop",
      branches: ["refs/heads/develop", "refs/heads/release"],
      tags: ["v2.0.0"],
      lastCommit: {
        sha: "4444444444444444444444444444444444444444",
        message: "perf: faster builds",
        author: "Builder",
        date: new Date("2024-04-01T00:00:00.000Z")
      },
      firstCommitSha: "dddddddddddddddddddddddddddddddddddddddd",
      firstCommitDate: new Date("2023-10-01T00:00:00.000Z"),
      contributors: [{ name: "Builder", commits: 20 }]
    });

    await this.registerRepository("very-large-repo", {
      requiresAuth: false,
      files: Array.from({ length: 50 }, (_, index) => ({
        relativePath: `bulk/file-${index}.dat`,
        content: "x".repeat(2048)
      })),
      defaultBranch: "main",
      branches: ["refs/heads/main"],
      tags: [],
      lastCommit: {
        sha: "5555555555555555555555555555555555555555",
        message: "chore: add data",
        author: "Data",
        date: new Date("2024-05-01T00:00:00.000Z")
      },
      firstCommitSha: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      firstCommitDate: new Date("2024-03-01T00:00:00.000Z"),
      contributors: [{ name: "Data", commits: 5 }]
    });

    await this.registerRepository("multilang-repo", {
      requiresAuth: false,
      files: [
        { relativePath: "src/service.ts", content: "export interface Service { run(): Promise<void>; }" },
        { relativePath: "scripts/util.py", content: "def helper():\n    return 'python'" },
        { relativePath: "cmd/main.go", content: "package main\nfunc main() {}" },
        { relativePath: "README.md", content: "# Multi-language" }
      ],
      defaultBranch: "main",
      branches: ["refs/heads/main"],
      tags: ["v0.1.0"],
      lastCommit: {
        sha: "6666666666666666666666666666666666666666",
        message: "feat: polyglot",
        author: "Poly",
        date: new Date("2024-06-01T00:00:00.000Z")
      },
      firstCommitSha: "ffffffffffffffffffffffffffffffffffffffff",
      firstCommitDate: new Date("2024-04-01T00:00:00.000Z"),
      contributors: [
        { name: "Poly", commits: 7 },
        { name: "Dev", commits: 3 }
      ]
    });

    await this.registerRepository("slow-repo", {
      requiresAuth: false,
      files: [
        { relativePath: "README.md", content: "# Slow repo" },
        { relativePath: "src/slow.js", content: "module.exports = () => 'slow';" }
      ],
      defaultBranch: "main",
      branches: ["refs/heads/main"],
      tags: [],
      lastCommit: {
        sha: "7777777777777777777777777777777777777777",
        message: "perf: still slow",
        author: "Slow",
        date: new Date("2024-07-01T00:00:00.000Z")
      },
      firstCommitSha: "9999999999999999999999999999999999999999",
      firstCommitDate: new Date("2024-06-01T00:00:00.000Z"),
      contributors: [{ name: "Slow", commits: 1 }]
    });
  }

  private async registerRepository(
    name: string,
    options: {
      requiresAuth: boolean;
      files: Array<{ relativePath: string; content: string }>;
      defaultBranch: string;
      branches: string[];
      tags: string[];
      lastCommit: { sha: string; message: string; author: string; date: Date };
      firstCommitSha: string;
      firstCommitDate: Date;
      contributors: Array<{ name: string; commits: number }>;
      license?: string;
    }
  ): Promise<void> {
    const repoRoot = await fs.mkdtemp(path.join(this.workspace, `${name}-template-`));
    let totalFiles = 0;
    let totalSize = 0;
    for (const file of options.files) {
      const absolute = path.join(repoRoot, file.relativePath);
      await fs.mkdir(path.dirname(absolute), { recursive: true });
      await fs.writeFile(absolute, file.content, "utf8");
      totalFiles += 1;
      totalSize += Buffer.byteLength(file.content);
    }

    let licensePath: string | undefined;
    if (options.license) {
      licensePath = path.join(repoRoot, "LICENSE");
      await fs.writeFile(licensePath, `${options.license}\nCopyright (c) Test`, "utf8");
      totalFiles += 1;
      totalSize += Buffer.byteLength(options.license);
    }

    const url = `mock://${name}.git`;
    const definition: MockRepoDefinition = {
      name,
      url,
      rootPath: repoRoot,
      requiresAuth: options.requiresAuth,
      defaultBranch: options.defaultBranch,
      branches: options.branches,
      tags: options.tags,
      lastCommit: options.lastCommit,
      firstCommitSha: options.firstCommitSha,
      firstCommitDate: options.firstCommitDate,
      contributors: options.contributors,
      sizePack: Math.max(1, Math.floor(totalSize / 1024)),
      statistics: {
        totalFiles,
        cloneSize: totalSize
      }
    };

    if (licensePath) {
      Object.assign(definition, { licensePath });
    }

    this.repos.set(url, definition);
  }
}

class TestGitAuthenticator extends GitAuthenticator {
  constructor(private readonly registry: MockGitHubService, configService: ConfigurationService, logger: Logger) {
    super(configService, logger as GitLogger);
  }

  override async detectAuthenticationMethod(url: string): Promise<"none" | "token" | "ssh-key"> {
    return this.registry.requiresAuthentication(url) ? "token" : "none";
  }

  override async setupCredentials(url: string): Promise<AuthenticationInfo> {
    const requiresAuth = this.registry.requiresAuthentication(url);
    if (!requiresAuth) {
      return { method: "none", successful: true, credentialsUsed: false } satisfies AuthenticationInfo;
    }

    if (!this.registry.hasValidCredentials(url)) {
      return { method: "none", successful: false, credentialsUsed: false } satisfies AuthenticationInfo;
    }

    return {
      method: "token",
      successful: true,
      credentialsUsed: true,
      env: { MOCK_AUTH_TOKEN: this.registry.getCredentialToken() ?? "" }
    } satisfies AuthenticationInfo;
  }

  override async testAuthentication(url: string): Promise<boolean> {
    return !this.registry.requiresAuthentication(url) || this.registry.hasValidCredentials(url);
  }
}

class TestGitOperations extends AdvancedGitOperations {
  constructor(private readonly registry: MockGitHubService, logger: Logger) {
    super(logger as GitLogger);
  }

  override async partialClone(
    url: string,
    localPath: string,
    options: Parameters<AdvancedGitOperations["partialClone"]>[2]
  ): Promise<void> {
    const env = (options as { env?: NodeJS.ProcessEnv } | undefined)?.env;
    await this.cloneInternal(url, localPath, true, env);
  }

  override async standardClone(
    url: string,
    localPath: string,
    options: Parameters<AdvancedGitOperations["standardClone"]>[2]
  ): Promise<void> {
    const env = (options as { env?: NodeJS.ProcessEnv } | undefined)?.env;
    await this.cloneInternal(url, localPath, false, env);
  }

  override async setupSparseCheckout(
    localPath: string,
    patterns: Parameters<AdvancedGitOperations["setupSparseCheckout"]>[1]
  ): Promise<void> {
    if (patterns.length === 0) {
      return;
    }
    const repo = this.registry.resolveByLocalPath(localPath);
    if (!repo) {
      return;
    }
    const files = await this.collectFiles(localPath);
    const keepers = patterns.map((pattern) => globToRegExp(pattern));
    for (const file of files) {
      const relative = path.relative(localPath, file).replace(/\\/g, "/");
      if (!keepers.some((regex) => regex.test(relative))) {
        await fs.rm(file, { force: true });
      }
    }
  }

  override async initializeSubmodules(
    _localPath: string,
    _options?: Parameters<AdvancedGitOperations["initializeSubmodules"]>[1]
  ): Promise<never[]> {
    void _localPath;
    void _options;
    return [];
  }

  override async fetchMissing(
    _localPath: string,
    _paths: Parameters<AdvancedGitOperations["fetchMissing"]>[1],
    _options?: Parameters<AdvancedGitOperations["fetchMissing"]>[2]
  ): Promise<void> {
    void _localPath;
    void _paths;
    void _options;
    // Not required for these tests
  }

  private async cloneInternal(url: string, localPath: string, partial: boolean, env?: NodeJS.ProcessEnv): Promise<void> {
    const repo = this.registry.requestClone(url, Boolean(env?.MOCK_AUTH_TOKEN));
    await fs.mkdir(localPath, { recursive: true });
    await copyDirectory(repo.rootPath, localPath);
    this.registry.registerLocalClone(localPath, repo);
    this.registry.recordClone({ url, localPath, partial, sparsePatterns: [] });
  }

  private async collectFiles(root: string): Promise<string[]> {
    const entries = await fs.readdir(root, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const absolute = path.join(root, entry.name);
      if (entry.isDirectory()) {
        files.push(...await this.collectFiles(absolute));
      } else if (entry.isFile()) {
        files.push(absolute);
      }
    }
    return files;
  }
}

class TestRepositoryValidator extends RepositoryValidator {
  constructor(private readonly registry: MockGitHubService, logger: Logger) {
    super(logger as GitLogger);
  }

  override async validateRepository(url: string): Promise<RepositoryValidation> {
    const requiresAuth = this.registry.requiresAuthentication(url);
    const accessible = !requiresAuth || this.registry.hasValidCredentials(url);
    return {
      isValid: true,
      exists: true,
      isAccessible: accessible,
      requiresAuthentication: requiresAuth,
      availableRefs: ["refs/heads/main"],
      errors: accessible ? [] : ["Repository requires authentication"],
      warnings: [],
      ...(accessible ? { size: 1024 } : {})
    } satisfies RepositoryValidation;
  }
}

class AnalyzerGitProcessManager extends GitProcessManager {
  constructor(private readonly registry: MockGitHubService, logger: Logger, errorReporter: ErrorReporter) {
    super(logger as GitLogger, errorReporter);
  }

  override async executeGitCommand(args: string[], options: GitCommandOptions): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
    command: string;
    duration: number;
    retryCount: number;
  }> {
    const repo = options.cwd ? this.registry.resolveByLocalPath(options.cwd) : undefined;
    const commandLabel = args.join(" ");
    const baseResult = {
      stderr: "",
      exitCode: 0,
      command: commandLabel,
      duration: 0,
      retryCount: 0
    } as const;

    if (!repo) {
      return { stdout: "", ...baseResult };
    }

    const authorEmail = `${repo.lastCommit.author.replace(/\s+/g, ".").toLowerCase()}@example.com`;
    const sumCommits = repo.contributors.reduce((total, contributor) => total + contributor.commits, 0);

    if (args[0] === "log") {
      return {
        stdout: `${repo.lastCommit.sha}|${repo.lastCommit.message}|${repo.lastCommit.author}|${authorEmail}|${repo.lastCommit.date.toISOString()}`,
        ...baseResult
      };
    }

    if (args[0] === "rev-list" && args.includes("--count")) {
      return { stdout: `${sumCommits}`, ...baseResult };
    }

    if (args[0] === "branch") {
      return { stdout: repo.branches.join("\n"), ...baseResult };
    }

    if (args[0] === "tag") {
      return { stdout: repo.tags.join("\n"), ...baseResult };
    }

    if (args[0] === "count-objects") {
      return { stdout: `size-pack ${repo.sizePack}`, ...baseResult };
    }

    if (args[0] === "shortlog") {
      return {
        stdout: repo.contributors.map((contributor) => `${contributor.commits}\t${contributor.name}`).join("\n"),
        ...baseResult
      };
    }

    if (args[0] === "symbolic-ref") {
      return { stdout: repo.defaultBranch, ...baseResult };
    }

    if (args[0] === "rev-parse") {
      return { stdout: repo.defaultBranch, ...baseResult };
    }

    if (args[0] === "ls-files") {
      const stdout = repo.licensePath ? path.relative(options.cwd ?? "", repo.licensePath) : "";
      return { stdout, ...baseResult };
    }

    if (args[0] === "rev-list" && args.includes("--max-parents=0")) {
      return { stdout: repo.firstCommitSha, ...baseResult };
    }

    if (args[0] === "show") {
      return { stdout: repo.firstCommitDate.toISOString(), ...baseResult };
    }

    return { stdout: "", ...baseResult };
  }
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .split("")
    .map((char) => {
      if (char === "*") {
        return "*";
      }
      if (char === "?") {
        return ".";
      }
      return char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    })
    .join("");
  const regex = escaped
    .replace(/\*\*/g, "(?:(?:.*))")
    .replace(/\*/g, "[^/]*");
  return new RegExp(`^${regex}$`, "i");
}

async function copyDirectory(source: string, destination: string): Promise<void> {
  await fs.mkdir(destination, { recursive: true });
  const entries = await fs.readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(source, entry.name);
    const destPath = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      await copyDirectory(srcPath, destPath);
    } else if (entry.isFile()) {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

const createDiagnostics = (): Diagnostics => ({
  addError: jest.fn(),
  addWarning: jest.fn()
});

const createConfigurationService = (workspaceRoot: string): ConfigurationService => {
  const diagnostics = createDiagnostics();
  const config: Partial<DigestConfig> = {
    ...DEFAULT_CONFIG,
    workspaceRoot
  };
  return new ConfigurationService(config, diagnostics);
};

const createRetryFactory = (logger: Logger) => (config: RetryConfig) => new RetryableGitOperation(config, logger, async () => Promise.resolve());

interface MockChildProcess extends EventEmitter {
  stdout: PassThrough;
  stderr: PassThrough;
  killed: boolean;
  pid: number;
  kill: jest.Mock;
}

const createMockChildProcess = (): MockChildProcess => {
  const stdout = new PassThrough();
  stdout.setEncoding("utf8");
  const stderr = new PassThrough();
  stderr.setEncoding("utf8");
  const child = new EventEmitter() as MockChildProcess;
  child.stdout = stdout;
  child.stderr = stderr;
  child.killed = false;
  child.pid = Math.floor(Math.random() * 1000) + 1;
  child.kill = jest.fn(() => {
    child.killed = true;
    return true;
  });
  return child;
};

describe("Sprint 4 Integration: Remote Ingest & Robustness", () => {
  let testTempDir: string;
  let mockGitHub: MockGitHubService;
  let logger: TestLogger;
  let configService: ConfigurationService;
  let errorReporter: ErrorReporter;
  let performanceMonitor: PerformanceMonitor;
  let remoteRepoService: RemoteRepoService;
  let gitProcessManager: GitProcessManager;
  let analyzerGitProcessManager: AnalyzerGitProcessManager;
  let repositoryAnalyzer: RepositoryAnalyzer;
  let contentProcessor: ContentProcessor;
  let fileScanner: FileScanner;
  let tempDirectoryManager: TemporaryDirectoryManager;

  beforeAll(async () => {
    jest.setTimeout(120_000);
    testTempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sprint4-integration-"));
    mockGitHub = new MockGitHubService(testTempDir);
    await mockGitHub.initialize();

    configureWorkspaceEnvironment(undefined, {
      maxTimeout: 60_000,
      maxRetries: 3,
      usePartialClone: true,
      defaultSparsePatterns: ["README.md"],
      keepTempDirs: false
    });

    logger = new TestLogger();
    configService = createConfigurationService(testTempDir);
    errorReporter = new ErrorReporter(configService, logger);
    performanceMonitor = new PerformanceMonitor(logger, configService);
    tempDirectoryManager = new TemporaryDirectoryManager();

    const gitOperations = new TestGitOperations(mockGitHub, logger);
    const authenticator = new TestGitAuthenticator(mockGitHub, configService, logger);
    const validator = new TestRepositoryValidator(mockGitHub, logger);

    remoteRepoService = new RemoteRepoService(configService, errorReporter, logger, {
      authenticator,
      gitOperations,
      validator,
      tempDirectoryManager,
      retryFactory: createRetryFactory(logger)
    });

    gitProcessManager = new GitProcessManager(logger, errorReporter);
    contentProcessor = new ContentProcessor();
    analyzerGitProcessManager = new AnalyzerGitProcessManager(mockGitHub, logger, errorReporter);
    fileScanner = new FileScanner(vscode.Uri.file(testTempDir));
    repositoryAnalyzer = new RepositoryAnalyzer(
      analyzerGitProcessManager,
      fileScanner,
      contentProcessor
    );

    mockedSpawnGitPromise.mockImplementation(async (args: string[]) => {
      if (args[0] === "ls-remote") {
        const repo = mockGitHub.resolveByLocalPath(args[1] ?? "");
        if (repo) {
          return { stdout: `${repo.lastCommit.sha}\tHEAD\n`, stderr: "" };
        }
        const match = Array.from(mockGitHub["repos"].values()).find((definition: MockRepoDefinition) => definition.url === args[1]);
        if (match) {
          return { stdout: `${match.lastCommit.sha}\tHEAD\n`, stderr: "" };
        }
        return { stdout: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\tHEAD\n", stderr: "" };
      }

      if (args[0] === "-C") {
        const localPath = args[1]!;
        const repo = mockGitHub.resolveByLocalPath(localPath);
        if (!repo) {
          return { stdout: "", stderr: "" };
        }
        const subCommand = args[2];
        switch (subCommand) {
          case "log":
            return { stdout: `${repo.lastCommit.sha}\n${repo.lastCommit.message}\n${repo.lastCommit.author}\n${repo.lastCommit.date.toISOString()}\n`, stderr: "" };
          case "config":
            return { stdout: "", stderr: "" };
          case "rev-parse":
            return { stdout: repo.lastCommit.sha, stderr: "" };
          default:
            return { stdout: "", stderr: "" };
        }
      }

      return { stdout: "", stderr: "" };
    });
  });

  afterAll(async () => {
    await performanceMonitor.dispose();
    errorReporter.dispose();
    await mockGitHub.dispose();
    await fs.rm(testTempDir, { recursive: true, force: true });
    resetWorkspaceEnvironment();
  });

  afterEach(async () => {
    logger.clear();
    errorReporter.clearErrorBuffer();
    performanceMonitor.reset();
    mockedSpawnGitPromise.mockClear();
  });

  it("clones a public repository with sparse checkout and tracks performance", async () => {
    const repoUrl = mockGitHub.getTestRepoUrl();
    const progressEvents: CloneProgress[] = [];
    const operationId = performanceMonitor.startOperation("remote-clone-integration", { repoUrl });

    const result = await remoteRepoService.cloneRepository({
      url: repoUrl,
      ref: "main",
      partialClone: true,
      sparseCheckout: ["README.md", "src/**"],
      progressCallback: (progress) => progressEvents.push(progress)
    });

    const metrics = performanceMonitor.endOperation(operationId);

    expect(result.localPath).toBeTruthy();
    expect(fsSync.existsSync(path.join(result.localPath, "README.md"))).toBe(true);
    expect(fsSync.existsSync(path.join(result.localPath, "src", "index.js"))).toBe(true);
    expect(fsSync.existsSync(path.join(result.localPath, "test", "app.test.js"))).toBe(false);

    expect(result.metadata.resolvedRef).toHaveLength(40);
    expect(result.statistics.partialClone).toBe(true);
    expect(result.statistics.sparseCheckout).toBe(true);
    expect(metrics).not.toBeNull();
    expect(metrics?.duration).toBeGreaterThan(0);
    expect(progressEvents.some((event) => event.phase === "cloning")).toBe(true);

    await remoteRepoService.cleanup(result.localPath);
    expect(fsSync.existsSync(result.localPath)).toBe(false);
  });

  it("requires credentials for private repositories and succeeds after configuration", async () => {
    const privateUrl = mockGitHub.getPrivateRepoUrl();

    await expect(remoteRepoService.cloneRepository({ url: privateUrl, ref: "main" })).rejects.toThrow(/auth/i);

    mockGitHub.setCredentials("test-user", "test-token");

    const result = await remoteRepoService.cloneRepository({ url: privateUrl, ref: "main" });
    expect(result.authenticationUsed).toBe(true);
    expect(fsSync.existsSync(result.localPath)).toBe(true);
    await remoteRepoService.cleanup(result.localPath);
  });

  it("retries transient failures and succeeds", async () => {
    const url = mockGitHub.getUnreliableRepoUrl();
    mockGitHub.configureFailures(url, 2);

    const result = await remoteRepoService.cloneRepository({
      url,
      retryCount: 3
    });

    expect(mockGitHub.getRequestCount(url)).toBe(3);
    expect(result.statistics.retriesPerformed).toBe(2);

    await remoteRepoService.cleanup(result.localPath);
  });

  it("analyzes repository structure and languages", async () => {
    const url = mockGitHub.getMultiLanguageRepoUrl();
    const clone = await remoteRepoService.cloneRepository({ url });

    const analysis = await repositoryAnalyzer.analyzeRepository(clone.localPath);
  const repoDefinition = mockGitHub.resolveByLocalPath(clone.localPath);

  expect(repoDefinition).toBeDefined();
  const expectedBranch = repoDefinition?.defaultBranch.replace(/^refs\/heads\//, "") ?? "main";
  expect(analysis.metadata.defaultBranch.replace(/^refs\/heads\//, "")).toBe(expectedBranch);
  const reportedBranches = analysis.metadata.branches.map((branch) => branch.replace(/^refs\/heads\//, ""));
  expect(reportedBranches).toEqual(expect.arrayContaining([expectedBranch]));
  expect(reportedBranches.length).toBeGreaterThan(0);

  expect(analysis.languages.distribution.size).toBeGreaterThan(0);
  const languages = Array.from(analysis.languages.distribution.keys());
  expect(languages.length).toBeGreaterThan(0);
  expect(analysis.structure.sourceDirectories.length).toBeGreaterThan(0);
  const hasSrcDirectory = analysis.structure.sourceDirectories.some((dir) => /src/i.test(dir));
  expect(hasSrcDirectory).toBe(true);
  expect(analysis.metadata.readmeExists).toBe(true);

    await remoteRepoService.cleanup(clone.localPath);
  });

  it("classifies network errors and reports them", async () => {
    const flakyUrl = mockGitHub.getUnreliableRepoUrl();
    mockGitHub.configureFailures(flakyUrl, 5);

    await expect(remoteRepoService.cloneRepository({ url: flakyUrl, retryCount: 1 })).rejects.toThrow();

    const buffer = errorReporter.getErrorBuffer();
    expect(buffer.length).toBeGreaterThan(0);
    const networkError = buffer.find((report: ErrorReport) => report.classification.category === ErrorCategory.NETWORK);
    expect(networkError).toBeDefined();
  });

  it("collects performance metrics for full ingest flow", async () => {
    const url = mockGitHub.getTestRepoUrl();
    const before = performanceMonitor.getMetricsHistory().length;

    const wrapped = await performanceMonitor.measureAsync("full-remote-ingest-flow", async () => {
      const clone = await remoteRepoService.cloneRepository({ url, partialClone: true });
      const analysis = await repositoryAnalyzer.analyzeRepository(clone.localPath);
      await remoteRepoService.cleanup(clone.localPath);
      return analysis;
    });

    const after = performanceMonitor.getMetricsHistory().length;
    expect(after).toBe(before + 1);
    expect(wrapped.metrics.duration).toBeGreaterThan(0);

    const report = performanceMonitor.generateReport();
    expect(report.overall.totalOperations).toBeGreaterThan(0);
  });

  it("scrubs credentials and validates git commands", async () => {
    const child = createMockChildProcess();
    spawnMock.mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);

    const execution = gitProcessManager.executeGitCommand([
      "clone",
      "https://user:token@example.com/repo.git"
    ], {
      cwd: testTempDir,
      logCommand: true
    });

    child.stdout.write("cloning repo\n");
    child.stderr.write("warning: using https://user:token@example.com/repo.git\n");
    child.stdout.end();
    child.stderr.end();
    child.emit("close", 0, null);

    const result = await execution;
    expect(result.stdout).toContain("cloning repo");
    expect(result.command).not.toContain("user:token");

    await expect(
      gitProcessManager.executeGitCommand(["--exec=malicious", "clone"], { cwd: testTempDir })
    ).rejects.toThrow(/not allowed/);
  });

  it("enforces subprocess timeouts", async () => {
    jest.useFakeTimers();
    try {
      const child = createMockChildProcess();
      spawnMock.mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);

      const command = gitProcessManager.executeGitCommand([
        "clone",
        mockGitHub.getSlowRepoUrl(),
        path.join(testTempDir, "slow")
      ], {
        cwd: testTempDir,
        timeout: 100
      });

      jest.advanceTimersByTime(150);
      await expect(command).rejects.toThrow(/timeout|timed out/i);

      child.emit("close", 1, null);
    } finally {
      jest.useRealTimers();
    }
  });
});
