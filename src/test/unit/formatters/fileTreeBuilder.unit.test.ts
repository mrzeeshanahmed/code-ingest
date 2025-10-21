import { describe, expect, test } from "@jest/globals";
import { FileTreeBuilder } from "../../../formatters/base/fileTreeBuilder";

function createPathsFixture(): string[] {
  return [
    "src/index.ts",
    "src/utils/helpers.ts",
    "README.md"
  ];
}

describe("FileTreeBuilder", () => {
  test("produces consistent nested, ascii, and mermaid views", () => {
    const tree = FileTreeBuilder.fromPaths(createPathsFixture());

    expect(tree.toNestedList()).toEqual([
      "- README.md",
      "- src",
      "  - index.ts",
      "  - utils",
      "    - helpers.ts"
    ]);

    expect(tree.toAsciiTree()).toEqual([
      "├── README.md",
      "└── src",
      "    ├── index.ts",
      "    └── utils",
      "        └── helpers.ts"
    ]);

    expect(tree.toMermaidLines()).toEqual([
      'root["Workspace"]',
      'root_readme_md_0["README.md"]',
      "root --> root_readme_md_0",
      'root_src_1["src"]',
      "root --> root_src_1",
      'root_src_1_index_ts_0["index.ts"]',
      "root_src_1 --> root_src_1_index_ts_0",
      'root_src_1_utils_1["utils"]',
      "root_src_1 --> root_src_1_utils_1",
      'root_src_1_utils_1_helpers_ts_0["helpers.ts"]',
      "root_src_1_utils_1 --> root_src_1_utils_1_helpers_ts_0"
    ]);
  });

  test("returns fallback ascii view when no paths provided", () => {
    const tree = FileTreeBuilder.fromPaths([]);
    expect(tree.toAsciiTree()).toEqual(["<no files>"]);
    expect(tree.toNestedList()).toEqual([]);
    expect(tree.toMermaidLines()).toEqual(['root["Workspace"]']);
  });

  test("deduplicates repeated segments and normalises separators", () => {
    const tree = FileTreeBuilder.fromPaths([
      "src/feature/index.ts",
      "src\\feature\\index.ts",
      "src/feature/components/button.tsx"
    ]);

    expect(tree.toNestedList()).toEqual([
      "- src",
      "  - feature",
      "    - components",
      "      - button.tsx",
      "    - index.ts"
    ]);
  });
});
