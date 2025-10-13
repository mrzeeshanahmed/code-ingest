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

function buildPreview(result: DigestResult, format: "markdown" | "json" | "text") {
  const formatter = createFormatter(format);
  const rendered = formatter.finalize(result);
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

    const payloadSelection = Array.isArray(payload?.selectedFiles)
      ? payload?.selectedFiles ?? []
      : [];
    const relativeSelection = payloadSelection.length > 0
      ? payloadSelection
      : services.workspaceManager.getSelection();

    if (relativeSelection.length === 0) {
      void vscode.window.showInformationMessage("Code Ingest: Select one or more files before generating a digest.");
      return;
    }

    services.webviewPanelManager.createAndShowPanel();

    const absoluteSelection = relativeSelection.map((relPath) => path.resolve(workspaceRoot.fsPath, relPath));
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

      const preview = buildPreview(result, outputFormat);
      services.webviewPanelManager.setStateSnapshot({
        preview,
        status: "digest-ready",
        selection: services.workspaceManager.getSelection(),
        lastDigest: {
          generatedAt: result.content.metadata.generatedAt.toISOString(),
          redactionApplied: result.redactionApplied,
          truncationApplied: result.truncationApplied,
          totalTokens: result.statistics.totalTokens,
          totalFiles: result.content.summary.overview.includedFiles
        }
      });

      services.diagnostics.add(
        `Digest generated (${result.content.summary.overview.includedFiles} files, ${result.statistics.totalTokens} tokens).`
      );

      void vscode.window.showInformationMessage(
        `Code Ingest: Digest ready (${result.content.summary.overview.includedFiles} files).`
      );
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
