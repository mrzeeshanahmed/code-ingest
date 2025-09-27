import type { Diagnostics } from "./diagnostics";
import type { GitignoreService } from "./gitignoreService";

export class WorkspaceManager {
  constructor(private readonly diagnostics: Diagnostics, private readonly gitignoreService: GitignoreService) {}

  initialize(): void {
    this.diagnostics.add("WorkspaceManager initialized.");
    void this.gitignoreService; // Placeholder for future integration
  }
}
