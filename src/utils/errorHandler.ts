import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as https from "node:https";
import * as vscode from "vscode";

import type { Logger } from "./gitProcessManager";
import type { ErrorReporter } from "../services/errorReporter";

export interface ErrorContext {
  operation: string;
  component: string;
  metadata?: Record<string, unknown>;
  userFacing?: boolean;
  recoverable?: boolean;
  retryable?: boolean;
}

export interface ErrorHandlingResult {
  handled: boolean;
  userMessage?: string;
  shouldRetry: boolean;
  recoveryAction?: () => Promise<void>;
  reportError: boolean;
}

export interface ErrorClassification {
  category: ErrorCategory;
  severity: ErrorSeverity;
  userFriendlyMessage: string;
  technicalDetails: string;
  suggestedActions: string[];
  isRecoverable: boolean;
  isRetryable: boolean;
}

type ClassificationTemplate = Omit<ErrorClassification, "technicalDetails"> & { technicalDetails?: string };

export enum ErrorCategory {
  NETWORK = "network",
  AUTHENTICATION = "authentication",
  FILE_SYSTEM = "file_system",
  PERMISSION = "permission",
  VALIDATION = "validation",
  CONFIGURATION = "configuration",
  RESOURCE = "resource",
  TIMEOUT = "timeout",
  USER_INPUT = "user_input",
  SYSTEM = "system",
  UNKNOWN = "unknown"
}

export enum ErrorSeverity {
  LOW = "low",
  MEDIUM = "medium",
  HIGH = "high",
  CRITICAL = "critical"
}

const SEVERITY_WEIGHT: Record<ErrorSeverity, number> = {
  [ErrorSeverity.LOW]: 0,
  [ErrorSeverity.MEDIUM]: 1,
  [ErrorSeverity.HIGH]: 2,
  [ErrorSeverity.CRITICAL]: 3
};

export class ErrorClassifier {
  private readonly classificationRules = new Map<RegExp, ClassificationTemplate>();

  constructor() {
    this.initializeRules();
  }

  classifyError(error: Error, context?: ErrorContext): ErrorClassification {
    const message = error.message.toLowerCase();
    const name = error.name.toLowerCase();

    for (const [pattern, classification] of this.classificationRules) {
      if (pattern.test(message) || pattern.test(name)) {
        return {
          ...classification,
          technicalDetails: error.stack ?? error.message
        };
      }
    }

    const fallback: ErrorClassification = {
      category: ErrorCategory.UNKNOWN,
      severity: ErrorSeverity.MEDIUM,
      userFriendlyMessage: "An unexpected error occurred",
      technicalDetails: error.stack ?? error.message,
      suggestedActions: ["Please try again", "If the problem persists, check the logs"],
      isRecoverable: false,
      isRetryable: true
    };

    if (typeof context?.recoverable === "boolean") {
      fallback.isRecoverable = context.recoverable;
    }
    if (typeof context?.retryable === "boolean") {
      fallback.isRetryable = context.retryable;
    }

    return fallback;
  }

  addCustomRule(pattern: RegExp, classification: ErrorClassification): void {
    this.classificationRules.set(pattern, classification);
  }

  private initializeRules(): void {
    this.classificationRules.set(/network|connection|timeout|unreachable/i, {
      category: ErrorCategory.NETWORK,
      severity: ErrorSeverity.MEDIUM,
      userFriendlyMessage: "Network connection error",
      suggestedActions: [
        "Check your internet connection",
        "Verify the repository URL",
        "Try again in a few moments"
      ],
      isRecoverable: true,
      isRetryable: true
    });

    this.classificationRules.set(/auth|credential|permission denied|forbidden|unauthorized/i, {
      category: ErrorCategory.AUTHENTICATION,
      severity: ErrorSeverity.HIGH,
      userFriendlyMessage: "Authentication failed",
      suggestedActions: [
        "Check your credentials",
        "Verify repository access permissions",
        "Update your authentication token"
      ],
      isRecoverable: true,
      isRetryable: false
    });

    this.classificationRules.set(/enoent|file not found|directory not found|no such file/i, {
      category: ErrorCategory.FILE_SYSTEM,
      severity: ErrorSeverity.HIGH,
      userFriendlyMessage: "File or directory not found",
      suggestedActions: [
        "Verify the file path exists",
        "Check file permissions",
        "Ensure the workspace is accessible"
      ],
      isRecoverable: false,
      isRetryable: false
    });

    this.classificationRules.set(/eacces|permission|access denied/i, {
      category: ErrorCategory.PERMISSION,
      severity: ErrorSeverity.HIGH,
      userFriendlyMessage: "Permission denied",
      suggestedActions: [
        "Check file/directory permissions",
        "Run VS Code with appropriate privileges",
        "Verify you have write access to the destination"
      ],
      isRecoverable: true,
      isRetryable: false
    });

    this.classificationRules.set(/no space|disk full|out of memory|emfile|enomem/i, {
      category: ErrorCategory.RESOURCE,
      severity: ErrorSeverity.CRITICAL,
      userFriendlyMessage: "System resources exhausted",
      suggestedActions: [
        "Free up disk space",
        "Close other applications to free memory",
        "Try processing smaller files"
      ],
      isRecoverable: true,
      isRetryable: true
    });

    this.classificationRules.set(/timeout|timed out|deadline exceeded/i, {
      category: ErrorCategory.TIMEOUT,
      severity: ErrorSeverity.MEDIUM,
      userFriendlyMessage: "Operation timed out",
      suggestedActions: [
        "Try again with a longer timeout",
        "Check network connectivity",
        "Process smaller batches of files"
      ],
      isRecoverable: true,
      isRetryable: true
    });

    this.classificationRules.set(/invalid|malformed|syntax error|parse error/i, {
      category: ErrorCategory.VALIDATION,
      severity: ErrorSeverity.MEDIUM,
      userFriendlyMessage: "Invalid input or data format",
      suggestedActions: [
        "Check input format",
        "Verify configuration settings",
        "Review file contents for corruption"
      ],
      isRecoverable: false,
      isRetryable: false
    });
  }
}

export interface RecoveryStrategy {
  recover(error: Error, context: ErrorContext): Promise<void>;
  canRecover(error: Error, context: ErrorContext): boolean;
}

class NetworkRecoveryStrategy implements RecoveryStrategy {
  async recover(error: Error, context: ErrorContext): Promise<void> {
    if (context.metadata && typeof context.metadata === "object") {
      (context.metadata as Record<string, unknown>).lastNetworkError = error.message;
    }

    const maxRetries = 3;
    let attempt = 0;

    while (attempt < maxRetries) {
      await this.delay(2 ** attempt * 1000);
      try {
        await this.testConnectivity();
        return;
      } catch (connectivityError) {
        attempt += 1;
        if (attempt >= maxRetries) {
          throw new Error(`Network recovery failed after ${maxRetries} attempts: ${(connectivityError as Error).message}`);
        }
      }
    }
  }

  canRecover(error: Error): boolean {
    const msg = error.message.toLowerCase();
    return msg.includes("network") || msg.includes("timeout") || msg.includes("connection");
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async testConnectivity(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const request = https.request(
        {
          method: "HEAD",
          hostname: "api.github.com",
          path: "/",
          headers: {
            "User-Agent": "CodeIngest-ErrorHandler",
            Accept: "*/*"
          },
          timeout: 5000
        },
        (response) => {
          if (response.statusCode && response.statusCode >= 200 && response.statusCode < 500) {
            resolve();
          } else {
            reject(new Error(`Connectivity test failed with status ${response.statusCode ?? "unknown"}`));
          }
          response.resume();
        }
      );

      request.on("timeout", () => {
        request.destroy(new Error("Connectivity test timeout"));
      });

      request.on("error", (err) => {
        reject(err);
      });

      request.end();
    });
  }
}

class AuthenticationRecoveryStrategy implements RecoveryStrategy {
  async recover(error: Error, context: ErrorContext): Promise<void> {
    if (context.metadata && typeof context.metadata === "object") {
      (context.metadata as Record<string, unknown>).lastAuthError = error.message;
    }

    const result = await vscode.window.showInformationMessage(
      `Authentication failed (${error.message}). Would you like to update your credentials?`,
      "Yes",
      "No"
    );

    if (result === "Yes") {
      await vscode.commands.executeCommand("workbench.action.openSettings", "codeIngest.authentication");
    }
  }

  canRecover(error: Error): boolean {
    const msg = error.message.toLowerCase();
    return msg.includes("auth") || msg.includes("credential") || msg.includes("forbidden") || msg.includes("unauthorized");
  }
}

class FileSystemRecoveryStrategy implements RecoveryStrategy {
  async recover(error: Error, context: ErrorContext): Promise<void> {
    const filePath = this.extractFilePathFromError(error.message);
    if (!filePath) {
      throw new Error("Unable to determine file path for recovery");
    }

    const directory = path.dirname(filePath);
    await fs.mkdir(directory, { recursive: true });

    if (context.metadata && typeof context.metadata === "object") {
      (context.metadata as Record<string, unknown>).recoveredPath = directory;
    }
  }

  canRecover(error: Error, context: ErrorContext): boolean {
    return error.message.includes("ENOENT") && context.operation.toLowerCase().includes("write");
  }

  private extractFilePathFromError(message: string): string | null {
    const match = message.match(/ENOENT: no such file or directory, open '([^']+)'/i);
    return match?.[1] ?? null;
  }
}

class PermissionRecoveryStrategy implements RecoveryStrategy {
  async recover(error: Error, context: ErrorContext): Promise<void> {
    if (context.metadata && typeof context.metadata === "object") {
      (context.metadata as Record<string, unknown>).lastPermissionError = error.message;
    }

    await vscode.window.showWarningMessage(
      `Permission denied (${error.message}). Please adjust your filesystem permissions and retry.`,
      "Open Settings"
    );
    await vscode.commands.executeCommand("workbench.action.openSettings", "codeIngest.permissions");
  }

  canRecover(error: Error): boolean {
    const msg = error.message.toLowerCase();
    return msg.includes("permission") || msg.includes("access denied") || msg.includes("eacces");
  }
}

class ResourceRecoveryStrategy implements RecoveryStrategy {
  async recover(error: Error, context: ErrorContext): Promise<void> {
    if (global.gc) {
      try {
        global.gc();
      } catch {
        // ignore GC errors
      }
    }

    await this.delay(2000);

    if (context.metadata && typeof context.metadata === "object" && "batchSize" in context.metadata) {
      const current = Number((context.metadata as Record<string, unknown>).batchSize);
      if (!Number.isNaN(current) && current > 1) {
        (context.metadata as Record<string, unknown>).batchSize = Math.max(Math.floor(current / 2), 1);
      }
    }

    if (context.metadata && typeof context.metadata === "object") {
      (context.metadata as Record<string, unknown>).lastResourceError = error.message;
    }
  }

  canRecover(error: Error): boolean {
    const msg = error.message.toLowerCase();
    return msg.includes("memory") || msg.includes("space") || msg.includes("emfile");
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

class TimeoutRecoveryStrategy implements RecoveryStrategy {
  async recover(error: Error, context: ErrorContext): Promise<void> {
    if (context.metadata && typeof context.metadata === "object") {
      (context.metadata as Record<string, unknown>).timeout = Math.min(
        Number((context.metadata as Record<string, unknown>).timeout ?? 120000) * 1.5,
        600000
      );
    }
    await vscode.window.showInformationMessage(
      `Timeout detected (${error.message}). Operation timeout increased for the next attempt.`
    );
  }

  canRecover(error: Error): boolean {
    return error.message.toLowerCase().includes("timeout");
  }
}

const DEFAULT_OUTPUT_CHANNEL_NAME = "Code Ingest - Errors";

export class ErrorHandler {
  private readonly outputChannel: vscode.OutputChannel;
  private readonly classifier: ErrorClassifier;
  private readonly recoveryStrategies: Map<ErrorCategory, RecoveryStrategy>;

  constructor(private readonly errorReporter: ErrorReporter, private readonly logger: Logger) {
    this.outputChannel = vscode.window.createOutputChannel(DEFAULT_OUTPUT_CHANNEL_NAME);
    this.classifier = new ErrorClassifier();
    this.recoveryStrategies = new Map();
    this.initializeRecoveryStrategies();
  }

  async handleError(error: Error, context: ErrorContext): Promise<ErrorHandlingResult> {
    const classification = this.classifier.classifyError(error, context);
    const effectiveRecoverable = context.recoverable ?? classification.isRecoverable;
    const effectiveRetryable = context.retryable ?? classification.isRetryable;
    const errorId = this.generateErrorId();

    this.logError(errorId, error, context, classification);

    if (this.shouldReport(classification.severity)) {
      await this.errorReporter.reportError(error, {
        ...context,
        errorId,
        classification
      });
    }

    let recoveryAction: (() => Promise<void>) | undefined;
    if (effectiveRecoverable) {
      const strategy = this.recoveryStrategies.get(classification.category);
      if (strategy && strategy.canRecover(error, context)) {
        recoveryAction = () => strategy.recover(error, context);
      }
    }

    if (context.userFacing) {
      await this.showUserNotification(classification, errorId);
    }

    const result: ErrorHandlingResult = {
      handled: true,
      shouldRetry: effectiveRetryable,
      reportError: this.shouldReport(classification.severity)
    };

    if (classification.userFriendlyMessage) {
      result.userMessage = classification.userFriendlyMessage;
    }

    if (recoveryAction) {
      result.recoveryAction = recoveryAction;
    }

    return result;
  }

  getClassifier(): ErrorClassifier {
    return this.classifier;
  }

  private logError(errorId: string, error: Error, context: ErrorContext, classification: ErrorClassification): void {
    const logEntry = {
      id: errorId,
      timestamp: new Date().toISOString(),
      operation: context.operation,
      component: context.component,
      category: classification.category,
      severity: classification.severity,
      message: error.message,
      stack: error.stack,
      metadata: context.metadata,
      suggestedActions: classification.suggestedActions
    };

    this.outputChannel.appendLine(JSON.stringify(logEntry, null, 2));

    this.logger.error(`${context.component}.${context.operation}.failed`, {
      errorId,
      category: classification.category,
      severity: classification.severity,
      message: error.message
    });
  }

  private async showUserNotification(classification: ErrorClassification, errorId: string): Promise<void> {
    const actions = [...classification.suggestedActions];
    if (this.isSeverityAtLeast(classification.severity, ErrorSeverity.HIGH)) {
      actions.push("Show Details");
    }

    const selected = await vscode.window.showErrorMessage(classification.userFriendlyMessage, ...actions);
    if (selected === "Show Details") {
      this.outputChannel.show(true);
      this.outputChannel.appendLine(`Focused error: ${errorId}`);
    }
  }

  private shouldReport(severity: ErrorSeverity): boolean {
    return this.isSeverityAtLeast(severity, ErrorSeverity.HIGH);
  }

  private isSeverityAtLeast(current: ErrorSeverity, threshold: ErrorSeverity): boolean {
    return SEVERITY_WEIGHT[current] >= SEVERITY_WEIGHT[threshold];
  }

  private generateErrorId(): string {
    return `ERR-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
  }

  private initializeRecoveryStrategies(): void {
    this.recoveryStrategies.set(ErrorCategory.NETWORK, new NetworkRecoveryStrategy());
    this.recoveryStrategies.set(ErrorCategory.AUTHENTICATION, new AuthenticationRecoveryStrategy());
    this.recoveryStrategies.set(ErrorCategory.FILE_SYSTEM, new FileSystemRecoveryStrategy());
    this.recoveryStrategies.set(ErrorCategory.PERMISSION, new PermissionRecoveryStrategy());
    this.recoveryStrategies.set(ErrorCategory.RESOURCE, new ResourceRecoveryStrategy());
    this.recoveryStrategies.set(ErrorCategory.TIMEOUT, new TimeoutRecoveryStrategy());
  }
}
