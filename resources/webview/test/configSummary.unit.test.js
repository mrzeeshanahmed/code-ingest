/**
 * @jest-environment jsdom
 */
/*
 * Follow instructions in copilot-instructions.md exactly.
 */

import { buildConfigDisplay } from "../utils/configSummary.js";

describe("buildConfigDisplay", () => {
  it("summarizes include/exclude patterns and flags", () => {
    const summary = buildConfigDisplay({
      include: ["src/**/*.ts", "docs/**/*.md"],
      exclude: ["node_modules/**"],
      redactionOverride: true,
      followSymlinks: true,
      respectGitIgnore: false,
      outputFormat: "Markdown",
      preset: "Docs"
    });

    expect(summary.include).toEqual(["src/**/*.ts", "docs/**/*.md"]);
    expect(summary.exclude).toEqual(["node_modules/**"]);
    expect(summary.statusLine).toContain("Include");
    expect(summary.statusLine).toContain("Redaction: Off");
    expect(summary.lines.join(" ")).toContain("Gitignore: Off");
    expect(summary.lines.join(" ")).toContain("Preset: Docs");
  });

  it("falls back to defaults when patterns are missing", () => {
    const summary = buildConfigDisplay({});
    expect(summary.includeSummary).toBe("Workspace");
    expect(summary.excludeSummary).toBe("Defaults");
    expect(summary.statusLine).toContain("Redaction: On");
  });
});