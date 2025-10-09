import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";

import {
  GitProcessManager,
  type GitCommandOptions,
  GitErrorType,
  type Logger
} from "../../utils/gitProcessManager";
import type { ErrorReporter } from "../../services/errorReporter";

jest.mock("node:child_process", () => ({
  spawn: jest.fn()
}));

const spawnMock = jest.mocked(spawn);

type MockChildProcess = ChildProcess & {
  stdout: PassThrough;
  stderr: PassThrough;
  pid: number;
  killed: boolean;
};

const createMockChildProcess = (): {
  child: MockChildProcess;
  stdout: PassThrough;
  stderr: PassThrough;
} => {
  const stdout = new PassThrough();
  stdout.setEncoding("utf8");
  const stderr = new PassThrough();
  stderr.setEncoding("utf8");
  const child = new EventEmitter() as unknown as MockChildProcess;
  child.stdout = stdout;
  child.stderr = stderr;
  child.pid = Math.floor(Math.random() * 10_000) + 1;
  child.killed = false;
  return { child, stdout, stderr };
};

const createLogger = (): Logger => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
});

const createErrorReporter = () => {
  const mock = {
    report: jest.fn(),
    reportError: jest.fn()
  };

  return {
    instance: mock as unknown as ErrorReporter,
    mock
  };
};

describe("GitProcessManager", () => {
  let killSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    jest.clearAllMocks();
    killSpy = jest.spyOn(process, "kill").mockImplementation(() => true);
  });

  afterEach(() => {
    killSpy.mockRestore();
  });

  const createManager = () => new GitProcessManager(createLogger(), createErrorReporter().instance);

  const flushAsync = async () => new Promise((resolve) => setImmediate(resolve));

  test("executes git command successfully with sanitized output", async () => {
    const { child, stdout, stderr } = createMockChildProcess();
  spawnMock.mockReturnValueOnce(child);

    const manager = createManager();
    const progress = jest.fn();

    const options: GitCommandOptions = {
      cwd: "/workspace",
      progressCallback: progress
    };

    const execution = manager.executeGitCommand(["status"], options);

    stdout.write("token=my-secret\n");
    stdout.end();
    stderr.write("access token=my-secret\n");
    stderr.end();
    child.emit("close", 0, null);

    const result = await execution;

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("[REDACTED]");
    expect(result.stderr).toContain("[REDACTED]");
    expect(progress).toHaveBeenCalledWith("[REDACTED]\n");

    const metrics = manager.getMetrics();
    expect(metrics.totalCommands).toBe(1);
    expect(metrics.failedCommands).toBe(0);
  });

  test("retries retryable errors and succeeds", async () => {
    const first = createMockChildProcess();
    const second = createMockChildProcess();
  spawnMock.mockReturnValueOnce(first.child);
  spawnMock.mockReturnValueOnce(second.child);

    const manager = createManager();

    const delaySpy = jest
      .spyOn(GitProcessManager.prototype as unknown as { delay(ms: number): Promise<void> }, "delay")
      .mockResolvedValue();

    const execution = manager.executeGitCommand(
      ["fetch", "origin"],
      {
        cwd: "/repo",
        retries: 2
      }
    );

    first.stderr.write("connection timed out");
    first.stderr.end();
    first.child.emit("close", 1, null);

    await flushAsync();

    second.stdout.write("done");
    second.stdout.end();
    second.child.emit("close", 0, null);

    const result = await execution;

    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(result.retryCount).toBe(1);
    expect(result.stdout).toBe("done");

    const metrics = manager.getMetrics();
    expect(metrics.totalCommands).toBe(1);
    expect(metrics.failedCommands).toBe(0);

    delaySpy.mockRestore();
  });

  test("streams output chunks with sanitization", async () => {
    const { child, stdout, stderr } = createMockChildProcess();
    spawnMock.mockReturnValueOnce(child);

    const manager = createManager();
    const progress = jest.fn();

    const delaySpy = jest
      .spyOn(GitProcessManager.prototype as unknown as { delay(ms: number): Promise<void> }, "delay")
      .mockResolvedValue();

    const options: GitCommandOptions = {
      cwd: "/workspace",
      progressCallback: progress
    };

    const received: string[] = [];

    const iterator = (async () => {
      for await (const chunk of manager.executeGitCommandStream(["log", "--oneline"], options)) {
        received.push(chunk);
      }
    })();

    stdout.write("token=abc");
    stdout.write("\nsecond line");
    stdout.end();
    stderr.end();
    await flushAsync();
    child.emit("close", 0, null);

    await iterator;
    delaySpy.mockRestore();

    expect(received.join("")).toBe("[REDACTED]\nsecond line");
  expect(progress).toHaveBeenCalled();
  expect(progress.mock.calls[0]?.[0]).toContain("[REDACTED]");

    const metrics = manager.getMetrics();
    expect(metrics.totalCommands).toBeGreaterThanOrEqual(1);
    expect(metrics.failedCommands).toBe(0);
  });

  test("classifies errors and reports with metadata", async () => {
    const { child, stderr } = createMockChildProcess();
    spawnMock.mockReturnValueOnce(child);

    const logger = createLogger();
    const { instance: reporter, mock: reporterMock } = createErrorReporter();
    const manager = new GitProcessManager(logger, reporter);

    const options: GitCommandOptions = {
      cwd: "/workspace",
      retries: 1
    };

    const execution = manager.executeGitCommand(["fetch"], options);

    stderr.write("fatal: authentication failed");
    stderr.end();
    child.emit("close", 1, null);

  await expect(execution).rejects.toThrow("fatal: authentication failed");

    expect(reporterMock.report).toHaveBeenCalled();
    const metrics = manager.getMetrics();
    expect(metrics.failedCommands).toBeGreaterThanOrEqual(1);
    expect(metrics.errorTypes.get(GitErrorType.AUTHENTICATION)).toBeGreaterThanOrEqual(1);
  });
});
