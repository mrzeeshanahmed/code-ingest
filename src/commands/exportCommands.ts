import * as path from "node:path";
import * as vscode from "vscode";
import { ExportController, ExportMode } from "../services/exportController";
import { PIIService, PIIPolicyMode } from "../services/security/piiService";
import { GraphDatabase } from "../graph/database/GraphDatabase";
import { DigestGenerator } from "../services/digestGenerator";
import { FileScanner } from "../services/fileScanner";
import { FilterService } from "../services/filterService";
import { GitignoreService } from "../services/gitignoreService";
import { ContentProcessor } from "../services/contentProcessor";
import { NotebookProcessor } from "../services/notebookProcessor";
import { TokenAnalyzer } from "../services/tokenAnalyzer";
import { ConfigurationService } from "../services/configurationService";
import { ErrorReporter } from "../services/errorReporter";
import { Diagnostics } from "../services/diagnostics";
import { OutputWriter } from "../services/outputWriter";
import { COMMAND_MAP } from "./commandMap";
import { getGraphSettings } from "../config/graphSettings";

export interface ExportCommandDependencies {
  outputChannel: vscode.OutputChannel;
  errorChannel: vscode.OutputChannel;
  graphDatabase: GraphDatabase;
}

export function registerExportCommands(context: vscode.ExtensionContext, deps: ExportCommandDependencies): void {
  const handler = async (mode: ExportMode, piiPolicyStr?: string): Promise<void> => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      void vscode.window.showWarningMessage("Open a workspace to export code.");
      return;
    }

    const diagnostics = new Diagnostics();
    const configService = new ConfigurationService(undefined, {
      addError: (message) => diagnostics.add(message),
      addWarning: (message) => diagnostics.add(message)
    });
    
    const logger = {
      debug: (msg: string) => deps.outputChannel.appendLine(`[debug] ${msg}`),
      info: (msg: string) => deps.outputChannel.appendLine(`[info] ${msg}`),
      warn: (msg: string) => deps.errorChannel.appendLine(`[warn] ${msg}`),
      error: (msg: string) => deps.errorChannel.appendLine(`[error] ${msg}`)
    };
    
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

    const generator = new DigestGenerator(
      fileScanner,
      filterService,
      new ContentProcessor(),
      NotebookProcessor,
      new TokenAnalyzer({ includeDefaultAdapters: true, enableCaching: true }),
      configService,
      errorReporter
    );

    const piiService = new PIIService();
    const exportController = new ExportController(folder.uri, generator, deps.graphDatabase, piiService);

    const piiPolicy = Object.values(PIIPolicyMode).find(p => p === piiPolicyStr) ?? PIIPolicyMode.Strict;

    const outputFormat = config.outputFormat === "json" || config.outputFormat === "text" ? config.outputFormat : "markdown";

    const digestOptions: Parameters<typeof generator.generateDigest>[0] = {
      selectedFiles: (await fileScanner.scan({ maxEntries: config.maxFiles }))
        .filter((entry) => entry.type === "file" && entry.relPath)
        .map((entry) => path.resolve(folder.uri.fsPath, entry.relPath!)),
      outputFormat,
      maxTokens: 16_000,
      includeMetadata: true,
      applyRedaction: false, // Handled by PIIService for Clean/Graph
      binaryFilePolicy: config.binaryFilePolicy as any
    };

    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Code-Ingest: Generating ${mode} export`,
        cancellable: false
      },
      async () => exportController.export({
        mode,
        piiPolicy,
        settings: getGraphSettings(folder),
        format: outputFormat,
        digestOptions
      })
    );

    const target = outputWriter.resolveConfiguredTarget(outputFormat);
    
    // For modes like clean and graph, the result is already text (ContextBuilder output).
    // Export raw generates digest object, but our controller returns string. Wait, ContextBuilder returns text. Let's make DigestGenerator return string.
    
    const writeResult = await outputWriter.writeOutput({
      target,
      content: result,
      format: outputFormat,
      overwrite: false
    });

    if (!writeResult.success) {
      void vscode.window.showErrorMessage(`Export generated but could not be written: ${writeResult.error}`);
      return;
    }

    void vscode.window.showInformationMessage(`${mode} export generated successfully.`);
  };

  context.subscriptions.push(vscode.commands.registerCommand(COMMAND_MAP.WEBVIEW_TO_HOST.EXPORT_RAW, () => handler(ExportMode.Raw)));
  context.subscriptions.push(vscode.commands.registerCommand(COMMAND_MAP.WEBVIEW_TO_HOST.EXPORT_CLEAN, (policy) => handler(ExportMode.Clean, policy)));
  context.subscriptions.push(vscode.commands.registerCommand(COMMAND_MAP.WEBVIEW_TO_HOST.EXPORT_GRAPH, (policy) => handler(ExportMode.Graph, policy)));
}
