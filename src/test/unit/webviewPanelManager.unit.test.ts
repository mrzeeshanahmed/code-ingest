import { describe, expect, it, beforeEach, afterEach, jest } from "@jest/globals";
import * as vscode from "vscode";
import { WebviewPanelManager } from "../../webview/webviewPanelManager";
import { CodeIngestPanel } from "../../providers/codeIngestPanel";

describe("WebviewPanelManager", () => {
  const extensionUri = vscode.Uri.parse("file:///test-extension");
  let restoreSpy: jest.SpiedFunction<typeof CodeIngestPanel.restoreState>;

  beforeEach(() => {
    restoreSpy = jest.spyOn(CodeIngestPanel, "restoreState").mockReturnValue(false);
  });

  afterEach(() => {
    restoreSpy.mockRestore();
  });

  it("stores state without emitting when emit option is false", () => {
    const manager = new WebviewPanelManager(extensionUri);
    manager.setStateSnapshot({ foo: "bar" }, { emit: false });

    expect(restoreSpy).not.toHaveBeenCalled();
    expect(manager.getStateSnapshot()).toEqual({ foo: "bar" });
  });

  it("attempts to restore immediately when emit option is omitted", () => {
    const manager = new WebviewPanelManager(extensionUri);
    manager.setStateSnapshot({ foo: "bar" });

    expect(restoreSpy).toHaveBeenCalledTimes(1);
    expect(restoreSpy).toHaveBeenCalledWith({ foo: "bar" });
  });

  it("restores the stored state when requested", () => {
    const manager = new WebviewPanelManager(extensionUri);
    manager.setStateSnapshot({ foo: "bar" }, { emit: false });

    restoreSpy.mockReturnValueOnce(true);
    expect(manager.tryRestoreState()).toBe(true);
    expect(restoreSpy).toHaveBeenCalledWith({ foo: "bar" });
  });
});
