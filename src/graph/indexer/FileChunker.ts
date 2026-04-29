export interface FileChunk {
  index: number;
  startLine: number;
  endLine: number;
  content: string;
}

export class FileChunker {
  constructor(
    private readonly maxLinesPerChunk = 200,
    private readonly overlapLines = 40
  ) {}

  public chunk(content: string): FileChunk[] {
    const lines = content.split(/\r?\n/u);
    if (lines.length === 0) {
      return [];
    }

    const chunks: FileChunk[] = [];
    let start = 0;
    let index = 0;

    while (start < lines.length) {
      const end = Math.min(lines.length, start + this.maxLinesPerChunk);
      chunks.push({
        index,
        startLine: start + 1,
        endLine: end,
        content: lines.slice(start, end).join("\n")
      });

      if (end >= lines.length) {
        break;
      }

      start = Math.max(start + 1, end - this.overlapLines);
      index += 1;
    }

    return chunks;
  }
}
