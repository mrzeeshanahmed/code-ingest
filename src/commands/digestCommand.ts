import * as path from "node:path";
import * as vscode from "vscode";
import { createFormatter } from "../formatters/factory";
import { ContentProcessor } from "../services/contentProcessor";
import { Diagnostics } from "../services/diagnostics";
import { DigestGenerator, GenerationProgress } from "../services/digestGenerator";
import { ErrorReporter } from "../services/errorReporter";
import { FileScanner } from "../services/fileScanner";
import { FilterService } from "../services/filterService";
import { GitignoreService } from "../services/gitignoreService";
import { NotebookProcessor } from "../services/notebookProcessor";
import { OutputWriter } from "../services/outputWriter";
import { TokenAnalyzer } from "../services/tokenAnalyzer";
import { ConfigurationService } from "../services/configurationService";
import type { Logger } from "../utils/gitProcessManager";

export interface DigestCommandDependencies {
  outputChannel: vscode.OutputChannel;
  errorChannel: vscode.OutputChannel;
}

function resolveOutputFormat(value: string | undefined): "markdown" | "json" | "text" {
  if (value === "json" || value === "text") {
    return value;
  }

  return "markdown";
}

function resolveBinaryPolicy(value: string | undefined): "skip" | "base64" | "placeholder" {
  if (value === "base64" || value === "placeholder") {
    return value;
  }

  return "skip";
}

function createLogger(channel: vscode.OutputChannel): Logger {
  return {
    debug: (message, context) => channel.appendLine(`[debug] ${message}${context ? ` ${JSON.stringify(context)}` : ""}`),
    info: (message, context) => channel.appendLine(`[info] ${message}${context ? ` ${JSON.stringify(context)}` : ""}`),
    warn: (message, context) => channel.appendLine(`[warn] ${message}${context ? ` ${JSON.stringify(context)}` : ""}`),
    error: (message, context) => channel.appendLine(`[error] ${message}${context ? ` ${JSON.stringify(context)}` : ""}`)
  };
}

export function registerDigestCommand(context: vscode.ExtensionContext, deps: DigestCommandDependencies): void {
  const handler = async (): Promise<void> => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      void vscode.window.showWarningMessage("Open a workspace to generate a digest.");
      return;
    }

    const diagnostics = new Diagnostics();
    const configService = new ConfigurationService(undefined, {
      addError: (message) => diagnostics.add(message),
      addWarning: (message) => diagnostics.add(message)
    });
    const logger = createLogger(deps.errorChannel);
    const errorReporter = new ErrorReporter(configService, logger);
    const gitignoreService = new GitignoreService();
    const fileScanner = new FileScanner(folder.uri);
    const filterService = new FilterService({
      workspaceRoot: folder.uri.fsPath,
      gitignoreService
    });
    const outputWriter = new OutputWriter({
      errorReporter,
      errorChannel: deps.errorChannel
    });

    const config = ConfigurationService.getWorkspaceConfig(folder, {
      addError: (message) => diagnostics.add(message),
      addWarning: (message) => diagnostics.add(message)
    });

    const candidates = (await fileScanner.scan({ maxEntries: config.maxFiles }))
      .filter((entry) => entry.type === "file" && entry.relPath)
      .map((entry) => path.resolve(folder.uri.fsPath, entry.relPath!));

    const generator = new DigestGenerator(
      fileScanner,
      filterService,
      new ContentProcessor(),
      NotebookProcessor,
      new TokenAnalyzer({ includeDefaultAdapters: true, enableCaching: true }),
      configService,
      errorReporter
    );

    const progressReporter = (progress: GenerationProgress) => {
      deps.outputChannel.appendLine(`[digest] ${progress.phase} ${progress.filesProcessed}/${progress.totalFiles} ${progress.currentFile ?? ""}`.trim());
    };

    const outputFormat = resolveOutputFormat(config.outputFormat);
    const binaryPolicy = resolveBinaryPolicy(config.binaryFilePolicy);

    const digestOptions: Parameters<typeof generator.generateDigest>[0] = {
      selectedFiles: candidates,
      outputFormat,
      maxTokens: 16_000,
      includeMetadata: true,
      applyRedaction: true,
      binaryFilePolicy: binaryPolicy,
      progressCallback: progressReporter
    };
    if (typeof config.maxFiles === "number") {
      digestOptions.maxFiles = config.maxFiles;
    }

    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Code-Ingest: Generating digest",
        cancellable: false
      },
      async () => generator.generateDigest(digestOptions)
    );

    const formatter = createFormatter(outputFormat);
    const content = formatter.finalize(result);
    const target = outputWriter.resolveConfiguredTarget(outputFormat);
    const writeResult = await outputWriter.writeOutput({
      target,
      content,
      format: outputFormat,
      overwrite: false
    });

    if (!writeResult.success) {
      void vscode.window.showErrorMessage(`Digest generated but could not be written: ${writeResult.error}`);
      return;
    }

    void vscode.window.showInformationMessage("Digest generated successfully.");
  };

  context.subscriptions.push(vscode.commands.registerCommand("code-ingest.generateDigest", handler));
  context.subscriptions.push(vscode.commands.registerCommand("codeIngest.generateDigest", handler));
}
