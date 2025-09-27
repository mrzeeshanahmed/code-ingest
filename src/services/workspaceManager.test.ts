import { describe, expect, it, jest } from "@jest/globals";
import { Diagnostics } from "./diagnostics";
import { GitignoreService } from "./gitignoreService";
import { WorkspaceManager } from "./workspaceManager";

describe("WorkspaceManager", () => {
  it("records an initialization message", () => {
    const diagnostics = new Diagnostics();
    const addSpy = jest.spyOn(diagnostics, "add");
  const gitignoreService = { clearCache: jest.fn() } as unknown as GitignoreService;

    const manager = new WorkspaceManager(diagnostics, gitignoreService);
    manager.initialize();

    expect(addSpy).toHaveBeenCalledWith("WorkspaceManager initialized.");
  });
});