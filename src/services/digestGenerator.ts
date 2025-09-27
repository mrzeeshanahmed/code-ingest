import type { DigestConfig } from "../utils/validateConfig";
import { Formatters } from "../utils/formatters";
import { asyncPool } from "../utils/asyncPool";
import { redactSecrets } from "../utils/redactSecrets";

export interface FileNode {
  path: string;
}

export interface DigestResult {
  fullContent: string;
  totalTokens: number;
  diagnostics: string[];
}

type ContentProcessorContract = {
  getFileContent(filePath: string, config: DigestConfig): Promise<string | null>;
};

type TokenAnalyzerContract = {
  estimate(content: string): number;
  formatEstimate?(tokens: number): string;
  warnIfExceedsLimit?(tokens: number, limit: number): string | null;
};

interface ProcessedChunk {
  filePath: string;
  content: string;
  tokens: number;
}

interface ProcessResult {
  chunk?: ProcessedChunk;
  diagnostics: string[];
}

export class DigestGenerator {
  constructor(
    private readonly contentProcessor: ContentProcessorContract,
    private readonly tokenAnalyzer: TokenAnalyzerContract
  ) {}

  public async generate(files: FileNode[], config: DigestConfig): Promise<DigestResult> {
    const concurrency = config.maxConcurrency ?? 4;
    const sectionSeparator = config.sectionSeparator ?? "\n\n";
    const workspaceRoot = config.workspaceRoot ?? process.cwd();

    const taskFactories = files.map((file) => () => this.processFile(file, config));
    const results = await asyncPool(taskFactories, concurrency);

    const diagnostics: string[] = [];
    const chunks: ProcessedChunk[] = [];

    for (const result of results) {
      diagnostics.push(...result.diagnostics);
      if (result.chunk) {
        chunks.push(result.chunk);
      }
    }

    const totalTokens = chunks.reduce((sum, chunk) => sum + chunk.tokens, 0);
    const processedFiles = chunks.length;
    const processedPaths = chunks.map((chunk) => chunk.filePath);

    const summary = Formatters.buildSummary(processedFiles, totalTokens);
    const tree = Formatters.buildFileTree(processedPaths, workspaceRoot);
    const contentSections = chunks.map((chunk) => chunk.content);

  const assembled = [summary, tree, ...contentSections].filter((section) => section && section.length > 0);
  const fullContent = assembled.join(sectionSeparator);
  const redactedContent = redactSecrets(fullContent);

  return { fullContent: redactedContent, totalTokens, diagnostics };
  }

  private async processFile(file: FileNode, config: DigestConfig): Promise<ProcessResult> {
    const diagnostics: string[] = [];

    try {
      const content = await this.contentProcessor.getFileContent(file.path, config);
      if (!content) {
        diagnostics.push(`Skipped ${file.path}: no content generated.`);
        return { diagnostics };
      }

      let tokens: number;
      try {
        tokens = this.tokenAnalyzer.estimate(content);
      } catch (error) {
        diagnostics.push(`Failed to estimate tokens for ${file.path}: ${DigestGenerator.stringifyError(error)}`);
        return { diagnostics };
      }

      const header = Formatters.buildFileHeader(file.path, tokens);
      const combined = `${header}\n${content}`;

      return {
        diagnostics,
        chunk: {
          filePath: file.path,
          content: combined,
          tokens
        }
      };
    } catch (error) {
      diagnostics.push(`Error processing ${file.path}: ${DigestGenerator.stringifyError(error)}`);
      return { diagnostics };
    }
  }

  private static stringifyError(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    return String(error);
  }
}
