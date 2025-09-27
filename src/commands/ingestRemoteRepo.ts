import * as vscode from "vscode";
import * as path from "node:path";
import { readdir, rm, stat } from "node:fs/promises";

import { COMMAND_MAP } from "./commandMap";
import type { CommandServices } from "./types";
import { authenticate, partialClone, resolveRefToSha } from "../services/githubService";
import { spawnGitPromise } from "../utils/procRedact";
import { DigestGenerator } from "../services/digestGenerator";
import { ContentProcessor } from "../services/contentProcessor";
import { TokenAnalyzer } from "../services/tokenAnalyzer";
import type { DigestConfig } from "../utils/validateConfig";

const EXCLUDED_DIRECTORIES = new Set([".git", "node_modules"]);

function parseRepoSlug(input: string): string {
  try {
    const parsed = new URL(input.trim());
    const host = parsed.hostname.toLowerCase();
    if (!host.endsWith("github.com")) {
      throw new Error("Only GitHub repositories are supported at the moment.");
    }

    const [owner, repository] = parsed.pathname.split("/").filter(Boolean);
    if (!owner || !repository) {
      throw new Error("The repository URL must include both an owner and repository name.");
    }

    return `${owner}/${repository.replace(/\.git$/i, "")}`;
  } catch (error) {
    if (error instanceof Error && error.message.includes("GitHub")) {
      throw error;
    }
    throw new Error("Invalid GitHub repository URL. Please enter a URL like https://github.com/owner/repo.");
  }
}

function normalizeSubpath(input: string): string {
  if (!input) {
    return "";
  }

  const converted = input.replace(/\\/g, "/").trim();
  if (!converted) {
    return "";
  }

  return converted.replace(/^\/+/, "").replace(/\/+$/u, "");
}

function throwIfCancelled(token: vscode.CancellationToken): void {
  if (token.isCancellationRequested) {
    throw new vscode.CancellationError();
  }
}

async function collectFilesRecursive(rootDir: string, token: vscode.CancellationToken): Promise<string[]> {
  const files: string[] = [];

  async function walk(currentDir: string): Promise<void> {
    throwIfCancelled(token);

    const entries = await readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (EXCLUDED_DIRECTORIES.has(entry.name)) {
        continue;
      }

      const entryPath = path.join(currentDir, entry.name);

      if (typeof entry.isSymbolicLink === "function" && entry.isSymbolicLink()) {
        continue;
      }

      if (entry.isDirectory()) {
        await walk(entryPath);
      } else if (entry.isFile()) {
        files.push(entryPath);
      }
    }
  }

  await walk(rootDir);
  return files;
}

interface IngestOutcome {
  digest: string;
  repoSlug: string;
  sha: string;
  totalTokens: number;
  diagnostics: string[];
}

export function registerIngestRemoteRepoCommand(
  context: vscode.ExtensionContext,
  services: CommandServices
): void {
  const disposable = vscode.commands.registerCommand(COMMAND_MAP.ingestRemoteRepo, async () => {
    const repoUrl = await vscode.window.showInputBox({
      title: "Ingest Remote Repository",
      prompt: "Enter the full GitHub repository URL (e.g. https://github.com/owner/repo).",
      placeHolder: "https://github.com/owner/repository",
      ignoreFocusOut: true
    });

    if (!repoUrl || !repoUrl.trim()) {
      services.diagnostics.add("Ingest remote repo command cancelled at repository URL step.");
      return;
    }

    const gitRef = await vscode.window.showInputBox({
      title: "Select Git Reference",
      prompt: "Enter the branch, tag, or commit SHA you want to ingest.",
      placeHolder: "main",
      ignoreFocusOut: true
    });

    if (!gitRef || !gitRef.trim()) {
      services.diagnostics.add("Ingest remote repo command cancelled at git reference step.");
      return;
    }

    const subpath = await vscode.window.showInputBox({
      title: "Optional Subpath",
      prompt: "Provide a relative path within the repository to focus on (leave blank for entire repository).",
      placeHolder: "src/",
      ignoreFocusOut: true
    });

    if (typeof subpath === "undefined") {
      services.diagnostics.add("Ingest remote repo command cancelled at subpath step.");
      return;
    }

    const trimmedRef = gitRef.trim();
    const trimmedSubpath = subpath.trim();

    let repoSlug: string;
    try {
      repoSlug = parseRepoSlug(repoUrl);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      services.diagnostics.add(`Ingest remote repo aborted: ${message}`);
      void vscode.window.showErrorMessage(`Code Ingest: ${message}`);
      return;
    }

    const normalizedSubpath = normalizeSubpath(trimmedSubpath);
    services.diagnostics.add(
      `Starting remote ingestion for ${repoSlug}@${trimmedRef}${
        normalizedSubpath ? ` (subpath: ${normalizedSubpath})` : ""
      }.`
    );

    let outcome: IngestOutcome | undefined;
    try {
      outcome = await vscode.window.withProgress<IngestOutcome>({
        location: vscode.ProgressLocation.Notification,
        title: `Code Ingest: Ingesting ${repoSlug}@${trimmedRef}`,
        cancellable: true
      }, async (progress, cancellationToken) => {
        let tempDir: string | undefined;
        let token: string | undefined;

        throwIfCancelled(cancellationToken);
        progress.report({ message: "Authenticating with GitHub..." });
        token = await authenticate();
        if (!token) {
          throw new Error("GitHub authentication failed or was cancelled.");
        }

        throwIfCancelled(cancellationToken);
        progress.report({ message: "Resolving repository reference..." });
        const sha = await resolveRefToSha(repoSlug, trimmedRef, token);

        throwIfCancelled(cancellationToken);
        progress.report({ message: "Cloning repository (blobless)..." });
        const { tempDir: cloneDir } = await partialClone(repoSlug, token);
        tempDir = cloneDir;

        try {
          throwIfCancelled(cancellationToken);
          progress.report({ message: "Fetching requested reference..." });

          try {
            await spawnGitPromise(["-C", tempDir, "fetch", "--depth=1", "origin", trimmedRef], {
              secretsToRedact: [token]
            });
          } catch (fetchError) {
            const fetchMessage = fetchError instanceof Error ? fetchError.message : String(fetchError);
            services.diagnostics.add(`Fetch hint: ${fetchMessage}; retrying with full fetch.`);
            await spawnGitPromise(["-C", tempDir, "fetch", "origin"], {
              secretsToRedact: [token]
            });
          }

          throwIfCancelled(cancellationToken);
          progress.report({ message: "Checking out target commit..." });
          await spawnGitPromise(["-C", tempDir, "checkout", sha], {
            secretsToRedact: [token]
          });

          const repoRoot = path.resolve(tempDir);
          const targetPath = normalizedSubpath ? path.resolve(repoRoot, normalizedSubpath) : repoRoot;
          const relative = path.relative(repoRoot, targetPath);
          if (relative.startsWith("..") || path.isAbsolute(relative)) {
            throw new Error("The provided subpath escapes the repository root.");
          }

          throwIfCancelled(cancellationToken);
          const targetStats = await stat(targetPath).catch(() => null);
          if (!targetStats) {
            throw new Error(
              normalizedSubpath
                ? `The subpath "${normalizedSubpath}" does not exist in the repository.`
                : "Failed to access repository contents after cloning."
            );
          }

          const workspaceRoot = targetStats.isDirectory() ? targetPath : path.dirname(targetPath);
          let filesToProcess: string[];
          if (targetStats.isDirectory()) {
            filesToProcess = await collectFilesRecursive(targetPath, cancellationToken);
          } else if (targetStats.isFile()) {
            filesToProcess = [targetPath];
          } else {
            throw new Error("The selected path is not a regular file or directory.");
          }

          if (filesToProcess.length === 0) {
            throw new Error("No files found to ingest in the selected scope.");
          }

          throwIfCancelled(cancellationToken);
          progress.report({ message: "Generating repository digest..." });

          const digestConfig: DigestConfig = {
            workspaceRoot,
            repoName: repoSlug,
            sectionSeparator: "\n\n"
          };

          const digestGenerator = new DigestGenerator(
            { getFileContent: ContentProcessor.getFileContent },
            {
              estimate: TokenAnalyzer.estimate,
              formatEstimate: TokenAnalyzer.formatEstimate,
              warnIfExceedsLimit: TokenAnalyzer.warnIfExceedsLimit
            }
          );

          const digestResult = await digestGenerator.generate(
            filesToProcess.map((filePath) => ({ path: filePath })),
            digestConfig
          );

          return {
            digest: digestResult.fullContent,
            repoSlug,
            sha,
            totalTokens: digestResult.totalTokens,
            diagnostics: digestResult.diagnostics
          } satisfies IngestOutcome;
        } finally {
          if (tempDir) {
            try {
              await rm(tempDir, { recursive: true, force: true });
            } catch (cleanupError) {
              const cleanupMessage =
                cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
              services.diagnostics.add(`Cleanup warning: ${cleanupMessage}`);
            }
          }
        }
      });
    } catch (error) {
      if (error instanceof vscode.CancellationError) {
        services.diagnostics.add("Remote ingestion cancelled by the user.");
        return;
      }

      const message = error instanceof Error ? error.message : String(error);
      services.diagnostics.add(`Remote ingestion failed: ${message}`);
      void vscode.window.showErrorMessage(`Code Ingest: Failed to ingest repository. ${message}`);
      return;
    }

    if (!outcome) {
      return;
    }

    for (const diagnostic of outcome.diagnostics) {
      services.diagnostics.add(diagnostic);
    }

    const document = await vscode.workspace.openTextDocument({
      language: "markdown",
      content: outcome.digest
    });

    await vscode.window.showTextDocument(document, { preview: false });

    services.diagnostics.add(
      `Remote digest generated for ${outcome.repoSlug}@${outcome.sha} (${outcome.totalTokens} tokens).`
    );

    const formattedTokens = TokenAnalyzer.formatEstimate(outcome.totalTokens);
    void vscode.window.showInformationMessage(
      `Code Ingest: Generated digest for ${outcome.repoSlug} @ ${outcome.sha} (${formattedTokens}).`
    );
  });

  context.subscriptions.push(disposable);
}
