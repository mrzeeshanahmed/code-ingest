import { BinaryDetector } from "../../utils/binaryDetector";
import { TokenAdapter } from "../../utils/tokenAdapter";

describe("TokenAdapter", () => {
  const adapter = new TokenAdapter();

  test("estimates and humanizes token counts", () => {
    expect(adapter.estimateCount("")).toBe(0);
    expect(adapter.estimateCount("alpha beta gamma delta")).toBeGreaterThanOrEqual(5);
    expect(adapter.humanize(1530)).toBe("1.5k");
    expect(adapter.humanize(999)).toBe("999");
  });

  test("trims text to the requested budget", () => {
    const text = "alpha beta gamma delta epsilon zeta eta theta";
    const trimmed = adapter.trimToBudget(text, 4);

    expect(trimmed.length).toBeGreaterThan(0);
    expect(adapter.estimateCount(trimmed)).toBeLessThanOrEqual(4);
    expect(trimmed).toBe("alpha beta gamma");
  });

  test("chunks content with overlap", () => {
    const text = Array.from({ length: 12 }, (_, index) => `word${index + 1}`).join(" ");
    const chunks = adapter.chunkByTokens(text, 5, 2);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]).toContain("word1");
    expect(chunks[1]).toContain("word3");
    expect(chunks.at(-1)).toContain("word12");
  });
});

describe("BinaryDetector", () => {
  const detector = new BinaryDetector();

  test("identifies binary content from null bytes and common extensions", () => {
    expect(detector.isBinary(Buffer.from([0x41, 0x00, 0x42]))).toBe(true);
    expect(detector.isBinaryPath("assets/icon.png")).toBe(true);
  });

  test("keeps normal source text as non-binary", () => {
    expect(detector.isBinary(Buffer.from("export const answer = 42;\n", "utf8"))).toBe(false);
    expect(detector.isBinaryPath("src/index.ts")).toBe(false);
  });
});
