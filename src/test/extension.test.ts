import { describe, expect, it } from "@jest/globals";
import * as vscode from "vscode";

describe("Extension smoke test", () => {
  it("has a mocked VS Code API available", () => {
    expect(vscode.window.showInformationMessage).toBeDefined();
  });
});