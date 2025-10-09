import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { DigestConfig, Diagnostics, validateConfig } from "../utils/validateConfig";
import { DEFAULT_CONFIG } from "../config/constants";

/**
 * Basic scaffold for a ConfigurationService responsible for loading and validating
 * runtime configuration for the extension.
 */
export class ConfigurationService {
  private config: DigestConfig;
  private diagnostics: Diagnostics;
  private cachedConfig?: DigestConfig;
  private cachedRequiredVSCodeVersion?: string;

  constructor(initialConfig?: Partial<DigestConfig>, diagnostics?: Diagnostics) {
    this.diagnostics = diagnostics ?? { addError: (m: string) => console.error(m), addWarning: (m: string) => console.warn(m) };
    // start with a shallow clone of defaults + provided overrides
    this.config = Object.assign({}, initialConfig) as DigestConfig;
  }

  /**
   * Loads and returns the validated configuration. This method is a placeholder
   * and currently validates the in-memory `config` object using `validateConfig`.
   */
  loadConfig(): DigestConfig {
    validateConfig(this.config, this.diagnostics);
    this.cachedConfig = { ...this.config };
    return { ...this.cachedConfig };
  }

  getConfig(): DigestConfig {
    if (!this.cachedConfig) {
      return this.loadConfig();
    }

    return { ...this.cachedConfig };
  }

  /**
   * Reads the workspace-level configuration for the extension, merges it with
   * defaults, validates the resulting snapshot, and returns the validated config.
   */
  static getWorkspaceConfig(folder: vscode.WorkspaceFolder | undefined, diagnostics: Diagnostics): DigestConfig {
    const raw = vscode.workspace.getConfiguration('codeIngest', folder) as unknown as Record<string, unknown>;

    // Build a complete snapshot by falling back to DEFAULT_CONFIG for missing keys
    const snapshot: DigestConfig = {
      include: raw['include'] as DigestConfig['include'] ?? DEFAULT_CONFIG.include,
      exclude: raw['exclude'] as DigestConfig['exclude'] ?? DEFAULT_CONFIG.exclude,
      maxDepth: (raw['maxDepth'] as number) ?? DEFAULT_CONFIG.maxDepth,
      maxFiles: (raw['maxFiles'] as number) ?? DEFAULT_CONFIG.maxFiles,
      outputFormat: (raw['outputFormat'] as DigestConfig['outputFormat']) ?? DEFAULT_CONFIG.outputFormat,
      binaryFilePolicy: (raw['binaryFilePolicy'] as DigestConfig['binaryFilePolicy']) ?? DEFAULT_CONFIG.binaryFilePolicy,
      repoName: (raw['repoName'] as string) ?? DEFAULT_CONFIG.repoName,
      followSymlinks: (raw['followSymlinks'] as boolean) ?? DEFAULT_CONFIG.followSymlinks,
      respectGitIgnore: (raw['respectGitIgnore'] as boolean) ?? DEFAULT_CONFIG.respectGitIgnore
    };

    // Validate and sanitize in-place
    validateConfig(snapshot, diagnostics);

    return snapshot;
  }

  getExtensionPath(): string {
    const extensionIdCandidates = [
      "code-ingest.code-ingest",
      "mrzeeshanahmed.code-ingest",
      "publisher.code-ingest"
    ];

    for (const id of extensionIdCandidates) {
      const extension = id ? vscode.extensions.getExtension(id) : undefined;
      if (extension?.extensionPath) {
        return extension.extensionPath;
      }
    }

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (workspaceFolder) {
      return workspaceFolder;
    }

    return path.resolve(process.cwd());
  }

  getGlobalValue<T>(key: string): T | undefined {
    const config = vscode.workspace.getConfiguration();
    return config.get<T>(key);
  }

  async updateGlobalValue(key: string, value: unknown): Promise<void> {
    const config = vscode.workspace.getConfiguration();
    await config.update(key, value, vscode.ConfigurationTarget.Global);
  }

  getRequiredVSCodeVersion(): string {
    if (this.cachedRequiredVSCodeVersion) {
      return this.cachedRequiredVSCodeVersion;
    }

    try {
      const manifestPath = path.join(this.getExtensionPath(), "package.json");
      const raw = fs.readFileSync(manifestPath, "utf8");
      const manifest = JSON.parse(raw) as { engines?: { vscode?: string } };
      const value = manifest.engines?.vscode;
      if (typeof value === "string" && value.trim().length > 0) {
        this.cachedRequiredVSCodeVersion = value.replace(/^[^0-9]*/, "");
        return this.cachedRequiredVSCodeVersion;
      }
    } catch (error) {
      this.diagnostics.addWarning?.(`Unable to read VS Code version requirement: ${(error as Error).message}`);
    }

    this.cachedRequiredVSCodeVersion = "1.74.0";
    return this.cachedRequiredVSCodeVersion;
  }
}
