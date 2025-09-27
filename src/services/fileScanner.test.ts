import { describe, expect, it } from "@jest/globals";
import * as vscode from "vscode";
import { FileScanner } from "./fileScanner";

describe("FileScanner", () => {
  it("returns an empty list for the stub implementation", async () => {
    const scanner = new FileScanner(vscode.Uri.file("/workspace"));
    await expect(scanner.scan()).resolves.toEqual([]);
  });
});