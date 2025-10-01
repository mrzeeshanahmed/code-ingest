import * as vscode from "vscode";

export interface ErrorReportContext {
  readonly source?: string;
  readonly command?: string;
  readonly metadata?: Record<string, unknown>;
}

interface ErrorReportEntry {
  readonly timestamp: string;
  readonly message: string;
  readonly stack?: string;
  readonly context?: ErrorReportContext;
}

const MAX_BUFFER_SIZE = 100;

export class ErrorReporter implements vscode.Disposable {
  private readonly buffer: ErrorReportEntry[] = [];

  constructor(private readonly channel: vscode.OutputChannel) {}

  report(error: unknown, context?: ErrorReportContext): void {
    const entry = this.createEntry(error, context);
    this.buffer.push(entry);
    if (this.buffer.length > MAX_BUFFER_SIZE) {
      this.buffer.shift();
    }

    this.channel.appendLine(`[${entry.timestamp}] ${entry.message}`);
    if (entry.stack) {
      this.channel.appendLine(entry.stack);
    }

    if (entry.context) {
      this.channel.appendLine(`context: ${JSON.stringify(entry.context)}`);
    }
    this.channel.appendLine("");
  }

  flush(): void {
    if (this.buffer.length === 0) {
      this.channel.appendLine("[error-reporter] No buffered errors to flush.");
      return;
    }

    this.channel.appendLine("[error-reporter] Flushing buffered errors:");
    for (const entry of this.buffer) {
      this.channel.appendLine(`[${entry.timestamp}] ${entry.message}`);
      if (entry.stack) {
        this.channel.appendLine(entry.stack);
      }
      if (entry.context) {
        this.channel.appendLine(`context: ${JSON.stringify(entry.context)}`);
      }
      this.channel.appendLine("");
    }
    this.buffer.length = 0;
  }

  dispose(): void {
    this.flush();
    this.channel.dispose();
  }

  private createEntry(error: unknown, context?: ErrorReportContext): ErrorReportEntry {
    const timestamp = new Date().toISOString();
    const message = error instanceof Error ? error.message : typeof error === "string" ? error : JSON.stringify(error);
    const stack = error instanceof Error ? error.stack : undefined;

    return {
      timestamp,
      message,
      ...(stack ? { stack } : {}),
      ...(context ? { context } : {})
    };
  }
}
