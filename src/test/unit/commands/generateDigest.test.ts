import { describe, expect, it } from "@jest/globals";

import { __testing } from "../../../commands/generateDigest";

const { normalizeRelativePath, normalizeSelectionInput } = __testing;

describe("generateDigest selection helpers", () => {
  it("normalizes Windows absolute paths with mixed separators", () => {
    const workspace = "C:/projects/code-ingest";
    const candidate = "C:/projects/code-ingest\\src/example.ts";

    const normalized = normalizeRelativePath(candidate, workspace);

    expect(normalized).toBe("src/example.ts");
  });

  it("rejects paths outside the workspace", () => {
    const workspace = "C:/projects/code-ingest";
    const candidate = "C:/projects/other-repo/src/example.ts";

    const normalized = normalizeRelativePath(candidate, workspace);

    expect(normalized).toBeNull();
  });

  it("deduplicates and sorts selection entries", () => {
    const workspace = "C:/projects/code-ingest";
    const selection = [
      "src/feature/b.ts",
      "src\\feature\\a.ts",
      "file:///C:/projects/code-ingest/src/feature/b.ts",
      "",
      42
    ];

    const normalized = normalizeSelectionInput(selection as unknown[], workspace);

    expect(normalized).toEqual(["src/feature/a.ts", "src/feature/b.ts"]);
  });
});