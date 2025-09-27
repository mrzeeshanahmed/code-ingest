import * as vscode from "vscode";
import * as os from "node:os";
import * as path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { spawnGitPromise } from "../utils/procRedact";

const GITHUB_API_BASE = "https://api.github.com";

/**
 * Requests a GitHub session with the `repo` scope. This may trigger a VS Code UI prompt
 * asking the user to sign in and grant access. If the user declines, the promise resolves
 * to `undefined`.
 */
export async function authenticate(): Promise<string | undefined> {
  try {
    const session = await vscode.authentication.getSession("github", ["repo"], {
      createIfNone: true
    });

    return session?.accessToken;
  } catch (error) {
    console.warn("CodeIngest GitHub authentication failed", error);
    return undefined;
  }
}

function redactToken(token: string): string {
  if (!token) {
    return token;
  }

  const visible = token.slice(0, 4);
  return `${visible}…`; // Do not expose full token in logs
}

async function fetchRefFromApi(
  repoSlug: string,
  ref: string,
  token: string
): Promise<string | undefined> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`
  };

  const trimmedRef = ref.startsWith("refs/") ? ref.slice("refs/".length) : ref;
  const hasNamespace = /^(heads|tags|remotes|pull)\//.test(trimmedRef);
  const apiRef = hasNamespace ? trimmedRef : `heads/${trimmedRef}`;
  const url = `${GITHUB_API_BASE}/repos/${repoSlug}/git/ref/${apiRef}`;

  const response = await fetch(url, {
    headers
  });

  if (!response.ok) {
    throw new Error(`GitHub API responded with status ${response.status}`);
  }

  const data = (await response.json()) as { object?: { sha?: string } };
  const sha = data?.object?.sha;
  if (!sha) {
    throw new Error("GitHub API response did not include an object SHA");
  }

  return sha;
}

async function fallbackResolveWithGit(
  repoSlug: string,
  ref: string,
  token: string
): Promise<string> {
  const remote = `https://oauth2:${token}@github.com/${repoSlug}.git`;
  const { stdout } = await spawnGitPromise(["ls-remote", remote, ref], {
    secretsToRedact: [token]
  });

  const lines = stdout.split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) {
    throw new Error(`git ls-remote returned no results for ${repoSlug} ${ref}`);
  }

  const [sha] = lines[0].split(/\s+/);
  if (!sha) {
    throw new Error(`Unable to parse SHA from git ls-remote output: ${lines[0]}`);
  }

  return sha;
}

/**
 * Resolves a repository reference (branch, tag, or other ref) to a full commit SHA. Tries the GitHub REST API
 * first for performance and falls back to `git ls-remote` if necessary.
 */
export async function resolveRefToSha(repoSlug: string, ref: string, token: string): Promise<string> {
  try {
    const apiSha = await fetchRefFromApi(repoSlug, ref, token);
    if (!apiSha) {
      throw new Error("GitHub API returned an empty SHA");
    }

    return apiSha;
  } catch (apiError) {
    console.warn(
      `CodeIngest: GitHub API ref resolution failed for ${repoSlug}@${ref} (token ${redactToken(token)}). Falling back to git.`,
      apiError
    );

    try {
      return await fallbackResolveWithGit(repoSlug, ref, token);
    } catch (gitError) {
      throw new Error(
        `CodeIngest: Failed to resolve ref ${ref} for ${repoSlug} via API and git fallback. Last error: ${
          (gitError as Error).message
        }`
      );
    }
  }
}

/**
 * Performs a blobless clone of the provided repository into a secure temporary directory and returns its path.
 */
export async function partialClone(repoSlug: string, token: string): Promise<{ tempDir: string }> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "code-ingest-"));
  const remote = `https://oauth2:${token}@github.com/${repoSlug}.git`;

  try {
    await spawnGitPromise(["clone", "--filter=blob:none", remote, "."], {
      cwd: tempDir,
      secretsToRedact: [token]
    });

    return { tempDir };
  } catch (error) {
    try {
      await rm(tempDir, { recursive: true, force: true });
    } catch (cleanupError) {
      console.warn(`CodeIngest: Failed to clean up temporary directory ${tempDir} after clone failure.`, cleanupError);
    }

    throw error;
  }
}
