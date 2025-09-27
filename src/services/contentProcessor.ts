import * as path from "path";
import { promises as fs } from "fs";
import type { DigestConfig } from "../utils/validateConfig";
import { NotebookProcessor } from "./notebookProcessor";

const BINARY_PLACEHOLDER_PREFIX = "[binary file]";

export class ContentProcessor {
  /**
   * Reads a file from disk and returns its textual representation based on the
   * provided configuration. Binary files are handled according to
   * `config.binaryFilePolicy`.
   */
  public static async getFileContent(filePath: string, config: DigestConfig): Promise<string | null> {
    const resolved = path.resolve(filePath);
    try {
      if (resolved.toLowerCase().endsWith(".ipynb")) {
        const raw = await fs.readFile(resolved, "utf8");
        return NotebookProcessor.buildNotebookContent(raw, config);
      }

      const buffer = await fs.readFile(resolved);

      if (ContentProcessor.isBinary(buffer)) {
        return ContentProcessor.handleBinary(buffer, resolved, config);
      }

      const text = buffer.toString("utf8");
      return ContentProcessor.normalizeLineEndings(text);
    } catch {
      return null;
    }
  }

  private static normalizeLineEndings(input: string): string {
    return input.replace(/\r\n/g, "\n");
  }

  private static handleBinary(buffer: Buffer, filePath: string, config: DigestConfig): string | null {
    const policy = (config.binaryFilePolicy ?? "skip").toLowerCase();

    switch (policy) {
      case "placeholder":
        return `${BINARY_PLACEHOLDER_PREFIX} ${path.basename(filePath)}`;
      case "base64":
        return buffer.toString("base64");
      case "skip":
      default:
        return null;
    }
  }

  private static isBinary(buffer: Buffer): boolean {
    if (buffer.length === 0) {
      return false;
    }

    const length = Math.min(buffer.length, 8000);
    let suspicious = 0;
    for (let i = 0; i < length; i++) {
      const byte = buffer[i];
      if (byte === 0) {
        return true;
      }
      if (byte < 7 || (byte > 13 && byte < 32)) {
        suspicious++;
      }
    }

    return suspicious / length > 0.3;
  }
}
