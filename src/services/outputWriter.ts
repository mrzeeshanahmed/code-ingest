import * as path from "node:path";
import { createHash } from "node:crypto";
import * as fsPromises from "node:fs/promises";
import { performance } from "node:perf_hooks";
import * as vscode from "vscode";

import { wrapError } from "../utils/errorHandling";
import type { ErrorReporter } from "./errorReporter";

const DEFAULT_WRITE_CHUNK_BYTES = 64 * 1024;
const STREAM_WRITE_CHUNK_BYTES = 128 * 1024;
const DEFAULT_FILENAME_TEMPLATE = "digest-{timestamp}.{format}";
const DIGEST_WRITE_OPERATION = "Writing digest file…";
const DIGEST_OPEN_OPERATION = "Opening digest file…";
const DIGEST_PREPARE_OPERATION = "Preparing digest output";

type OutputFormat = "markdown" | "json" | "text";
export type OutputTargetType = "editor" | "file" | "clipboard";

export interface OutputTarget {
  type: OutputTargetType;
  path?: string | undefined;
  title?: string | undefined;
  language?: string | undefined;
}

export interface WriteProgress {
  phase: "preparing" | "writing" | "complete";
  bytesWritten: number;
  totalBytes: number;
  currentOperation: string;
}

export interface WriteOptions {
  target: OutputTarget;
  content: string;
  format: OutputFormat;
  overwrite?: boolean | undefined;
  createDirectories?: boolean | undefined;
  progressCallback?: ((progress: WriteProgress) => void) | undefined;
  cancellationToken?: vscode.CancellationToken | undefined;
}

export interface WriteResult {
  success: boolean;
  target: OutputTarget;
  bytesWritten: number;
  uri?: vscode.Uri | undefined;
  error?: string | undefined;
  writeTime: number;
}

export interface ReadableStreamLike<T> {
  getReader(): {
    read(): Promise<{ value?: T; done: boolean }>;
    releaseLock?(): void;
  };
}

export type StreamSource = AsyncIterable<string> | Iterable<string> | ReadableStreamLike<string>;

export interface StreamWriteOptions {
  target: OutputTarget;
  contentStream: StreamSource;
  format?: OutputFormat | undefined;
  totalSize?: number | undefined;
  chunkSize?: number | undefined;
  overwrite?: boolean | undefined;
  createDirectories?: boolean | undefined;
  progressCallback?: ((progress: WriteProgress) => void) | undefined;
  cancellationToken?: vscode.CancellationToken | undefined;
}

interface OutputWriterConfiguration {
  defaultTarget: OutputTargetType;
  outputDirectory?: string | undefined;
  outputFilenameTemplate: string;
  createDirectories: boolean;
}

interface FileResolution {
  finalPath: string;
  appendToExisting: boolean;
  derivedFromTemplate: boolean;
}

interface EditorWriteContext {
  content: string;
  title?: string | undefined;
  language?: string | undefined;
  format: OutputFormat;
  cancellationToken?: vscode.CancellationToken | undefined;
  progress?: (progress: WriteProgress) => void;
}

interface FileWriteContext {
  content: string;
  target: OutputTarget;
  explicitPath?: string | undefined;
  format: OutputFormat;
  overwrite: boolean;
  createDirectories: boolean;
  configuration: OutputWriterConfiguration;
  cancellationToken?: vscode.CancellationToken | undefined;
  progress?: (progress: WriteProgress) => void;
}

interface ClipboardWriteContext {
  content: string;
  progress?: (progress: WriteProgress) => void;
}

interface StreamWriteContext {
  source: StreamSource;
  totalSize?: number | undefined;
  chunkSize: number;
  target: OutputTarget;
  format: OutputFormat;
  overwrite: boolean;
  createDirectories: boolean;
  configuration: OutputWriterConfiguration;
  cancellationToken?: vscode.CancellationToken | undefined;
  progress?: (progress: WriteProgress) => void;
}

export interface OutputWriterDependencies {
  window?: typeof vscode.window;
  workspace?: typeof vscode.workspace;
  clipboard?: vscode.Clipboard;
  clock?: () => number;
  errorReporter?: ErrorReporter;
  errorChannel?: Pick<vscode.OutputChannel, "appendLine">;
}

/**
 * Handles writing digest output to editors, files, or the clipboard while providing
 * progress reporting, cancellation awareness, and configuration-driven defaults.
 */
export class OutputWriter {
  private readonly window: typeof vscode.window;

  private readonly workspace: typeof vscode.workspace;

  private readonly clipboard: vscode.Clipboard;

  private readonly now: () => number;

  private readonly errorReporter: ErrorReporter | undefined;

  private readonly errorChannel: Pick<vscode.OutputChannel, "appendLine"> | undefined;

  public constructor(dependencies: OutputWriterDependencies = {}) {
    this.window = dependencies.window ?? vscode.window;
    this.workspace = dependencies.workspace ?? vscode.workspace;
    this.clipboard = dependencies.clipboard ?? vscode.env.clipboard;
    this.now = dependencies.clock ?? (() => performance.now());
    this.errorReporter = dependencies.errorReporter;
    this.errorChannel = dependencies.errorChannel;
  }

  /**
   * Writes content to the supplied target, coordinating configuration defaults,
   * progress updates, and cancellation hooks.
   */
  public async writeOutput(options: WriteOptions): Promise<WriteResult> {
    const configuration = this.loadConfiguration();
    const cancellationToken = options.cancellationToken;
    const progress = options.progressCallback;
    const mergedTarget = this.mergeTargetWithConfiguration(options.target, options.format, configuration);
    const start = this.now();
    let bytesWritten = 0;
    const totalBytes = Buffer.byteLength(options.content, "utf8");

    const report = (update: WriteProgress): void => {
      progress?.(update);
    };

    try {
      this.throwIfCancelled(cancellationToken);
  report({ phase: "preparing", bytesWritten, totalBytes, currentOperation: DIGEST_PREPARE_OPERATION });

      let result: WriteResult;

      switch (mergedTarget.type) {
        case "editor":
          result = await this.performEditorWrite({
            content: options.content,
            title: mergedTarget.title,
            language: mergedTarget.language,
            format: options.format,
            cancellationToken,
            progress: report
          });
          break;
        case "file":
          result = await this.performFileWrite({
            content: options.content,
            target: mergedTarget,
            explicitPath: mergedTarget.path,
            format: options.format,
            overwrite: options.overwrite ?? false,
            createDirectories: options.createDirectories ?? configuration.createDirectories,
            configuration,
            cancellationToken,
            progress: report
          });
          break;
        case "clipboard":
          result = await this.performClipboardWrite({ content: options.content, progress: report });
          break;
        default:
          throw wrapError(new Error(`Unsupported target ${(mergedTarget as OutputTarget).type}`), { scope: "outputWriter" });
      }

      bytesWritten = result.bytesWritten;
      report({ phase: "complete", bytesWritten, totalBytes, currentOperation: "Completed" });

      return {
        ...result,
        writeTime: this.now() - start
      };
    } catch (error) {
      const wrapped = wrapError(error, { scope: "outputWriter", target: mergedTarget.type });
      report({ phase: "complete", bytesWritten, totalBytes, currentOperation: "Failed" });
      this.reportFailure(wrapped, mergedTarget);
      return {
        success: false,
        target: mergedTarget,
        bytesWritten,
        error: wrapped.message,
        writeTime: this.now() - start
      };
    }
  }

  /**
   * Convenience helper to write directly to an untitled editor.
   */
  public writeToEditor(content: string, title?: string, language?: string): Promise<WriteResult> {
    const target: OutputTarget = { type: "editor" };
    if (title && title.trim().length > 0) {
      target.title = title;
    }
    if (language && language.trim().length > 0) {
      target.language = language;
    }

    return this.writeOutput({
      target,
      content,
      format: "text"
    });
  }

  /**
   * Convenience helper to write content to a file path.
   */
  public writeToFile(content: string, filePath: string, overwrite?: boolean): Promise<WriteResult> {
    const target: OutputTarget = { type: "file", path: filePath };
    return this.writeOutput({
      target,
      content,
      format: this.inferFormatFromExtension(filePath),
      overwrite
    });
  }

  /**
   * Convenience helper to copy content into the clipboard.
   */
  public writeToClipboard(content: string): Promise<WriteResult> {
    const target: OutputTarget = { type: "clipboard" };
    return this.writeOutput({
      target,
      content,
      format: "text"
    });
  }

  /**
   * Writes streamed content to the configured target, using chunked file writes when
   * the destination is the filesystem.
   */
  public async writeStream(options: StreamWriteOptions): Promise<WriteResult> {
    const configuration = this.loadConfiguration();
    const format = options.format ?? "text";
    const mergedTarget = this.mergeTargetWithConfiguration(options.target, format, configuration);
    const progress = options.progressCallback;
    const report = (update: WriteProgress): void => progress?.(update);
    const start = this.now();
    let bytesWritten = 0;

    try {
      switch (mergedTarget.type) {
        case "file": {
          const result = await this.performStreamFileWrite({
            source: options.contentStream,
            totalSize: options.totalSize,
            chunkSize: options.chunkSize && options.chunkSize > 0 ? options.chunkSize : STREAM_WRITE_CHUNK_BYTES,
            target: mergedTarget,
            format,
            overwrite: options.overwrite ?? false,
            createDirectories: options.createDirectories ?? configuration.createDirectories,
            configuration,
            cancellationToken: options.cancellationToken,
            progress: report
          });
          return {
            ...result,
            writeTime: this.now() - start
          };
        }
        case "editor":
        case "clipboard": {
          const bufferedContent = await this.collectStreamToString(options.contentStream, options.cancellationToken, report);
          const writeResult = await this.writeOutput({
            target: mergedTarget,
            content: bufferedContent,
            format,
            overwrite: options.overwrite,
            createDirectories: options.createDirectories,
            progressCallback: progress,
            cancellationToken: options.cancellationToken
          });
          return writeResult;
        }
        default:
          throw wrapError(new Error(`Unsupported streaming target ${mergedTarget.type}`), { scope: "outputWriter" });
      }
    } catch (error) {
      const wrapped = wrapError(error, { scope: "outputWriter", target: mergedTarget.type, mode: "stream" });
      this.reportFailure(wrapped, mergedTarget);
      return {
        success: false,
        target: mergedTarget,
        bytesWritten,
        error: wrapped.message,
        writeTime: this.now() - start
      };
    }
  }

  /**
   * Resolves the default output target based on current configuration.
   */
  public resolveConfiguredTarget(format: OutputFormat): OutputTarget {
    const configuration = this.loadConfiguration();
    const target: OutputTarget = { type: configuration.defaultTarget };
    if (configuration.defaultTarget === "file") {
      const workspaceRoot = this.getWorkspaceRoot();
      const directory = configuration.outputDirectory ? this.resolveDirectoryPath(configuration.outputDirectory, workspaceRoot) : workspaceRoot;
      const filename = this.generateFilename(configuration.outputFilenameTemplate, format, workspaceRoot);
      target.path = path.join(directory, filename);
    }
    return target;
  }

  private async performEditorWrite(context: EditorWriteContext): Promise<WriteResult> {
    const start = this.now();
    const totalBytes = Buffer.byteLength(context.content, "utf8");
    let bytesWritten = 0;
    const report = context.progress ?? (() => undefined);

    try {
      this.throwIfCancelled(context.cancellationToken);
      report({ phase: "preparing", bytesWritten, totalBytes, currentOperation: "Opening editor" });

      const document = await this.openUntitledDocument(context.title, context.language, context.cancellationToken);
      this.throwIfCancelled(context.cancellationToken);

      const editor = await this.window.showTextDocument(document, { preview: false });
      const chunkSize = DEFAULT_WRITE_CHUNK_BYTES;
      const content = context.content;
      let offset = 0;

      report({ phase: "writing", bytesWritten, totalBytes, currentOperation: "Writing to editor" });

      while (offset < content.length) {
        this.throwIfCancelled(context.cancellationToken);
        const chunk = content.slice(offset, offset + chunkSize);
        const chunkBytes = Buffer.byteLength(chunk, "utf8");
        await editor.edit((editBuilder) => {
          const position = document.positionAt(document.getText().length);
          editBuilder.insert(position, chunk);
        });
        offset += chunk.length;
        bytesWritten += chunkBytes;
        report({ phase: "writing", bytesWritten, totalBytes, currentOperation: "Writing to editor" });
      }

      report({ phase: "complete", bytesWritten, totalBytes, currentOperation: "Editor write complete" });

      const target: OutputTarget = { type: "editor" };
      if (context.title) {
        target.title = context.title;
      }
      if (context.language) {
        target.language = context.language;
      }

      return {
        success: true,
        target,
        bytesWritten,
        writeTime: this.now() - start
      };
    } catch (error) {
      const wrapped = wrapError(error, { scope: "outputWriter", target: "editor" });
      const target: OutputTarget = { type: "editor" };
      if (context.title) {
        target.title = context.title;
      }
      if (context.language) {
        target.language = context.language;
      }
      return {
        success: false,
        target,
        bytesWritten,
        error: wrapped.message,
        writeTime: this.now() - start
      };
    }
  }

  private async performFileWrite(context: FileWriteContext): Promise<WriteResult> {
    const start = this.now();
    const totalBytes = Buffer.byteLength(context.content, "utf8");
    const report = context.progress ?? (() => undefined);
    let bytesWritten = 0;
    let tempPath: string | undefined;

    try {
      this.throwIfCancelled(context.cancellationToken);
      const resolution = await this.resolveFilePath({
        explicitPath: context.explicitPath,
        format: context.format,
        overwrite: context.overwrite,
        createDirectories: context.createDirectories,
        configuration: context.configuration
      }, context.cancellationToken);

      const target: OutputTarget = { type: "file", path: resolution.finalPath };
      const buffer = Buffer.from(context.content, "utf8");

      report({ phase: "writing", bytesWritten, totalBytes, currentOperation: DIGEST_WRITE_OPERATION });

      if (resolution.appendToExisting) {
        await this.appendToFile(resolution.finalPath, buffer, context.cancellationToken, report, totalBytes, (chunkBytes) => {
          bytesWritten += chunkBytes;
          return bytesWritten;
        });
      } else {
        const directory = path.dirname(resolution.finalPath);
        await this.ensureDirectory(directory, context.createDirectories);
        tempPath = await this.createTemporaryPath(directory, resolution.finalPath);

        await this.writeBufferToTemporaryFile(tempPath, buffer, context.cancellationToken, report, totalBytes, (written) => {
          bytesWritten += written;
          return bytesWritten;
        });

        await fsPromises.rename(tempPath, resolution.finalPath);
        tempPath = undefined;
      }

      const fileUri = vscode.Uri.file(resolution.finalPath);
      const progressTotal = totalBytes > 0 ? totalBytes : bytesWritten;

      report({ phase: "writing", bytesWritten, totalBytes: progressTotal, currentOperation: DIGEST_OPEN_OPERATION });
      await this.openFileInEditor(fileUri.fsPath, context.cancellationToken);

      report({ phase: "complete", bytesWritten, totalBytes: progressTotal, currentOperation: "Digest file opened" });

      return {
        success: true,
        target,
        bytesWritten,
        uri: fileUri,
        writeTime: this.now() - start
      };
    } catch (error) {
      if (tempPath) {
        await this.safeRemove(tempPath);
      }
      const wrapped = wrapError(error, { scope: "outputWriter", target: "file" });
      const failureTarget: OutputTarget = { type: "file" };
      if (context.explicitPath) {
        failureTarget.path = path.isAbsolute(context.explicitPath)
          ? context.explicitPath
          : path.join(this.getWorkspaceRoot(), context.explicitPath);
      }
      this.reportFailure(wrapped, failureTarget);
      return {
        success: false,
        target: failureTarget,
        bytesWritten,
        error: this.formatFileErrorMessage(wrapped),
        writeTime: this.now() - start
      };
    }
  }

  private async performClipboardWrite(context: ClipboardWriteContext): Promise<WriteResult> {
    const start = this.now();
    const totalBytes = Buffer.byteLength(context.content, "utf8");
    const report = context.progress ?? (() => undefined);

    try {
      report({ phase: "preparing", bytesWritten: 0, totalBytes, currentOperation: "Copying to clipboard" });
      await this.clipboard.writeText(context.content);
      report({ phase: "complete", bytesWritten: totalBytes, totalBytes, currentOperation: "Clipboard updated" });
      await this.window.showInformationMessage("Digest copied to clipboard");
      return {
        success: true,
        target: { type: "clipboard" },
        bytesWritten: totalBytes,
        writeTime: this.now() - start
      };
    } catch (error) {
      const wrapped = wrapError(error, { scope: "outputWriter", target: "clipboard" });
      return {
        success: false,
        target: { type: "clipboard" },
        bytesWritten: 0,
        error: wrapped.message,
        writeTime: this.now() - start
      };
    }
  }

  private async performStreamFileWrite(context: StreamWriteContext): Promise<WriteResult> {
    const start = this.now();
    const report = context.progress ?? (() => undefined);
    const totalBytes = context.totalSize ?? 0;
    let bytesWritten = 0;
    let tempPath: string | undefined;

    try {
      this.throwIfCancelled(context.cancellationToken);
      const resolution = await this.resolveFilePath({
        explicitPath: context.target.path,
        format: context.format,
        overwrite: context.overwrite,
        createDirectories: context.createDirectories,
        configuration: context.configuration
      }, context.cancellationToken);

      const target: OutputTarget = { type: "file", path: resolution.finalPath };

      report({ phase: "writing", bytesWritten, totalBytes: totalBytes || bytesWritten, currentOperation: DIGEST_WRITE_OPERATION });

      if (resolution.appendToExisting) {
        await this.appendStreamToFile(resolution.finalPath, context, report, totalBytes, (written) => {
          bytesWritten += written;
          return bytesWritten;
        });
      } else {
        const directory = path.dirname(resolution.finalPath);
        await this.ensureDirectory(directory, context.createDirectories);
        tempPath = await this.createTemporaryPath(directory, resolution.finalPath);
        await this.writeStreamToTemporaryFile(tempPath, context, report, totalBytes, (written) => {
          bytesWritten += written;
          return bytesWritten;
        });
        await fsPromises.rename(tempPath, resolution.finalPath);
        tempPath = undefined;
      }

      const progressTotal = totalBytes > 0 ? totalBytes : bytesWritten;
      const fileUri = vscode.Uri.file(resolution.finalPath);

      report({ phase: "writing", bytesWritten, totalBytes: progressTotal, currentOperation: DIGEST_OPEN_OPERATION });
      await this.openFileInEditor(fileUri.fsPath, context.cancellationToken);

      report({ phase: "complete", bytesWritten, totalBytes: progressTotal, currentOperation: "Digest file opened" });

      return {
        success: true,
        target,
        bytesWritten,
        uri: fileUri,
        writeTime: this.now() - start
      };
    } catch (error) {
      if (tempPath) {
        await this.safeRemove(tempPath);
      }
      const wrapped = wrapError(error, { scope: "outputWriter", target: "file", mode: "stream" });
      this.reportFailure(wrapped, { type: "file", path: context.target.path });
      return {
        success: false,
        target: { type: "file", path: context.target.path },
        bytesWritten,
        error: this.formatFileErrorMessage(wrapped),
        writeTime: this.now() - start
      };
    }
  }

  private async collectStreamToString(
    source: StreamSource,
    cancellationToken: vscode.CancellationToken | undefined,
    progress?: (progress: WriteProgress) => void
  ): Promise<string> {
    const chunks: string[] = [];
    let bytes = 0;

    for await (const chunk of this.streamIterator(source)) {
      this.throwIfCancelled(cancellationToken);
      const text = String(chunk);
      chunks.push(text);
      bytes += Buffer.byteLength(text, "utf8");
      progress?.({ phase: "writing", bytesWritten: bytes, totalBytes: bytes, currentOperation: "Buffering stream" });
    }

    return chunks.join("");
  }

  private async *streamIterator(source: StreamSource): AsyncIterable<string> {
    if (typeof (source as AsyncIterable<string>)[Symbol.asyncIterator] === "function") {
      for await (const chunk of source as AsyncIterable<string>) {
        yield chunk;
      }
      return;
    }

    if (typeof (source as Iterable<string>)[Symbol.iterator] === "function") {
      for (const chunk of source as Iterable<string>) {
        yield chunk;
      }
      return;
    }

    const reader = (source as ReadableStreamLike<string>).getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        reader.releaseLock?.();
        break;
      }
      if (value !== undefined) {
        yield value;
      }
    }
  }

  private async resolveFilePath(
    request: {
      explicitPath?: string | undefined;
      format: OutputFormat;
      overwrite: boolean;
      createDirectories: boolean;
      configuration: OutputWriterConfiguration;
    },
    cancellationToken?: vscode.CancellationToken | undefined
  ): Promise<FileResolution> {
    const workspaceRoot = this.getWorkspaceRoot();
    const { configuration } = request;
    let absolutePath: string;
    let derivedFromTemplate = false;

    if (request.explicitPath) {
      absolutePath = path.isAbsolute(request.explicitPath)
        ? request.explicitPath
        : path.join(workspaceRoot, request.explicitPath);
    } else {
      const directory = configuration.outputDirectory
        ? this.resolveDirectoryPath(configuration.outputDirectory, workspaceRoot)
        : workspaceRoot;
      await this.ensureDirectory(directory, request.createDirectories);
      const filename = this.generateFilename(configuration.outputFilenameTemplate, request.format, workspaceRoot);
      absolutePath = path.join(directory, filename);
      derivedFromTemplate = true;
    }

    this.throwIfCancelled(cancellationToken);

    if (derivedFromTemplate || !request.overwrite) {
      absolutePath = await this.ensureUniquePath(absolutePath, derivedFromTemplate && !request.overwrite);
    }

    const appendToExisting = !derivedFromTemplate && !request.overwrite && (await this.pathExists(absolutePath));

    return {
      finalPath: absolutePath,
      appendToExisting,
      derivedFromTemplate
    };
  }

  private async ensureDirectory(directoryPath: string, allowCreate: boolean): Promise<void> {
    try {
      const stats = await fsPromises.stat(directoryPath);
      if (!stats.isDirectory()) {
        throw wrapError(new Error(`Path is not a directory: ${directoryPath}`), { directoryPath });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        if (!allowCreate) {
          throw wrapError(new Error(`Directory does not exist: ${directoryPath}`), { directoryPath });
        }
        await fsPromises.mkdir(directoryPath, { recursive: true });
        return;
      }
      throw error;
    }
  }

  private async ensureUniquePath(initialPath: string, alwaysUnique: boolean): Promise<string> {
    if (!alwaysUnique && !(await this.pathExists(initialPath))) {
      return initialPath;
    }

    const parsed = path.parse(initialPath);
    let counter = 1;
    let candidate = initialPath;

    while (await this.pathExists(candidate)) {
      candidate = path.join(parsed.dir, `${parsed.name}-${counter}${parsed.ext}`);
      counter += 1;
    }

    return candidate;
  }

  private async pathExists(candidate: string): Promise<boolean> {
    try {
      await fsPromises.stat(candidate);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        return false;
      }
      throw error;
    }
  }

  private async createTemporaryPath(directory: string, finalPath: string): Promise<string> {
    const hash = createHash("sha1").update(finalPath).update(String(this.now())).digest("hex");
    const tempName = `.${path.basename(finalPath)}.${hash}.tmp`;
    return path.join(directory, tempName);
  }

  private async safeRemove(candidate: string): Promise<void> {
    try {
      await fsPromises.unlink(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        return;
      }
      throw error;
    }
  }

  private async appendToFile(
    filePath: string,
    buffer: Buffer,
    cancellationToken: vscode.CancellationToken | undefined,
    progress: (progress: WriteProgress) => void,
    totalBytes: number,
    updateBytes: (chunkBytes: number) => number
  ): Promise<void> {
    const handle = await fsPromises.open(filePath, "a");
    try {
      let offset = 0;
      while (offset < buffer.length) {
        this.throwIfCancelled(cancellationToken);
        const end = Math.min(offset + DEFAULT_WRITE_CHUNK_BYTES, buffer.length);
        const chunk = buffer.subarray(offset, end);
        const view = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        await handle.write(view);
        offset = end;
        const written = updateBytes(chunk.byteLength);
        progress({ phase: "writing", bytesWritten: written, totalBytes, currentOperation: DIGEST_WRITE_OPERATION });
      }
    } finally {
      await handle.close();
    }
  }

  private async writeBufferToTemporaryFile(
    tempPath: string,
    buffer: Buffer,
    cancellationToken: vscode.CancellationToken | undefined,
    progress: (progress: WriteProgress) => void,
    totalBytes: number,
    updateBytes: (written: number) => number
  ): Promise<void> {
    const handle = await fsPromises.open(tempPath, "w");
    try {
      let offset = 0;
      while (offset < buffer.length) {
        this.throwIfCancelled(cancellationToken);
        const end = Math.min(offset + DEFAULT_WRITE_CHUNK_BYTES, buffer.length);
        const chunk = buffer.subarray(offset, end);
        const view = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        await handle.write(view);
        offset = end;
        const written = updateBytes(chunk.byteLength);
        progress({ phase: "writing", bytesWritten: written, totalBytes, currentOperation: DIGEST_WRITE_OPERATION });
      }
    } finally {
      await handle.close();
    }
  }

  private async appendStreamToFile(
    filePath: string,
    context: StreamWriteContext,
    progress: (progress: WriteProgress) => void,
    totalBytes: number,
    updateBytes: (written: number) => number
  ): Promise<void> {
    const handle = await fsPromises.open(filePath, "a");
    try {
      for await (const chunk of this.streamIterator(context.source)) {
        this.throwIfCancelled(context.cancellationToken);
        const text = String(chunk);
        const buffer = Buffer.from(text, "utf8");
        const view = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
        await handle.write(view);
        const written = updateBytes(buffer.byteLength);
        const progressTotal = totalBytes > 0 ? totalBytes : written;
        progress({ phase: "writing", bytesWritten: written, totalBytes: progressTotal, currentOperation: DIGEST_WRITE_OPERATION });
      }
    } finally {
      await handle.close();
    }
  }

  private async writeStreamToTemporaryFile(
    tempPath: string,
    context: StreamWriteContext,
    progress: (progress: WriteProgress) => void,
    totalBytes: number,
    updateBytes: (written: number) => number
  ): Promise<void> {
    const handle = await fsPromises.open(tempPath, "w");
    try {
      for await (const chunk of this.streamIterator(context.source)) {
        this.throwIfCancelled(context.cancellationToken);
        const text = String(chunk);
        const buffer = Buffer.from(text, "utf8");
        const view = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
        await handle.write(view);
        const written = updateBytes(buffer.byteLength);
        const progressTotal = totalBytes > 0 ? totalBytes : written;
        progress({ phase: "writing", bytesWritten: written, totalBytes: progressTotal, currentOperation: DIGEST_WRITE_OPERATION });
      }
    } finally {
      await handle.close();
    }
  }

  private async openUntitledDocument(
    title: string | undefined,
    language: string | undefined,
    cancellationToken: vscode.CancellationToken | undefined
  ): Promise<vscode.TextDocument> {
    if (title && title.trim().length > 0) {
      const sanitized = this.sanitizeFilename(title);
      const uri = vscode.Uri.parse(`untitled:${encodeURIComponent(sanitized)}`);
      this.throwIfCancelled(cancellationToken);
      const doc = await this.workspace.openTextDocument(uri);
      if (language && typeof vscode.languages?.setTextDocumentLanguage === "function") {
        await vscode.languages.setTextDocumentLanguage(doc, language);
      }
      return doc;
    }

    const options: { language?: string; content: string } = { content: "" };
    if (language) {
      options.language = language;
    }

    this.throwIfCancelled(cancellationToken);
    return this.workspace.openTextDocument(options);
  }

  private loadConfiguration(): OutputWriterConfiguration {
    const configuration = this.workspace.getConfiguration?.("codeIngest") as vscode.WorkspaceConfiguration | undefined;

    const getSetting = <T>(key: string, fallback: T): T => {
      if (!configuration || typeof configuration.get !== "function") {
        return fallback;
      }
      const value = configuration.get<T>(key);
      return value !== undefined ? value : fallback;
    };

    return {
      defaultTarget: getSetting<OutputTargetType>("defaultOutputTarget", "editor"),
      outputDirectory: configuration?.get<string>("outputDirectory") ?? undefined,
      outputFilenameTemplate: getSetting<string>("outputFilename", DEFAULT_FILENAME_TEMPLATE),
      createDirectories: getSetting<boolean>("createOutputDirectories", true)
    };
  }

  private mergeTargetWithConfiguration(target: OutputTarget, format: OutputFormat, configuration: OutputWriterConfiguration): OutputTarget {
    if (target.type === "file" && !target.path) {
      const workspaceRoot = this.getWorkspaceRoot();
      const directory = configuration.outputDirectory
        ? this.resolveDirectoryPath(configuration.outputDirectory, workspaceRoot)
        : workspaceRoot;
      const filename = this.generateFilename(configuration.outputFilenameTemplate, format, workspaceRoot);
      return { type: "file", path: path.join(directory, filename) };
    }

    if (target.type === "editor") {
      const normalized: OutputTarget = { type: "editor" };
      if (target.title) {
        normalized.title = target.title;
      }
      if (target.language) {
        normalized.language = target.language;
      }
      return normalized;
    }

    if (target.type === "clipboard") {
      return { type: "clipboard" };
    }

    return target;
  }

  private generateFilename(template: string, format: OutputFormat, workspaceRoot: string): string {
    const workspaceName = path.basename(workspaceRoot);
    const timestamp = this.formatTimestamp(new Date());
    const interpolated = template
      .replace(/{workspace}/gi, this.sanitizeFilename(workspaceName))
      .replace(/{timestamp}/gi, timestamp)
      .replace(/{format}/gi, format);
    return this.sanitizeFilename(interpolated);
  }

  private formatTimestamp(date: Date): string {
    const iso = date.toISOString();
    return iso.replace(/[:.]/g, "").replace("T", "-").replace("Z", "");
  }

  private sanitizeFilename(name: string): string {
    return name.replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_").trim();
  }

  private resolveDirectoryPath(dir: string, workspaceRoot: string): string {
    return path.isAbsolute(dir) ? dir : path.join(workspaceRoot, dir);
  }

  private getWorkspaceRoot(): string {
    const folder = this.workspace.workspaceFolders?.[0];
    if (folder) {
      return folder.uri.fsPath;
    }
    return process.cwd();
  }

  private formatFileErrorMessage(error: Error): string {
    const nodeError = error as NodeJS.ErrnoException;
    switch (nodeError.code) {
      case "EACCES":
      case "EPERM":
        return "Permission denied while writing output.";
      case "ENOSPC":
        return "Insufficient disk space to write output.";
      case "EROFS":
        return "Cannot write output to a read-only location.";
      case "EIO":
        return "I/O error encountered while writing output.";
      default:
        return error.message;
    }
  }

  private inferFormatFromExtension(filePath: string): OutputFormat {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === ".md" || ext === ".markdown") {
      return "markdown";
    }
    if (ext === ".json") {
      return "json";
    }
    return "text";
  }

  private throwIfCancelled(token: vscode.CancellationToken | undefined): void {
    if (token?.isCancellationRequested) {
      throw new vscode.CancellationError();
    }
  }

  private reportFailure(error: Error, target: OutputTarget): void {
    if (error instanceof vscode.CancellationError) {
      return;
    }

    this.errorReporter?.report(error, {
      source: "outputWriter.write",
      metadata: {
        target: target.type,
        path: target.path
      }
    });

    if (this.errorChannel) {
      const location = target.type === "file" ? target.path ?? "(unspecified path)" : target.type;
      this.errorChannel.appendLine(`[output-writer] Failed to write output to ${location}: ${error.message}`);
    }
  }

  private async openFileInEditor(filePath: string, cancellationToken?: vscode.CancellationToken | undefined): Promise<void> {
    const uri = vscode.Uri.file(filePath);
    this.throwIfCancelled(cancellationToken);
    const document = await this.workspace.openTextDocument(uri);
    this.throwIfCancelled(cancellationToken);
    await this.window.showTextDocument(document, { preview: false });
  }
}