import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as vscode from "vscode";

import { ConfigurationService } from "./configurationService";
import { ErrorClassifier, ErrorSeverity, type ErrorClassification, type ErrorContext } from "../utils/errorHandler";
import type { Logger } from "../utils/gitProcessManager";

export interface ErrorReportContext {
  readonly source?: string;
  readonly command?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface ErrorReport {
  id: string;
  timestamp: Date;
  error: {
    name: string;
    message: string;
    stack?: string;
  };
  context: ErrorContext & {
    errorId: string;
    classification: ErrorClassification;
  };
  classification: ErrorClassification;
  environment: EnvironmentInfo;
  userAgent: string;
  sessionId: string;
}

export interface EnvironmentInfo {
  vscodeVersion: string;
  extensionVersion: string;
  platform: string;
  nodeVersion: string;
  workspaceSize?: number;
  memoryUsage: NodeJS.MemoryUsage;
}

interface CrashLogConfiguration {
  enableCrashLog: boolean;
  crashLogPath?: string;
  enableTelemetry: boolean;
}

const DEFAULT_BUFFER_SIZE = 100;
const DEFAULT_FLUSH_INTERVAL = 5 * 60 * 1000;

export class ErrorReporter implements vscode.Disposable {
  private errorBuffer: ErrorReport[] = [];
  private readonly maxBufferSize: number = DEFAULT_BUFFER_SIZE;
  private readonly flushInterval: number = DEFAULT_FLUSH_INTERVAL;
  private readonly sessionId: string;
  private flushTimer?: NodeJS.Timeout;
  private readonly classifier = new ErrorClassifier();

  constructor(private readonly configService: ConfigurationService, private readonly logger: Logger) {
    this.sessionId = this.generateSessionId();
    this.startPeriodicFlush();
  }

  report(error: unknown, context?: ErrorReportContext): void {
    const normalized = this.normalizeError(error);
    const errorContext: ErrorContext = {
      operation: context?.command ?? context?.source ?? "unknown",
      component: context?.source ?? "errorReporter",
      userFacing: false
    };

    if (context?.metadata) {
      errorContext.metadata = context.metadata;
    }

    try {
      const classification = this.classifier.classifyError(normalized, errorContext);
      const errorId = `LEGACY-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
      void this.reportError(normalized, {
        ...errorContext,
        errorId,
        classification
      }).catch(() => undefined);
    } catch (reportingError) {
      this.logger.warn("Legacy error report failed", { message: (reportingError as Error).message });
    }
  }

  async reportError(error: Error, context: ErrorContext & { errorId: string; classification: ErrorClassification }): Promise<void> {
    const report = await this.buildReport(error, context);

    this.errorBuffer.push(report);
    if (this.errorBuffer.length > this.maxBufferSize) {
      this.errorBuffer = this.errorBuffer.slice(-this.maxBufferSize);
    }

    this.logger.error(`Error reported: ${context.errorId}`, {
      category: context.classification.category,
      severity: context.classification.severity
    });

    if (context.classification.severity === ErrorSeverity.CRITICAL) {
      await this.flushErrors();
    }
  }

  async flushErrors(): Promise<void> {
    if (this.errorBuffer.length === 0) {
      return;
    }

    const crashConfig = this.getCrashLogConfiguration();
    if (!crashConfig.enableCrashLog) {
      this.errorBuffer = [];
      return;
    }

    try {
      if (crashConfig.crashLogPath) {
        await this.writeErrorsToFile(crashConfig.crashLogPath);
      }

      if (crashConfig.enableTelemetry) {
        await this.sendToTelemetry();
      }

      this.errorBuffer = [];
    } catch (error) {
      this.logger.warn("Failed to flush error reports", { message: (error as Error).message });
    }
  }

  getErrorBuffer(): ErrorReport[] {
    return [...this.errorBuffer];
  }

  clearErrorBuffer(): void {
    this.errorBuffer = [];
  }

  dispose(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
    }

    this.flushErrors().catch((error) => {
      this.logger.warn("Failed to flush errors on dispose", { message: (error as Error).message });
    });
  }

  private async buildReport(
    error: Error,
    context: ErrorContext & { errorId: string; classification: ErrorClassification }
  ): Promise<ErrorReport> {
    const errorPayload: ErrorReport["error"] = {
      name: error.name,
      message: error.message
    };

    if (error.stack) {
      errorPayload.stack = error.stack;
    }

    return {
      id: context.errorId,
      timestamp: new Date(),
      error: errorPayload,
      context,
      classification: context.classification,
      environment: await this.gatherEnvironmentInfo(),
      userAgent: this.getUserAgent(),
      sessionId: this.sessionId
    };
  }

  private async writeErrorsToFile(logPath: string): Promise<void> {
    const logDirectory = path.dirname(logPath);
    await fs.mkdir(logDirectory, { recursive: true });

    const payload = {
      timestamp: new Date().toISOString(),
      sessionId: this.sessionId,
      platform: os.platform(),
      reports: this.errorBuffer
    };

    const serialized = JSON.stringify(payload, null, 2) + "\n";
    await fs.appendFile(logPath, serialized, { encoding: "utf8" });
  }

  private async sendToTelemetry(): Promise<void> {
    // Placeholder for future telemetry integration.
  }

  private async gatherEnvironmentInfo(): Promise<EnvironmentInfo> {
    const extension = vscode.extensions.getExtension("publisher.code-ingest");
    const configSnapshot = this.safeLoadConfig();

    const environment: EnvironmentInfo = {
      vscodeVersion: vscode.version,
      extensionVersion: extension?.packageJSON.version ?? "unknown",
      platform: process.platform,
      nodeVersion: process.version,
      memoryUsage: process.memoryUsage()
    };

    if (typeof configSnapshot?.maxFiles === "number") {
      environment.workspaceSize = configSnapshot.maxFiles;
    }

    return environment;
  }

  private safeLoadConfig(): { maxFiles?: number } | undefined {
    try {
      const snapshot = this.configService.loadConfig();
      const maxFiles = (snapshot as { maxFiles?: number }).maxFiles;
      return typeof maxFiles === "number" ? { maxFiles } : {};
    } catch (error) {
      this.logger.warn("Failed to load configuration for error reporting", { message: (error as Error).message });
      return undefined;
    }
  }

  private getUserAgent(): string {
    const extension = vscode.extensions.getExtension("publisher.code-ingest");
    return `CodeIngest/${extension?.packageJSON.version ?? "unknown"} VSCode/${vscode.version}`;
  }

  private startPeriodicFlush(): void {
    this.flushTimer = setInterval(() => {
      this.flushErrors().catch((error) => {
        this.logger.warn("Periodic error flush failed", { message: (error as Error).message });
      });
    }, this.flushInterval);
  }

  private getCrashLogConfiguration(): CrashLogConfiguration {
    const config = vscode.workspace.getConfiguration("codeIngest.errorReporting");
    const crashLogPath = config.get<string | undefined>("crashLogPath") ?? undefined;

    const crashConfig: CrashLogConfiguration = {
      enableCrashLog: config.get<boolean>("enableCrashLog", false),
      enableTelemetry: config.get<boolean>("enableTelemetry", false)
    };

    if (crashLogPath) {
      crashConfig.crashLogPath = crashLogPath;
    }

    return crashConfig;
  }

  private generateSessionId(): string {
    return `session-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
  }

  private normalizeError(error: unknown): Error {
    if (error instanceof Error) {
      return error;
    }

    return new Error(this.stringifyUnknownError(error));
  }

  private stringifyUnknownError(error: unknown): string {
    if (typeof error === "string") {
      return error;
    }
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
}