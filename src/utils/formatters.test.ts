import { describe, expect, it } from "@jest/globals";
import * as path from "path";
import { Formatters } from "./formatters";

describe("Formatters", () => {
  it("builds a file header with token information", () => {
    expect(Formatters.buildFileHeader("src/index.ts", 42)).toBe("--- FILE: src/index.ts (42 tokens) ---");
  });

  it("builds a summary section", () => {
    const summary = Formatters.buildSummary(3, 1200);
    expect(summary).toContain("Files processed: 3");
    expect(summary).toContain("Total tokens: 1.2k tokens");
  });

  it("generates an ASCII file tree", () => {
    const root = path.join("/workspace/project");
    const files = [
      path.join(root, "src", "index.ts"),
      path.join(root, "src", "components", "app.tsx"),
      path.join(root, "README.md")
    ];

    const tree = Formatters.buildFileTree(files, root);

  expect(tree).toContain("File Tree");
  expect(tree).toContain("├── README.md");
  expect(tree).toContain("└── src");
  expect(tree).toContain("└── index.ts");
  });

  it("renders a placeholder when no files are provided", () => {
    const tree = Formatters.buildFileTree([], "/workspace");
    expect(tree).toContain("<no files>");
  });
});