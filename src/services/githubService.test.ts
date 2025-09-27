import { afterEach, describe, expect, it, jest } from "@jest/globals";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { authenticate, partialClone, resolveRefToSha } from "./githubService";
import { spawnGitPromise } from "../utils/procRedact";
import { mkdtemp, rm } from "node:fs/promises";

jest.mock("../utils/procRedact", () => ({
  spawnGitPromise: jest.fn()
}));

jest.mock("node:fs/promises", () => ({
  mkdtemp: jest.fn(),
  rm: jest.fn()
}));

describe("githubService.authenticate", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("returns an access token when authentication succeeds", async () => {
    const getSessionMock = vscode.authentication.getSession as unknown as jest.MockedFunction<
      typeof vscode.authentication.getSession
    >;
    const session: vscode.AuthenticationSession = {
      id: "session-id",
      accessToken: "token",
      account: { id: "account-id", label: "account" },
      scopes: ["repo"]
    };
    getSessionMock.mockResolvedValue(session);

    await expect(authenticate()).resolves.toBe("token");
    expect(vscode.authentication.getSession).toHaveBeenCalledWith("github", ["repo"], {
      createIfNone: true
    });
  });

  it("returns undefined when authentication fails", async () => {
    const getSessionMock = vscode.authentication.getSession as unknown as jest.MockedFunction<
      typeof vscode.authentication.getSession
    >;
    jest.spyOn(console, "warn").mockImplementation(() => {});
    getSessionMock.mockRejectedValue(new Error("denied"));

    await expect(authenticate()).resolves.toBeUndefined();
  });
});

describe("githubService.resolveRefToSha", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    jest.restoreAllMocks();
    global.fetch = originalFetch;
  });

  it("returns the SHA from the GitHub API when available", async () => {
    const fetchMock = jest.fn() as unknown as jest.MockedFunction<typeof fetch>;
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ object: { sha: "123abc" } })
    } as unknown as Response);
    global.fetch = fetchMock as unknown as typeof global.fetch;

    const sha = await resolveRefToSha("owner/repo", "main", "token123");

    expect(sha).toBe("123abc");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/owner/repo/git/ref/heads/main",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer token123" })
      })
    );
  });

  it("falls back to git when the API fails", async () => {
  const fetchMock = jest.fn() as unknown as jest.MockedFunction<typeof fetch>;
  fetchMock.mockResolvedValue({ ok: false } as unknown as Response);
    global.fetch = fetchMock as unknown as typeof global.fetch;

    const spawnGitMock = spawnGitPromise as unknown as jest.MockedFunction<typeof spawnGitPromise>;
    jest.spyOn(console, "warn").mockImplementation(() => {});
    spawnGitMock.mockResolvedValue({ stdout: "deadbeef\trefs/heads/main", stderr: "" });

    const sha = await resolveRefToSha("owner/repo", "main", "token123");

    expect(spawnGitMock).toHaveBeenCalledWith(
      ["ls-remote", "https://oauth2:token123@github.com/owner/repo.git", "main"],
      expect.objectContaining({ secretsToRedact: ["token123"] })
    );
    expect(sha).toBe("deadbeef");
  });

  it("throws an error when both API and git resolution fail", async () => {
  const fetchMock = jest.fn() as unknown as jest.MockedFunction<typeof fetch>;
  fetchMock.mockResolvedValue({ ok: false } as unknown as Response);
    global.fetch = fetchMock as unknown as typeof global.fetch;

    const spawnGitMock = spawnGitPromise as unknown as jest.MockedFunction<typeof spawnGitPromise>;
    jest.spyOn(console, "warn").mockImplementation(() => {});
    spawnGitMock.mockRejectedValue(new Error("git failed"));

    await expect(resolveRefToSha("owner/repo", "main", "token123")).rejects.toThrow(
      /Failed to resolve ref/
    );
  });
});

describe("githubService.partialClone", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("performs a blobless clone into a temporary directory", async () => {
    const tempDir = path.join(os.tmpdir(), "code-ingest-clone");
    const mkdtempMock = mkdtemp as unknown as jest.MockedFunction<typeof mkdtemp>;
    const spawnGitMock = spawnGitPromise as unknown as jest.MockedFunction<typeof spawnGitPromise>;
    mkdtempMock.mockResolvedValue(tempDir);
    spawnGitMock.mockResolvedValue({ stdout: "", stderr: "" });

    const result = await partialClone("owner/repo", "token123");

    expect(mkdtempMock).toHaveBeenCalledWith(path.join(os.tmpdir(), "code-ingest-"));
    expect(spawnGitMock).toHaveBeenCalledWith(
      ["clone", "--filter=blob:none", "https://oauth2:token123@github.com/owner/repo.git", "."],
      expect.objectContaining({ cwd: tempDir, secretsToRedact: ["token123"] })
    );
    expect(result).toEqual({ tempDir });
  });

  it("cleans up the temp directory when cloning fails", async () => {
    const tempDir = path.join(os.tmpdir(), "code-ingest-clone");
    const mkdtempMock = mkdtemp as unknown as jest.MockedFunction<typeof mkdtemp>;
    const spawnGitMock = spawnGitPromise as unknown as jest.MockedFunction<typeof spawnGitPromise>;
    const rmMock = rm as unknown as jest.MockedFunction<typeof rm>;
    mkdtempMock.mockResolvedValue(tempDir);
    spawnGitMock.mockRejectedValue(new Error("clone failed"));

    await expect(partialClone("owner/repo", "token123")).rejects.toThrow("clone failed");
    expect(rmMock).toHaveBeenCalledWith(tempDir, { force: true, recursive: true });
  });
});