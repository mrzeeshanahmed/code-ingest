import { describe, expect, it, jest } from "@jest/globals";
import { EventEmitter } from "events";
import { spawn } from "node:child_process";
import { spawnGitPromise } from "../utils/procRedact";

jest.mock("node:child_process", () => ({
  spawn: jest.fn()
}));

type MockChildProcess = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
};

function createChildProcess(): MockChildProcess {
  const child = new EventEmitter() as MockChildProcess;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

describe("spawnGitPromise", () => {
  const spawnMock = spawn as unknown as jest.MockedFunction<typeof spawn>;

  it("resolves with redacted output on success", async () => {
    spawnMock.mockReset();
    const child = createChildProcess();
    spawnMock.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const promise = spawnGitPromise(["status"], { secretsToRedact: ["secret"] });

    child.stdout.emit("data", Buffer.from("secret visible"));
    child.stderr.emit("data", Buffer.from(""));
    child.emit("close", 0, null);

    const result = await promise;
    expect(result.stdout).toBe("[REDACTED] visible");
  });

  it("rejects with a redacted error when git exits with non-zero code", async () => {
    spawnMock.mockReset();
    const child = createChildProcess();
    spawnMock.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const promise = spawnGitPromise(["commit"], { secretsToRedact: ["secret"] });
    child.stderr.emit("data", Buffer.from("fatal: secret leak"));
    child.emit("close", 1, null);

    await expect(promise).rejects.toMatchObject({
      stderr: "fatal: [REDACTED] leak"
    });
  });

  it("rejects when the process emits an error", async () => {
    spawnMock.mockReset();
    const child = createChildProcess();
    spawnMock.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const promise = spawnGitPromise(["clone"], { secretsToRedact: ["token"] });

    child.emit("error", new Error("token failure"));

    await expect(promise).rejects.toMatchObject({
      message: expect.stringContaining("[REDACTED]")
    });
  });
});