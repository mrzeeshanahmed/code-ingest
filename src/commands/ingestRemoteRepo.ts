import * as vscode from "vscode";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { readdir, rm, stat } from "node:fs/promises";

import { COMMAND_MAP } from "./commandMap";
import type { CommandRegistrar, CommandServices } from "./types";
import { authenticate, partialClone, resolveRefToSha } from "../services/githubService";
import { spawnGitPromise } from "../utils/procRedact";
import { DigestGenerator } from "../services/digestGenerator";
import type { DigestResult } from "../services/digestGenerator";
import { ContentProcessor, type BinaryFilePolicy } from "../services/contentProcessor";
import { TokenAnalyzer } from "../services/tokenAnalyzer";
import { GitignoreService } from "../services/gitignoreService";
import { FilterService } from "../services/filterService";
import { FileScanner } from "../services/fileScanner";
import { NotebookProcessor } from "../services/notebookProcessor";
import { ConfigurationService } from "../services/configurationService";
import { ErrorReporter } from "../services/errorReporter";
import { DEFAULT_CONFIG } from "../config/constants";
import { formatDigest } from "../utils/digestFormatters";
import type { Logger } from "../utils/gitProcessManager";
import { wrapError } from "../utils/errorHandling";

let remoteIngestQueue: Promise<void> = Promise.resolve();
const inFlightRemoteIngestions = new Map<string, Promise<{ ok: boolean; reason?: string }>>();

function enqueueRemoteIngestion<T>(task: () => Promise<T>): Promise<T> {
  const run = remoteIngestQueue.then(() => task());
  remoteIngestQueue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

const EXCLUDED_DIRECTORIES = new Set([".git", "node_modules"]);
const MAX_PREVIEW_LENGTH = 60_000;

interface RemoteRepoPayload {
  readonly repoUrl?: string;
  readonly ref?: string;
  readonly sparsePaths?: string[];
}

interface NormalizedRemoteOptions {
  readonly repoUrl: string;
  readonly repoSlug: string;
  readonly ref: string;
  readonly sparsePaths: string[];
}

function createRemoteRunId(options: NormalizedRemoteOptions): string {
  const hash = createHash("sha256");
  hash.update(options.repoUrl.trim().toLowerCase());
  hash.update("|");
  hash.update(options.ref.trim().toLowerCase());
  if (options.sparsePaths.length > 0) {
    const normalizedPaths = [...options.sparsePaths]
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0)
      .sort((a, b) => a.localeCompare(b));
    for (const entry of normalizedPaths) {
      hash.update("|");
      hash.update(entry);
    }
  }
  return hash.digest("hex");
}

function formatLogContext(context?: Record<string, unknown>): string {
  if (!context) {
    return "";
  }

  try {
    const serialized = JSON.stringify(context);
    return serialized && serialized !== "{}" ? ` ${serialized}` : "";
  } catch {
    return "";
  }
}

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

function normalizeSparsePaths(input: unknown): string[] {
  if (!Array.isArray(input)) {
    return [];
  }
  const normalized = new Set<string>();
  for (const entry of input) {
    if (typeof entry !== "string") {
      continue;
    }
    const sanitized = normalizeSubpath(entry);
    if (sanitized) {
      normalized.add(sanitized);
    }
  }
  return Array.from(normalized);
}

function raisePayloadError(message: string, origin: "webview" | "extension", services: CommandServices): never {
  services.diagnostics.add(`Remote ingest rejected: ${message}`);
  if (origin === "webview") {
    services.webviewPanelManager.sendCommand(COMMAND_MAP.HOST_TO_WEBVIEW.SHOW_ERROR, {
      title: "Remote ingestion failed",
      message
    });
    const error = new Error(message);
    (error as { handledByHost?: boolean }).handledByHost = true;
    throw error;
  }
  void vscode.window.showErrorMessage(`Code Ingest: ${message}`);
  throw new Error(message);
}

async function promptForRemoteOptions(services: CommandServices): Promise<NormalizedRemoteOptions | undefined> {
  const repoUrl = await vscode.window.showInputBox({
    title: "Ingest Remote Repository",
    prompt: "Enter the full GitHub repository URL (e.g. https://github.com/owner/repo).",
    placeHolder: "https://github.com/owner/repository",
    ignoreFocusOut: true
  });

  if (!repoUrl || !repoUrl.trim()) {
    services.diagnostics.add("Ingest remote repo command cancelled at repository URL step.");
    return undefined;
  }

  const trimmedRepoUrl = repoUrl.trim();
  let repoSlug: string;
  try {
    repoSlug = parseRepoSlug(trimmedRepoUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    services.diagnostics.add(`Ingest remote repo aborted: ${message}`);
    void vscode.window.showErrorMessage(`Code Ingest: ${message}`);
    return undefined;
  }

  const gitRef = await vscode.window.showInputBox({
    title: "Select Git Reference",
    prompt: "Enter the branch, tag, or commit SHA you want to ingest.",
    placeHolder: "main",
    ignoreFocusOut: true
  });

  if (!gitRef || !gitRef.trim()) {
    services.diagnostics.add("Ingest remote repo command cancelled at git reference step.");
    return undefined;
  }

  const subpath = await vscode.window.showInputBox({
    title: "Optional Subpath",
    prompt: "Provide a relative path within the repository to focus on (leave blank for entire repository).",
    placeHolder: "src/",
    ignoreFocusOut: true
  });

  if (typeof subpath === "undefined") {
    services.diagnostics.add("Ingest remote repo command cancelled at subpath step.");
    return undefined;
  }

  const trimmedRef = gitRef.trim();
  const trimmedSubpath = subpath.trim();
  const normalizedSubpath = normalizeSubpath(trimmedSubpath);

  return {
    repoUrl: trimmedRepoUrl,
    repoSlug,
    ref: trimmedRef,
    sparsePaths: normalizedSubpath ? [normalizedSubpath] : []
  };
}

async function validatePayloadOptions(
  payload: RemoteRepoPayload,
  origin: "webview" | "extension",
  services: CommandServices
): Promise<NormalizedRemoteOptions> {
  const repoUrlValue = typeof payload.repoUrl === "string" ? payload.repoUrl.trim() : "";
  if (!repoUrlValue) {
    raisePayloadError("A repository URL is required for remote ingestion.", origin, services);
  }

  let repoSlug: string;
  try {
    repoSlug = parseRepoSlug(repoUrlValue);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    raisePayloadError(message, origin, services);
  }

  const refValueRaw = typeof payload.ref === "string" ? payload.ref.trim() : "";
  const refValue = refValueRaw.length > 0 ? refValueRaw : "main";
  const sparsePaths = normalizeSparsePaths(payload.sparsePaths ?? []);

  return {
    repoUrl: repoUrlValue,
    repoSlug,
    ref: refValue,
    sparsePaths
  };
}

async function resolveRemoteOptions(
  payload: RemoteRepoPayload | undefined,
  origin: "webview" | "extension",
  services: CommandServices
): Promise<NormalizedRemoteOptions | undefined> {
  const hasPayload = Boolean(
    payload &&
      ((typeof payload.repoUrl === "string" && payload.repoUrl.trim().length > 0) ||
        (typeof payload.ref === "string" && payload.ref.trim().length > 0) ||
        (Array.isArray(payload.sparsePaths) && payload.sparsePaths.length > 0))
  );

  if (hasPayload) {
    return validatePayloadOptions(payload ?? {}, origin, services);
  }

  return promptForRemoteOptions(services);
}

function clampPreview(content: string): { text: string; truncated: boolean } {
  if (content.length <= MAX_PREVIEW_LENGTH) {
    return { text: content, truncated: false };
  }
  return {
    text: `${content.slice(0, MAX_PREVIEW_LENGTH)}\n\n… (preview truncated)`,
    truncated: true
  };
}

function buildPreviewFromOutcome(outcome: IngestOutcome) {
  const { text, truncated } = clampPreview(outcome.digest);
  const overview = outcome.digestResult.content.summary.overview;

  return {
    runId: outcome.runId,
    title: `Remote digest · ${outcome.repoSlug}`,
    subtitle: `${overview.includedFiles} files · ${overview.totalTokens} tokens`,
    content: text,
    truncated,
    tokenCount: {
      total: outcome.totalTokens
    },
    metadata: outcome.digestResult.content.metadata
  } as const;
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
  return files.sort((a, b) => a.localeCompare(b));
}

interface IngestOutcome {
  digest: string;
  digestResult: DigestResult;
  repoSlug: string;
  sha: string;
  totalTokens: number;
  diagnostics: string[];
  workspaceRoot: string;
  runId: string;
}

export function registerIngestRemoteRepoCommand(
  context: vscode.ExtensionContext,
  services: CommandServices,
  registerCommand: CommandRegistrar
): void {
  const executeIngestion = async (
    options: NormalizedRemoteOptions,
    runId: string
  ): Promise<{ ok: boolean; reason?: string }> => {
    const repoSlug = options.repoSlug;
    const trimmedRef = options.ref;
    const normalizedSubpath = options.sparsePaths[0] ?? "";

    if (options.sparsePaths.length > 1) {
      services.diagnostics.add(
        `Remote ingestion received ${options.sparsePaths.length} focus paths; using "${normalizedSubpath}" and ignoring ${options.sparsePaths.length - 1} additional entr${options.sparsePaths.length - 1 === 1 ? "y" : "ies"}.`
      );
    }

    services.diagnostics.add(
      `Starting remote ingestion for ${repoSlug}@${trimmedRef}${
        normalizedSubpath ? ` (subpath: ${normalizedSubpath})` : ""
      }.`
    );

    await services.webviewPanelManager.createAndShowPanel();
    services.webviewPanelManager.setStateSnapshot({
      activeRunId: runId,
      status: "digest-running",
      preview: null,
      progress: {
        runId,
        phase: "ingest",
        percent: undefined,
        message: "Preparing remote ingestion…",
        busy: true,
        filesProcessed: 0,
        totalFiles: 0
      }
    });

    let outcome: IngestOutcome | undefined;
    try {
      outcome = await vscode.window.withProgress<IngestOutcome>({
        location: vscode.ProgressLocation.Notification,
        title: `Code Ingest: Ingesting ${repoSlug}@${trimmedRef}`,
        cancellable: true
      }, async (progress, cancellationToken) => {
        let tempDir: string | undefined;
        let token: string | undefined;

        const updatePanelProgress = (message: string) => {
          const safeMessage = message || "Remote ingestion in progress…";
          services.webviewPanelManager.setStateSnapshot({
            activeRunId: runId,
            status: "digest-running",
            progress: {
              runId,
              phase: "ingest",
              percent: undefined,
              message: safeMessage,
              busy: true,
              filesProcessed: 0,
              totalFiles: 0
            }
          });
          progress.report({ message: safeMessage });
        };

        throwIfCancelled(cancellationToken);
        updatePanelProgress("Authenticating with GitHub…");
        token = await authenticate();
        if (!token) {
          throw new Error("GitHub authentication failed or was cancelled.");
        }

        throwIfCancelled(cancellationToken);
        updatePanelProgress("Resolving repository reference…");
        const sha = await resolveRefToSha(repoSlug, trimmedRef, token);

        throwIfCancelled(cancellationToken);
        updatePanelProgress("Cloning repository (blobless)…");
        const { tempDir: cloneDir } = await partialClone(repoSlug, token);
        tempDir = cloneDir;

        try {
          throwIfCancelled(cancellationToken);
          updatePanelProgress("Fetching requested reference…");

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
          updatePanelProgress("Checking out target commit…");
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
          updatePanelProgress("Preparing ingestion pipeline…");

          const uniqueFiles = Array.from(new Set(filesToProcess.map((filePath) => path.resolve(filePath))));
          const configurationMessages: string[] = [];
          const configurationService = new ConfigurationService(
            {
              ...DEFAULT_CONFIG,
              workspaceRoot,
              repoName: repoSlug,
              include: ["**/*"],
              exclude: [".git/**", "node_modules/**"],
              sectionSeparator: "\n\n"
            },
            {
              addError: (message: string) => configurationMessages.push(`config error: ${message}`),
              addWarning: (message: string) => configurationMessages.push(`config warning: ${message}`)
            }
          );

          const resolvedConfig = configurationService.loadConfig();
          const maxFiles = resolvedConfig.maxFiles ?? uniqueFiles.length;
          const selectedFiles = uniqueFiles.slice(0, maxFiles);
          if (selectedFiles.length < uniqueFiles.length) {
            configurationMessages.push(
              `config warning: File list truncated to ${selectedFiles.length} entries (maxFiles=${maxFiles}).`
            );
          }

          const gitignoreService = new GitignoreService();
          const filterService = new FilterService({ workspaceRoot, gitignoreService });
          const fileScanner = new FileScanner(vscode.Uri.file(workspaceRoot));
          const processor = new ContentProcessor();
          const analyzer = new TokenAnalyzer({ includeDefaultAdapters: true, enableCaching: true });
          const outputChannel = vscode.window.createOutputChannel("Code Ingest: Remote Repo");
          const logger: Logger = {
            debug: (message, context) => outputChannel.appendLine(`[debug] ${message}${formatLogContext(context)}`),
            info: (message, context) => outputChannel.appendLine(`[info] ${message}${formatLogContext(context)}`),
            warn: (message, context) => outputChannel.appendLine(`[warn] ${message}${formatLogContext(context)}`),
            error: (message, context) => outputChannel.appendLine(`[error] ${message}${formatLogContext(context)}`)
          };
          const errorReporter = new ErrorReporter(configurationService, logger);

          try {
            throwIfCancelled(cancellationToken);
            updatePanelProgress("Generating repository digest…");

            const digestGenerator = new DigestGenerator(
              fileScanner,
              filterService,
              processor,
              NotebookProcessor,
              analyzer,
              configurationService,
              errorReporter
            );

            const digestResult = await digestGenerator.generateDigest({
              selectedFiles,
              outputFormat: "markdown",
              applyRedaction: true,
              includeMetadata: true,
              binaryFilePolicy: (resolvedConfig.binaryFilePolicy ?? "skip") as BinaryFilePolicy,
              maxFiles,
              progressCallback: (update) => {
                if (cancellationToken.isCancellationRequested) {
                  throw new vscode.CancellationError();
                }

                const segments = [
                  `Phase: ${update.phase}`,
                  update.totalFiles ? `${update.filesProcessed}/${update.totalFiles} files` : undefined,
                  update.tokensProcessed ? `${update.tokensProcessed} tokens` : undefined
                ].filter(Boolean);

                updatePanelProgress(segments.join(" · "));
              }
            });

            const formattedDigest = formatDigest(digestResult, { format: "markdown" });
            const pipelineDiagnostics = [
              ...configurationMessages,
              ...digestResult.statistics.warnings.map((warning) => `warning: ${warning}`),
              ...digestResult.statistics.errors.map((error) => `error: ${error}`)
            ];

            return {
              digest: formattedDigest,
              digestResult,
              repoSlug,
              sha,
              totalTokens: digestResult.statistics.totalTokens,
              diagnostics: pipelineDiagnostics,
              workspaceRoot,
              runId
            } satisfies IngestOutcome;
          } finally {
            outputChannel.dispose();
          }
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
        services.webviewPanelManager.setStateSnapshot({
          activeRunId: runId,
          progress: {
            runId,
            phase: "ingest",
            percent: undefined,
            message: "Remote ingestion cancelled",
            busy: false,
            filesProcessed: 0,
            totalFiles: 0,
            cancellable: false,
            cancelled: true
          },
          status: "ingest-cancelled"
        });
        services.diagnostics.add("Remote ingestion cancelled by the user.");
        return { ok: false, reason: "cancelled" };
      }

      const wrapped = wrapError(error, {
        command: "ingestRemoteRepo",
        stage: "pipeline",
        repoSlug,
        ref: trimmedRef,
        runId
      });
      const message = wrapped.message ?? "Remote ingestion failed";
      services.webviewPanelManager.setStateSnapshot({
        activeRunId: runId,
        progress: null,
        status: null
      });
      services.webviewPanelManager.sendCommand(COMMAND_MAP.HOST_TO_WEBVIEW.SHOW_ERROR, {
        title: "Remote ingestion failed",
        message,
        runId
      });
      services.diagnostics.add(`Remote ingestion failed: ${message}`);
      services.errorReporter.report(wrapped, {
        source: "ingestRemoteRepo",
        command: "ingestRemoteRepo",
        metadata: { repoSlug, ref: trimmedRef, runId }
      });
      void vscode.window.showErrorMessage(`Code Ingest: Failed to ingest repository. ${message}`);
      (wrapped as { handledByHost?: boolean }).handledByHost = true;
      throw wrapped;
    }

    if (!outcome) {
      return { ok: false, reason: "unknown" };
    }

    const preview = buildPreviewFromOutcome(outcome);
    const overview = outcome.digestResult.content.summary.overview;
    services.webviewPanelManager.setStateSnapshot({
      activeRunId: outcome.runId,
      preview,
      progress: null,
      status: "digest-ready",
      lastDigest: {
        runId: outcome.runId,
        generatedAt: outcome.digestResult.content.metadata.generatedAt.toISOString(),
        redactionApplied: outcome.digestResult.redactionApplied,
        truncationApplied: outcome.digestResult.truncationApplied,
        totalTokens: outcome.digestResult.statistics.totalTokens,
        totalFiles: overview.includedFiles
      }
    });

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

    return { ok: true };
  };

  const createHandler = (origin: "webview" | "extension") => async (...args: unknown[]) => {
    const payload = (args[0] ?? undefined) as RemoteRepoPayload | undefined;
    const options = await resolveRemoteOptions(payload, origin, services);
    if (!options) {
      return;
    }

    const runId = createRemoteRunId(options);
    const existingRun = inFlightRemoteIngestions.get(runId);
    if (existingRun) {
      return existingRun;
    }

    const runPromise = enqueueRemoteIngestion(() => executeIngestion(options, runId));
    inFlightRemoteIngestions.set(runId, runPromise);

    const cleanup = () => {
      const active = inFlightRemoteIngestions.get(runId);
      if (active === runPromise) {
        inFlightRemoteIngestions.delete(runId);
      }
    };
    runPromise.then(cleanup, cleanup);

    return runPromise;
  };

  registerCommand(COMMAND_MAP.EXTENSION_ONLY.INGEST_REMOTE_REPO, createHandler("extension"));
  registerCommand(COMMAND_MAP.WEBVIEW_TO_HOST.LOAD_REMOTE_REPO, createHandler("webview"));
}

export const __testing = {
  enqueueRemoteIngestion,
  resetRemoteIngestQueue: () => {
    remoteIngestQueue = Promise.resolve();
  }
};
