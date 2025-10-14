import * as path from "node:path";
import * as vscode from "vscode";

import { COMMAND_MAP } from "./commandMap";
import type { CommandServices } from "./types";
import { DigestGenerator, type DigestResult, type GenerationProgress } from "../services/digestGenerator";
import { ContentProcessor } from "../services/contentProcessor";
import { TokenAnalyzer } from "../services/tokenAnalyzer";
import { FilterService } from "../services/filterService";
import type { FilterConfigurationSnapshot } from "../services/filterService";
import { FileScanner } from "../services/fileScanner";
import { NotebookProcessor } from "../services/notebookProcessor";
import { createFormatter } from "../formatters/factory";
import type { WriteProgress } from "../services/outputWriter";

const MAX_PREVIEW_LENGTH = 60_000;

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

function resolveOutputFormat(value: string | undefined): "markdown" | "json" | "text" {
  if (value === "json" || value === "text") {
    return value;
  }
  return "markdown";
}

function buildPreview(result: DigestResult, format: "markdown" | "json" | "text", renderedOverride?: string) {
  const rendered = renderedOverride ?? createFormatter(format).finalize(result);
  const { text, truncated } = clampPreview(rendered);
  const overview = result.content.summary.overview;

  return {
    title:
      format === "json"
        ? "Digest Preview (JSON)"
        : format === "text"
          ? "Digest Preview (Text)"
          : "Digest Preview",
    subtitle: `${overview.includedFiles} files · ${overview.totalTokens} tokens${result.redactionApplied ? " · redacted" : ""}`,
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

  if (value.startsWith("file://")) {
    try {
      value = vscode.Uri.parse(value).fsPath;
    } catch {
      value = value.slice("file://".length);
    }
  }

  if (path.isAbsolute(value)) {
    const relative = path.relative(workspaceFsPath, value);
    if (!relative || relative === "." || relative.startsWith("..")) {
      return null;
    }
    value = relative;
  }

  const normalized = value.split(path.sep).join("/");
  if (!normalized || normalized === "." || normalized.startsWith("../") || normalized.startsWith("..\\")) {
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
  services: CommandServices
): void {
  const handler = async (payload?: GenerateDigestPayload) => {
    const workspaceRoot = services.workspaceManager.getWorkspaceRoot();
    if (!workspaceRoot) {
      void vscode.window.showWarningMessage("Code Ingest: Open a workspace folder before generating a digest.");
      return;
    }

    const workspaceFsPath = workspaceRoot.fsPath;

    const payloadSelection = Array.isArray(payload?.selectedFiles)
      ? normalizeSelectionInput(payload?.selectedFiles, workspaceFsPath)
      : undefined;

    const existingSelection = normalizeSelectionInput(services.workspaceManager.getSelection(), workspaceFsPath);
    const normalizedSelection = payloadSelection && payloadSelection.length > 0 ? payloadSelection : existingSelection;

    let relativeSelection = services.workspaceManager.setSelection(normalizedSelection);
    services.webviewPanelManager.setStateSnapshot({ selection: relativeSelection }, { emit: false });

    const { valid: accessibleSelection, missing } = await validateSelection(relativeSelection, workspaceRoot);
    if (missing.length > 0) {
      const sanitizedSelection = services.workspaceManager.setSelection(accessibleSelection);
      relativeSelection = sanitizedSelection;
      services.webviewPanelManager.setStateSnapshot({ selection: sanitizedSelection });

      const missingPreview = missing.slice(0, 5).join(", ");
      const overflowSuffix = missing.length > 5 ? ` …(+${missing.length - 5})` : "";
      services.diagnostics.add(
        `Selection pruning: skipped ${missing.length} missing file(s): ${missingPreview}${overflowSuffix}`
      );
      const plural = missing.length === 1 ? "" : "s";
      void vscode.window.showWarningMessage(
        `Code Ingest: Skipped ${missing.length} missing file${plural} before generating the digest.`
      );
    }

    if (relativeSelection.length === 0) {
      void vscode.window.showInformationMessage("Code Ingest: Select one or more files before generating a digest.");
      return;
    }

    await services.webviewPanelManager.createAndShowPanel();

    const absoluteSelection = relativeSelection.map((relPath) => path.resolve(workspaceFsPath, relPath));
    const configSnapshot = services.configurationService.getConfig();
    const outputFormat = resolveOutputFormat(payload?.outputFormat ?? configSnapshot.outputFormat);
    const redactionOverride = Boolean(
      payload?.redactionOverride ?? services.workspaceManager.getRedactionOverride()
    );
    services.workspaceManager.setRedactionOverride(redactionOverride);
    const applyRedaction = !redactionOverride;

    services.webviewPanelManager.setStateSnapshot({
      config: { ...configSnapshot, redactionOverride },
      redactionOverride
    });

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

      const renderedOutput = createFormatter(outputFormat).finalize(result);
      const preview = buildPreview(result, outputFormat, renderedOutput);
      let writeResult: Awaited<ReturnType<typeof services.outputWriter.writeOutput>> | undefined;

      const handleWriteProgress = (progress: WriteProgress) => {
        if (progress.phase === "complete") {
          services.webviewPanelManager.setStateSnapshot({ progress: null, status: "digest-ready" });
          return;
        }

        const totalBytes = progress.totalBytes > 0 ? progress.totalBytes : progress.bytesWritten;
        const percent = totalBytes > 0 ? Math.min(100, Math.round((progress.bytesWritten / totalBytes) * 100)) : undefined;

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
        const target = services.outputWriter.resolveConfiguredTarget(outputFormat);
        writeResult = await services.outputWriter.writeOutput({
          target,
          content: renderedOutput,
          format: outputFormat,
          overwrite: false,
          progressCallback: handleWriteProgress
        });
      } catch (writeError) {
        const message = writeError instanceof Error ? writeError.message : String(writeError);
        services.diagnostics.add(`Digest generated but failed to write output: ${message}`);
        services.errorReporter.report(writeError, {
          source: "generateDigest",
          metadata: { stage: "writeOutput" }
        });
        void vscode.window.showWarningMessage(`Code Ingest: Digest generated but failed to write output: ${message}`);
      }

      services.webviewPanelManager.setStateSnapshot({
        preview,
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
      services.diagnostics.add(`Digest generation failed: ${message}`);
      services.errorReporter.report(error, { source: "generateDigest" });
      services.webviewPanelManager.sendCommand(COMMAND_MAP.HOST_TO_WEBVIEW.SHOW_ERROR, {
        title: "Digest failed",
        message
      });
    }
  };

  const disposable = vscode.commands.registerCommand(COMMAND_MAP.WEBVIEW_TO_HOST.GENERATE_DIGEST, handler);
  context.subscriptions.push(disposable);
}
