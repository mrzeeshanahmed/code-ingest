import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { DigestGenerator } from "./digestGenerator";
import type { DigestConfig } from "../utils/validateConfig";
import { Formatters } from "../utils/formatters";
import { ContentProcessor } from "../services/contentProcessor";
import { TokenAnalyzer } from "../services/tokenAnalyzer";
import { redactSecrets } from "../utils/redactSecrets";

jest.mock("../utils/formatters", () => ({
  Formatters: {
    buildSummary: jest.fn(),
    buildFileTree: jest.fn(),
    buildFileHeader: jest.fn()
  }
}));

jest.mock("../services/contentProcessor", () => ({
  ContentProcessor: {
    getFileContent: jest.fn()
  }
}));

jest.mock("../services/tokenAnalyzer", () => ({
  TokenAnalyzer: {
    estimate: jest.fn(),
    formatEstimate: jest.fn(),
    warnIfExceedsLimit: jest.fn()
  }
}));

jest.mock("../utils/redactSecrets", () => ({
  redactSecrets: jest.fn((value: string) => value)
}));

describe("DigestGenerator", () => {
  const mockConfig: DigestConfig = {
    workspaceRoot: "/workspace",
    sectionSeparator: "\n\n"
  };

  const files = [
    { path: "src/foo.ts" },
    { path: "src/bar.ts" }
  ];

  const mockedFormatters = Formatters as jest.Mocked<typeof Formatters>;
  const mockedContentProcessor = ContentProcessor as jest.Mocked<typeof ContentProcessor>;
  const mockedTokenAnalyzer = TokenAnalyzer as jest.Mocked<typeof TokenAnalyzer>;
  const mockedRedactSecrets = redactSecrets as jest.MockedFunction<typeof redactSecrets>;

  const createGenerator = () =>
    new DigestGenerator(
      { getFileContent: mockedContentProcessor.getFileContent },
      {
        estimate: mockedTokenAnalyzer.estimate,
        formatEstimate: mockedTokenAnalyzer.formatEstimate,
        warnIfExceedsLimit: mockedTokenAnalyzer.warnIfExceedsLimit
      }
    );

  beforeEach(() => {
    jest.clearAllMocks();
    mockedRedactSecrets.mockImplementation((value: string) => value);
  });

  it("aggregates content and token counts across files", async () => {
    mockedContentProcessor.getFileContent
      .mockResolvedValueOnce("console.log('foo');")
      .mockResolvedValueOnce("console.log('bar');");

    mockedTokenAnalyzer.estimate.mockReturnValueOnce(5).mockReturnValueOnce(7);

    mockedFormatters.buildFileHeader
      .mockReturnValueOnce("### src/foo.ts (5 tokens)")
      .mockReturnValueOnce("### src/bar.ts (7 tokens)");

    mockedFormatters.buildSummary.mockReturnValue("Summary");
    mockedFormatters.buildFileTree.mockReturnValue("Tree");

    const generator = createGenerator();

    const result = await generator.generate(files, mockConfig);

  expect(mockedRedactSecrets).toHaveBeenCalledTimes(1);
  expect(mockedRedactSecrets).toHaveBeenCalledWith(expect.stringContaining("Summary"));

    expect(mockedContentProcessor.getFileContent).toHaveBeenCalledTimes(2);
    expect(mockedContentProcessor.getFileContent).toHaveBeenNthCalledWith(1, "src/foo.ts", mockConfig);
    expect(mockedContentProcessor.getFileContent).toHaveBeenNthCalledWith(2, "src/bar.ts", mockConfig);

    expect(mockedTokenAnalyzer.estimate).toHaveBeenCalledTimes(2);
    expect(mockedTokenAnalyzer.estimate).toHaveBeenNthCalledWith(1, "console.log('foo');");
    expect(mockedTokenAnalyzer.estimate).toHaveBeenNthCalledWith(2, "console.log('bar');");

    expect(mockedFormatters.buildFileHeader).toHaveBeenCalledTimes(2);
    expect(mockedFormatters.buildFileHeader).toHaveBeenNthCalledWith(1, "src/foo.ts", 5);
    expect(mockedFormatters.buildFileHeader).toHaveBeenNthCalledWith(2, "src/bar.ts", 7);

    expect(mockedFormatters.buildSummary).toHaveBeenCalledWith(2, 12);
    expect(mockedFormatters.buildFileTree).toHaveBeenCalledWith(["src/foo.ts", "src/bar.ts"], "/workspace");

    expect(result.totalTokens).toBe(12);
    expect(result.fullContent).toContain("Summary");
    expect(result.fullContent).toContain("Tree");
    expect(result.fullContent).toContain("### src/foo.ts (5 tokens)\nconsole.log('foo');");
    expect(result.fullContent).toContain("### src/bar.ts (7 tokens)\nconsole.log('bar');");
    expect(result.diagnostics).toEqual([]);
  });

  it("skips files when content processor returns null", async () => {
    mockedContentProcessor.getFileContent
      .mockResolvedValueOnce("console.log('foo');")
      .mockResolvedValueOnce(null);

    mockedTokenAnalyzer.estimate.mockReturnValue(5);

    mockedFormatters.buildFileHeader.mockReturnValue("### src/foo.ts (5 tokens)");
    mockedFormatters.buildSummary.mockReturnValue("Summary");
    mockedFormatters.buildFileTree.mockReturnValue("Tree");

    const generator = createGenerator();

    const result = await generator.generate(files, mockConfig);

    expect(mockedContentProcessor.getFileContent).toHaveBeenCalledTimes(2);
    expect(mockedTokenAnalyzer.estimate).toHaveBeenCalledTimes(1);
    expect(mockedFormatters.buildFileHeader).toHaveBeenCalledTimes(1);
    expect(mockedFormatters.buildSummary).toHaveBeenCalledWith(1, 5);
    expect(mockedFormatters.buildFileTree).toHaveBeenCalledWith(["src/foo.ts"], "/workspace");

    expect(result.totalTokens).toBe(5);
    expect(result.fullContent).toContain("Summary");
    expect(result.fullContent).toContain("Tree");
    expect(result.fullContent).toContain("### src/foo.ts (5 tokens)\nconsole.log('foo');");
    expect(result.fullContent).not.toContain("src/bar.ts");
    expect(result.diagnostics).toContain("Skipped src/bar.ts: no content generated.");
  });

  it("redacts secrets after assembling the digest", async () => {
    mockedContentProcessor.getFileContent.mockResolvedValue("API_KEY=12345");
    mockedTokenAnalyzer.estimate.mockReturnValue(3);
    mockedFormatters.buildFileHeader.mockReturnValue("header");
    mockedFormatters.buildSummary.mockReturnValue("summary");
    mockedFormatters.buildFileTree.mockReturnValue("tree");

    mockedRedactSecrets.mockImplementation((value: string) => value.replace("12345", "[redacted]"));

    const generator = createGenerator();

    const result = await generator.generate([{ path: "secrets.env" }], mockConfig);

    expect(mockedRedactSecrets).toHaveBeenCalledWith("summary\n\ntree\n\nheader\nAPI_KEY=12345");
    expect(result.fullContent).toBe("summary\n\ntree\n\nheader\nAPI_KEY=[redacted]");
  });

  it("reports diagnostics when token estimation fails", async () => {
    mockedContentProcessor.getFileContent.mockResolvedValue("console.log('foo');");
    mockedTokenAnalyzer.estimate.mockImplementation(() => {
      throw new Error("bad tokens");
    });
    mockedFormatters.buildSummary.mockReturnValue("summary");
    mockedFormatters.buildFileTree.mockReturnValue("tree");

    const generator = createGenerator();

    const result = await generator.generate([{ path: "src/foo.ts" }], mockConfig);

    expect(mockedFormatters.buildSummary).toHaveBeenCalledWith(0, 0);
    expect(mockedRedactSecrets).toHaveBeenCalledWith("summary\n\ntree");
    expect(result.totalTokens).toBe(0);
    expect(result.diagnostics).toContain("Failed to estimate tokens for src/foo.ts: bad tokens");
  });

  it("reports diagnostics when content processor throws", async () => {
    mockedContentProcessor.getFileContent.mockRejectedValue(new Error("boom"));
    mockedFormatters.buildSummary.mockReturnValue("summary");
    mockedFormatters.buildFileTree.mockReturnValue("tree");

    const generator = createGenerator();

    const result = await generator.generate([{ path: "src/foo.ts" }], mockConfig);

    expect(result.diagnostics).toContain("Error processing src/foo.ts: boom");
    expect(result.totalTokens).toBe(0);
    expect(mockedRedactSecrets).toHaveBeenCalledWith("summary\n\ntree");
  });
});
