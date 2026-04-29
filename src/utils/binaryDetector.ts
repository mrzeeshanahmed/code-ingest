import * as path from "node:path";

const DEFAULT_BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".bmp",
  ".ico",
  ".webp",
  ".pdf",
  ".zip",
  ".tar",
  ".gz",
  ".7z",
  ".rar",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".mp3",
  ".mp4",
  ".mov",
  ".avi"
]);

export class BinaryDetector {
  public isBinary(buffer: Buffer): boolean {
    if (buffer.length === 0) {
      return false;
    }

    const sampleSize = Math.min(1024, buffer.length);
    const sample = buffer.subarray(0, sampleSize);

    if (sample.includes(0)) {
      return true;
    }

    let controlChars = 0;
    for (let index = 0; index < sample.length; index += 1) {
      const byte = sample[index];
      if ((byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) || byte === 127) {
        controlChars += 1;
      }
    }

    return controlChars / sample.length > 0.3;
  }

  public isBinaryPath(filePath: string): boolean {
    return DEFAULT_BINARY_EXTENSIONS.has(path.extname(filePath).toLowerCase());
  }
}
