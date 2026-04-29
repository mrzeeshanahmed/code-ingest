import { createHash } from "node:crypto";
import * as path from "node:path";
import * as vscode from "vscode";

import { COMMAND_MAP } from "./commandMap";
import type { CommandHandler, CommandRegistrar, CommandServices } from "./types";
import { DigestGenerator, type DigestResult, type GenerationProgress } from "../services/digestGenerator";
import { ContentProcessor } from "../services/contentProcessor";
import { TokenAnalyzer } from "../services/tokenAnalyzer";
import { FilterService } from "../services/filterService";
import type { FilterConfigurationSnapshot } from "../services/filterService";
import { createSkipStatsMap, recordFilterOutcome as recordFilterDiagnostic, buildSkipMessages } from "../services/filterDiagnostics";
import { FileScanner } from "../services/fileScanner";
import { NotebookProcessor } from "../services/notebookProcessor";
import { createFormatter } from "../formatters/factory";
import type { WriteProgress, WriteResult } from "../services/outputWriter";

const MAX_PREVIEW_LENGTH = 60_000;
const DIGEST_SELECTION_REJECTED = "DIGEST_SELECTION_REJECTED";

const inFlightDigestRuns = new Map<string, Promise<void>>();

function buildDigestKey(
  workspaceFsPath: string,
  selection: readonly string[],
  format: string,
  applyRedaction: boolean
): string {
  const workspaceResolved = path.resolve(workspaceFsPath);
  const normalizedSelection = selection.map((entry) => path.normalize(entry));
  return JSON.stringify({
    workspace: workspaceResolved,
    selection: normalizedSelection,
    format,
    applyRedaction
  });
}

function clearInFlightDigests(): void {
  inFlightDigestRuns.clear();
}

function getInFlightDigestCount(): number {
  return inFlightDigestRuns.size;
}

function createPreviewId(
  workspaceFsPath: string,
  selection: readonly string[],
  format: string,
  applyRedaction: boolean
): string {
  const hash = createHash("sha1");
  hash.update(path.resolve(workspaceFsPath));
  hash.update("\n");
  for (const entry of selection) {
    hash.update(entry);
    hash.update("\n");
  }
  hash.update(format);
  hash.update(applyRedaction ? "1" : "0");
  return `preview-${hash.digest("hex").slice(0, 32)}`;
}

interface GenerateDigestPayload {
  readonly selectedFiles?: string[];
  readonly outputFormat?: "markdown" | "json" | "text";
  readonly redactionOverride?: boolean;
}

const PROGRESS_MESSAGES: Record<GenerationProgress["phase"], string> = {
  scanning: "Scanning workspace…",
  processing: "Filtering files…",
  analyzing: "Analyzing tokens…",
  generating: "Assembling digest…",
  formatting: "Formatting output…",
  complete: "Digest ready"
};

const PROGRESS_PHASE_MAP: Record<GenerationProgress["phase"], "scan" | "filter" | "tokenize" | "ingest" | "write"> = {
  scanning: "scan",
  processing: "filter",
  analyzing: "tokenize",
  generating: "ingest",
  formatting: "write",
  complete: "write"
};

function clampPreview(content: string): { text: string; truncated: boolean } {
  if (content.length <= MAX_PREVIEW_LENGTH) {
    return { text: content, truncated: false };
  }
  return { text: `${content.slice(0, MAX_PREVIEW_LENGTH)}\n\n… (preview truncated)`, truncated: true };
}

async function collectPreviewFromStream(
  createStream: () => AsyncIterable<string>,
  limit: number
): Promise<PreviewOverride> {
  const iterator = createStream()[Symbol.asyncIterator]();
  let collected = "";
  let truncated = false;
  const finalize = (value: string, wasTruncated: boolean): PreviewOverride => {
    const { text, truncated: clampTruncated } = clampPreview(value);
    return { text, truncated: wasTruncated || clampTruncated };
  };

  try {
    while (collected.length < limit) {
      const { value, done } = await iterator.next();
      if (done) {
        return finalize(collected, truncated);
      }
      const chunk = typeof value === "string" ? value : String(value ?? "");
      if (collected.length + chunk.length <= limit) {
        collected += chunk;
        continue;
      }

      const remaining = Math.max(0, limit - collected.length);
      collected += chunk.slice(0, remaining);
      truncated = true;
      if (typeof iterator.return === "function") {
        await iterator.return(undefined);
      }
      return finalize(collected, true);
    }

    const peek = await iterator.next();
    if (!peek.done) {
      truncated = true;
      if (typeof peek.value === "string" && collected.length < limit) {
        const remaining = limit - collected.length;
        collected += peek.value.slice(0, remaining);
      }
      if (typeof iterator.return === "function") {
        await iterator.return(undefined);
      }
    }
  } catch (error) {
    if (typeof iterator.throw === "function") {
      try {
        await iterator.throw(error);
      } catch {
        // ignore secondary errors when cleaning up
      }
    }
    throw error;
  }

  return finalize(collected, truncated);
}

function resolveOutputFormat(value: string | undefined): "markdown" | "json" | "text" {
  if (value === "json" || value === "text") {
    return value;
  }
  return "markdown";
}

interface PreviewOverride {
  readonly text: string;
  readonly truncated: boolean;
}

function buildPreview(
  result: DigestResult,
  format: "markdown" | "json" | "text",
  renderedOverride?: string,
  previewOverride?: PreviewOverride
) {
  const overview = result.content.summary.overview;
  const subtitle = `${overview.includedFiles} files · ${overview.totalTokens} tokens${result.redactionApplied ? " · redacted" : ""}`;

  if (previewOverride) {
    return {
      title:
        format === "json"
          ? "Digest Preview (JSON)"
          : format === "text"
            ? "Digest Preview (Text)"
            : "Digest Preview",
      subtitle,
      content: previewOverride.text,
      truncated: previewOverride.truncated,
      tokenCount: {
        total: result.statistics.totalTokens
      },
      metadata: result.content.metadata
    } as const;
  }

  const rendered = renderedOverride ?? createFormatter(format).finalize(result);
  const { text, truncated } = clampPreview(rendered);

  return {
    title:
      format === "json"
        ? "Digest Preview (JSON)"
        : format === "text"
          ? "Digest Preview (Text)"
          : "Digest Preview",
    subtitle,
    content: text,
    truncated,
    tokenCount: {
      total: result.statistics.totalTokens
    },
    metadata: result.content.metadata
  } as const;
}

function mapProgress(progress: GenerationProgress) {
  const percent =
    progress.totalFiles > 0
      ? Math.min(100, Math.round((progress.filesProcessed / progress.totalFiles) * 100))
      : undefined;
  const message = progress.currentFile
    ? `Processing ${path.basename(progress.currentFile)}`
    : PROGRESS_MESSAGES[progress.phase];

  return {
    phase: PROGRESS_PHASE_MAP[progress.phase],
    percent,
    message,
    busy: progress.phase !== "complete",
    filesProcessed: progress.filesProcessed,
    totalFiles: progress.totalFiles
  } as const;
}

function normalizeRelativePath(candidate: string | undefined, workspaceFsPath: string): string | null {
  if (typeof candidate !== "string") {
    return null;
  }

  let value = candidate.trim();
  if (value.length === 0) {
    return null;
  }

  const fileSchemePattern = /^file:\/\//i;
  if (fileSchemePattern.test(value)) {
    try {
      const parsed = vscode.Uri.parse(value).fsPath;
      if (typeof parsed === "string" && parsed.length > 0) {
        value = parsed;
      }
    } catch {
      value = value.slice("file://".length);
    }
  }

  if (fileSchemePattern.test(value)) {
    value = value.replace(fileSchemePattern, "");
  }

  if (path.sep === "\\" && value.startsWith("/") && /^[A-Za-z]:/.test(value.slice(1))) {
    value = value.slice(1);
  }

  if (path.isAbsolute(value)) {
    const workspaceResolved = path.resolve(workspaceFsPath);
    const normalizedAbsolute = path.normalize(value);
    const relative = path.relative(workspaceResolved, normalizedAbsolute);
    if (!relative || relative === "." || relative.startsWith("..")) {
      return null;
    }
    value = relative;
  }

  let normalized = value.replace(/\\/g, "/");
  if (normalized.startsWith("./")) {
    normalized = normalized.slice(2);
  }
  if (!normalized || normalized === "." || normalized.startsWith("../") || normalized.startsWith("..\\") || normalized.startsWith("/")) {
    return null;
  }

  if (/^[A-Za-z]:/.test(normalized)) {
    return null;
  }

  return normalized;
}

function normalizeSelectionInput(selection: unknown, workspaceFsPath: string): string[] {
  if (!Array.isArray(selection)) {
    return [];
  }

  const unique = new Set<string>();
  for (const entry of selection) {
    const normalized = normalizeRelativePath(typeof entry === "string" ? entry : undefined, workspaceFsPath);
    if (normalized) {
      unique.add(normalized);
    }
  }
  return Array.from(unique).sort((a, b) => a.localeCompare(b));
}

function selectionsEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) {
      return false;
    }
  }
  return true;
}

async function validateSelection(
  relativePaths: readonly string[],
  workspaceRoot: vscode.Uri
): Promise<{ valid: string[]; missing: string[] }> {
  if (relativePaths.length === 0) {
    return { valid: [], missing: [] };
  }

  const valid: string[] = [];
  const missing: string[] = [];

  for (const relative of relativePaths) {
    if (typeof relative !== "string" || relative.length === 0) {
      continue;
    }

    const segments = relative.split("/").filter((segment) => segment.length > 0);
    const fileUri = vscode.Uri.joinPath(workspaceRoot, ...segments);

    try {
      await vscode.workspace.fs.stat(fileUri);
      valid.push(relative);
    } catch {
      missing.push(relative);
    }
  }

  return { valid, missing };
}

export function registerGenerateDigestCommand(
  context: vscode.ExtensionContext,
  services: CommandServices,
  registerCommand: CommandRegistrar
): void {
  const handler: CommandHandler = async (...args: unknown[]) => {
    const payload = (args[0] ?? undefined) as GenerateDigestPayload | undefined;
    const workspaceRoot = services.workspaceManager.getWorkspaceRoot();
    if (!workspaceRoot) {
      void vscode.window.showWarningMessage("Code Ingest: Open a workspace folder before generating a digest.");
      return;
    }

    const workspaceFsPath = workspaceRoot.fsPath;

    let payloadSelection: string[] | undefined;
    let selectionFromPayload = false;
    const selectionCandidates = payload?.selectedFiles;
    if (Array.isArray(selectionCandidates)) {
      selectionFromPayload = true;
      payloadSelection = normalizeSelectionInput(selectionCandidates, workspaceFsPath);
    }

    const preAwaitSelection = normalizeSelectionInput(services.workspaceManager.getSelection(), workspaceFsPath);

    const existingSelectionSnapshot = normalizeSelectionInput(
      await services.workspaceManager.awaitSelectionSnapshot(),
      workspaceFsPath
    );

    if (preAwaitSelection.length === 0 && existingSelectionSnapshot.length > 0) {
      services.diagnostics.add(
        `Digest request waited for active selection to settle (${existingSelectionSnapshot.length} file(s) recovered).`
      );
    }

    let normalizedSelection = selectionFromPayload ? payloadSelection ?? [] : existingSelectionSnapshot;
    if (selectionFromPayload && normalizedSelection.length === 0 && existingSelectionSnapshot.length > 0) {
      services.diagnostics.add(
        `Digest request payload empty; falling back to active selection containing ${existingSelectionSnapshot.length} file(s).`
      );
      normalizedSelection = existingSelectionSnapshot;
      selectionFromPayload = false;
    }

    const { valid: accessibleSelection, missing } = await validateSelection(normalizedSelection, workspaceRoot);
    let finalSelection = accessibleSelection;

    const shouldUpdateManager = selectionFromPayload || !selectionsEqual(finalSelection, existingSelectionSnapshot);
    let relativeSelection: string[];
    if (shouldUpdateManager) {
      relativeSelection = services.workspaceManager.setSelection(finalSelection);
    } else {
      relativeSelection = finalSelection;
    }

    services.webviewPanelManager.setStateSnapshot({ selection: relativeSelection });

    if (missing.length > 0) {
      const missingPreview = missing.slice(0, 5).join(", ");
      const overflowSuffix = missing.length > 5 ? ` …(+${missing.length - 5})` : "";
      services.diagnostics.add(
        `Selection pruning: skipped ${missing.length} missing file(s): ${missingPreview}${overflowSuffix}`
      );
      const plural = missing.length === 1 ? "" : "s";
      void vscode.window.showWarningMessage(
        `Code Ingest: Skipped ${missing.length} missing file${plural} before generating the digest.`
      );

      if (selectionFromPayload && relativeSelection.length === 0) {
        const message = missing.length === 1
          ? `The requested file "${missing[0]}" is not available in this workspace.`
          : "None of the requested files are available in this workspace.";
        services.diagnostics.add(`Digest request rejected: ${message}`);
        services.webviewPanelManager.sendCommand(COMMAND_MAP.HOST_TO_WEBVIEW.SHOW_ERROR, {
          title: "No files available",
          message
        });
        const rejectionError = new Error(message);
        (rejectionError as { code?: string }).code = DIGEST_SELECTION_REJECTED;
        (rejectionError as { handledByHost?: boolean }).handledByHost = true;
        throw rejectionError;
      }
    }

    if (relativeSelection.length === 0) {
      const message = "Select one or more files before generating a digest.";
      if (selectionFromPayload) {
        services.diagnostics.add("Digest request rejected: selection empty after normalization.");
        services.webviewPanelManager.sendCommand(COMMAND_MAP.HOST_TO_WEBVIEW.SHOW_ERROR, {
          title: "No files selected",
          message
        });
        const rejectionError = new Error(message);
        (rejectionError as { code?: string }).code = DIGEST_SELECTION_REJECTED;
        (rejectionError as { handledByHost?: boolean }).handledByHost = true;
        throw rejectionError;
      }
      void vscode.window.showInformationMessage(`Code Ingest: ${message}`);
      return;
    }

    let absoluteSelection = relativeSelection.map((relPath) => path.resolve(workspaceFsPath, relPath));
    const configSnapshot = services.configurationService.getConfig();

    const filterService = new FilterService({
      workspaceRoot: workspaceRoot.fsPath,
      gitignoreService: services.gitignoreService,
      loadConfiguration: (): FilterConfigurationSnapshot => ({
        ...(Array.isArray(configSnapshot.include) ? { includePatterns: configSnapshot.include } : {}),
        ...(Array.isArray(configSnapshot.exclude) ? { excludePatterns: configSnapshot.exclude } : {}),
        ...(typeof configSnapshot.followSymlinks === "boolean" ? { followSymlinks: configSnapshot.followSymlinks } : {}),
        ...(typeof configSnapshot.respectGitIgnore === "boolean" ? { respectGitignore: configSnapshot.respectGitIgnore } : {}),
        ...(typeof configSnapshot.maxDepth === "number" ? { maxDepth: configSnapshot.maxDepth } : {})
      })
    });

    const selectionFilterOptions = {
      includePatterns: configSnapshot.include ?? [],
      excludePatterns: configSnapshot.exclude ?? [],
      useGitignore: configSnapshot.respectGitIgnore ?? true,
      followSymlinks: configSnapshot.followSymlinks ?? false,
      ...(typeof configSnapshot.maxDepth === "number" ? { maxDepth: configSnapshot.maxDepth } : {})
    } as const;

    const selectionResults = await filterService.batchFilter(absoluteSelection, selectionFilterOptions);
    const selectionSkipStats = createSkipStatsMap();
    const filteredAbsoluteSelection: string[] = [];
    const filteredRelativeSelection: string[] = [];

    absoluteSelection.forEach((absolutePath) => {
      const result = selectionResults.get(absolutePath);
      const relativePath = path.relative(workspaceFsPath, absolutePath) || path.basename(absolutePath);
      const normalizedRelative = relativePath.split(path.sep).join("/");

      if (!result || result.included) {
        filteredAbsoluteSelection.push(absolutePath);
        filteredRelativeSelection.push(normalizedRelative);
        return;
      }

      recordFilterDiagnostic(selectionSkipStats, normalizedRelative, result);
    });

    const filteredOutCount = relativeSelection.length - filteredRelativeSelection.length;
    if (filteredOutCount > 0) {
      const plural = filteredOutCount === 1 ? "" : "s";
      services.diagnostics.add(
        `Selection filtering: skipped ${filteredOutCount} selected file${plural} due to configuration filters.`
      );
      const selectionMessages = buildSkipMessages(selectionSkipStats, {
        followSymlinks: configSnapshot.followSymlinks ?? false,
        ...(typeof configSnapshot.maxDepth === "number" ? { maxDepth: configSnapshot.maxDepth } : {})
      });
      for (const message of selectionMessages) {
        services.diagnostics.add(`Selection filtering: ${message}`);
      }
      void vscode.window.showWarningMessage(
        `Code Ingest: Skipped ${filteredOutCount} selected file${plural} due to current filters.`
      );

      relativeSelection = filteredRelativeSelection;
      absoluteSelection = filteredAbsoluteSelection;
      const normalizedSelection = services.workspaceManager.setSelection(relativeSelection);
      relativeSelection = normalizedSelection;
      absoluteSelection = relativeSelection.map((relPath) => path.resolve(workspaceFsPath, relPath));
      services.webviewPanelManager.setStateSnapshot({ selection: relativeSelection });
    }

    if (relativeSelection.length === 0) {
      const message = "All selected files are excluded by the current include/exclude or gitignore settings.";
      services.diagnostics.add(`Digest request rejected: ${message}`);
      services.webviewPanelManager.sendCommand(COMMAND_MAP.HOST_TO_WEBVIEW.SHOW_ERROR, {
        title: "No files available",
        message
      });
      const rejectionError = new Error(message);
      (rejectionError as { code?: string }).code = DIGEST_SELECTION_REJECTED;
      (rejectionError as { handledByHost?: boolean }).handledByHost = true;
      throw rejectionError;
    }

    const outputFormat = resolveOutputFormat(payload?.outputFormat ?? configSnapshot.outputFormat);
    const redactionOverride = Boolean(
      payload?.redactionOverride ?? services.workspaceManager.getRedactionOverride()
    );
    const applyRedaction = !redactionOverride;
    const previewId = createPreviewId(workspaceFsPath, relativeSelection, outputFormat, applyRedaction);
    const digestKey = buildDigestKey(workspaceFsPath, absoluteSelection, outputFormat, applyRedaction);
    const existingRun = inFlightDigestRuns.get(digestKey);
    if (existingRun) {
      services.diagnostics.add(
        `Digest request joined existing run (${relativeSelection.length} file(s), format: ${outputFormat}).`
      );
      return existingRun;
    }

    const ensurePreviewContent = (content: string | undefined, stage: string): void => {
      const previewText = typeof content === "string" ? content.trim() : "";
      if (previewText.length > 0) {
        return;
      }

      const diagnosticMessage = `Digest preview empty (previewId=${previewId}, format=${outputFormat}, stage=${stage}).`;
      services.diagnostics.add(diagnosticMessage);
      const message = "Digest preview could not be generated. Check selection and try again.";
      services.webviewPanelManager.sendCommand(COMMAND_MAP.HOST_TO_WEBVIEW.SHOW_ERROR, {
        title: "Preview unavailable",
        message
      });
      void vscode.window.showErrorMessage(`Code Ingest: ${message}`);

      const previewError = new Error(message);
      (previewError as { handledByHost?: boolean }).handledByHost = true;
      (previewError as { code?: string }).code = "DIGEST_PREVIEW_EMPTY";
      throw previewError;
    };

    const runDigest = async () => {
      services.workspaceManager.setRedactionOverride(redactionOverride);
      services.webviewPanelManager.setStateSnapshot({
        config: { ...configSnapshot, redactionOverride },
        redactionOverride
      });

      await services.webviewPanelManager.createAndShowPanel();

      const digestGenerator = new DigestGenerator(
        new FileScanner(workspaceRoot),
        filterService,
        new ContentProcessor(),
        NotebookProcessor,
        new TokenAnalyzer({ includeDefaultAdapters: true, enableCaching: true }),
        services.configurationService,
        services.errorReporter
      );

      const updateProgress = (progress: GenerationProgress | null) => {
        const state: Record<string, unknown> = {
          progress: progress ? mapProgress(progress) : null
        };
        if (progress && progress.phase !== "complete") {
          state.status = "digest-running";
        }
        services.webviewPanelManager.setStateSnapshot(state);
      };

      const initialProgress: GenerationProgress = {
        phase: "scanning",
        filesProcessed: 0,
        totalFiles: 0,
        tokensProcessed: 0,
        timeElapsed: 0
      };
      updateProgress(initialProgress);

      try {
        const result = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "Code Ingest: Generating digest",
            cancellable: false
          },
          async () => {
            const options: Parameters<typeof digestGenerator.generateDigest>[0] = {
              selectedFiles: absoluteSelection,
              outputFormat,
              applyRedaction,
              includeMetadata: true,
              binaryFilePolicy: configSnapshot.binaryFilePolicy as "skip" | "base64" | "placeholder",
              progressCallback: (progress) => {
                updateProgress(progress);
              }
            };

            if (typeof configSnapshot.maxFiles === "number") {
              options.maxFiles = configSnapshot.maxFiles;
            }

            return digestGenerator.generateDigest(options);
          }
        );

        updateProgress(null);

        const formatter = createFormatter(outputFormat);
        const formatterSupportsStreaming =
          typeof (formatter as { supportsStreaming?: () => boolean }).supportsStreaming === "function" &&
          Boolean((formatter as { supportsStreaming: () => boolean }).supportsStreaming());

        let renderedOutput: string | undefined;
        let previewOverride: PreviewOverride | undefined;
        let writeResult: WriteResult | undefined;

        const target = services.outputWriter.resolveConfiguredTarget(outputFormat);

        const handleWriteProgress = (progress: WriteProgress) => {
          if (progress.phase === "complete") {
            services.webviewPanelManager.setStateSnapshot({ progress: null, status: "digest-ready" });
            return;
          }

          const totalBytes = progress.totalBytes > 0 ? progress.totalBytes : progress.bytesWritten;
          const percent =
            totalBytes > 0 ? Math.min(100, Math.round((progress.bytesWritten / totalBytes) * 100)) : undefined;

          services.webviewPanelManager.setStateSnapshot({
            progress: {
              phase: "write",
              percent,
              message: progress.currentOperation,
              busy: true,
              filesProcessed: progress.bytesWritten,
              totalFiles: totalBytes
            },
            status: "digest-writing"
          });
        };

        try {
          if (
            formatterSupportsStreaming &&
            typeof (formatter as { streamSectionsAsync?: (digest: DigestResult) => AsyncIterable<string> }).streamSectionsAsync === "function"
          ) {
            const createStream = () =>
              (formatter as { streamSectionsAsync: (digest: DigestResult) => AsyncIterable<string> }).streamSectionsAsync(
                result
              );
            previewOverride = await collectPreviewFromStream(createStream, MAX_PREVIEW_LENGTH);
            ensurePreviewContent(previewOverride.text, "stream");

            writeResult = await services.outputWriter.writeStream({
              target,
              contentStream: createStream(),
              format: outputFormat,
              progressCallback: handleWriteProgress
            });
          } else {
            renderedOutput = formatter.finalize(result);
            ensurePreviewContent(renderedOutput, "finalize");
            writeResult = await services.outputWriter.writeOutput({
              target,
              content: renderedOutput,
              format: outputFormat,
              overwrite: false,
              progressCallback: handleWriteProgress
            });
          }
        } catch (writeError) {
          const message = writeError instanceof Error ? writeError.message : String(writeError);
          services.diagnostics.add(`Digest generated but failed to write output: ${message}`);
          services.errorReporter.report(writeError, {
            source: "generateDigest",
            metadata: { stage: "writeOutput" }
          });
          void vscode.window.showWarningMessage(`Code Ingest: Digest generated but failed to write output: ${message}`);
        }

        const preview = buildPreview(result, outputFormat, renderedOutput, previewOverride);
        ensurePreviewContent(preview.content, "emit");
        const previewState = {
          ...preview,
          id: previewId,
          format: outputFormat
        };
        const previewLength = typeof preview.content === "string" ? preview.content.length : 0;
        const previewLogTarget = writeResult?.target?.type ?? target.type ?? "unknown";
        services.webviewPanelManager.sendCommand(COMMAND_MAP.HOST_TO_WEBVIEW.UPDATE_PREVIEW, {
          previewId,
          title: preview.title,
          subtitle: preview.subtitle,
          content: preview.content,
          tokenCount: preview.tokenCount,
          truncated: preview.truncated,
          format: outputFormat,
          metadata: preview.metadata
        });
        services.diagnostics.add(
          `Digest preview prepared (previewId=${previewId}, target=${previewLogTarget}, length=${previewLength}, truncated=${preview.truncated ? "yes" : "no"}).`
        );

        services.webviewPanelManager.setStateSnapshot({
          preview: previewState,
          status: "digest-ready",
          selection: services.workspaceManager.getSelection(),
          lastDigest: {
            generatedAt: result.content.metadata.generatedAt.toISOString(),
            redactionApplied: result.redactionApplied,
            truncationApplied: result.truncationApplied,
            totalTokens: result.statistics.totalTokens,
            totalFiles: result.content.summary.overview.includedFiles,
            ...(writeResult?.success
              ? {
                  outputTarget:
                    writeResult.uri?.fsPath ?? writeResult.target.path ?? writeResult.target.type,
                  outputBytes: writeResult.bytesWritten,
                  outputDurationMs: Math.round(writeResult.writeTime)
                }
              : {})
          }
        });

        const baseMessage = `Digest generated (${result.content.summary.overview.includedFiles} files, ${result.statistics.totalTokens} tokens).`;
        if (writeResult?.success) {
          const location = writeResult.uri?.fsPath ?? writeResult.target.path ?? writeResult.target.type;
          services.diagnostics.add(`${baseMessage} Output target: ${location}.`);
          void vscode.window.showInformationMessage(
            `Code Ingest: Digest ready and written to ${location}.`
          );
        } else {
          services.diagnostics.add(baseMessage);
          void vscode.window.showInformationMessage(
            `Code Ingest: Digest ready (${result.content.summary.overview.includedFiles} files).`
          );
        }
      } catch (error) {
        updateProgress(null);
        const message = error instanceof Error ? error.message : String(error);
        const errorCode = typeof error === "object" && error !== null ? (error as { code?: string }).code : undefined;

        const handledByHost = typeof error === "object" && error !== null && (error as { handledByHost?: boolean }).handledByHost === true;

        if (errorCode !== DIGEST_SELECTION_REJECTED && !handledByHost) {
          services.diagnostics.add(`Digest generation failed: ${message}`);
          services.errorReporter.report(error, { source: "generateDigest" });
          if (error instanceof Error) {
            (error as { showError?: { title: string; message: string } }).showError = {
              title: "Digest failed",
              message
            };
          }
        }

        throw error;
      }
    };

    const digestPromise = runDigest().finally(() => {
      inFlightDigestRuns.delete(digestKey);
    });
    inFlightDigestRuns.set(digestKey, digestPromise);
    return digestPromise;
  };

  registerCommand(COMMAND_MAP.WEBVIEW_TO_HOST.GENERATE_DIGEST, handler);
  registerCommand(COMMAND_MAP.WEBVIEW_TO_HOST.REFRESH_PREVIEW, () => handler());
}

export const __testing = {
  normalizeRelativePath,
  normalizeSelectionInput,
  selectionsEqual,
  clearInFlightDigests,
  getInFlightDigestCount
};