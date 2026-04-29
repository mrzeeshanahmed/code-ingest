import { execFile } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import * as vscode from "vscode";

import { ConfigurationService } from "./configurationService";
import type { ErrorReporter } from "./errorReporter";
import type {
  PerformanceMonitor,
  PerformanceMetrics,
  PerformanceReport,
  Bottleneck
} from "./performanceMonitor";
import type { GitProcessManager, Logger } from "../utils/gitProcessManager";

const execFileAsync = promisify(execFile);

export interface DiagnosticResult {
  category: "system" | "configuration" | "performance" | "connectivity" | "dependencies";
  name: string;
  status: "pass" | "warning" | "fail" | "info";
  message: string;
  details?: string;
  suggestion?: string;
  metadata?: Record<string, unknown>;
}

export interface SystemHealthReport {
  overall: "healthy" | "warning" | "critical";
  timestamp: Date;
  diagnostics: DiagnosticResult[];
  summary: {
    passed: number;
    warnings: number;
    failed: number;
  };
  recommendations: string[];
}

export interface DiagnosticCommand {
  id: string;
  title: string;
  description: string;
  category: string;
  execute(): Promise<DiagnosticResult[]>;
}

type ErrorReporterLike = Pick<ErrorReporter, "getErrorBuffer">;
type GitProcessManagerLike = Pick<GitProcessManager, "executeGitCommand">;

type DiskUsageInfo = {
  free: number;
  total: number;
};

type DiskUsageProvider = (workspacePath: string) => Promise<DiskUsageInfo | undefined>;
type NetworkTester = (url: string) => Promise<void>;
type ModuleResolver = (specifier: string, fromDirectory: string) => boolean;

async function defaultDiskUsageProvider(workspacePath: string): Promise<DiskUsageInfo | undefined> {
  try {
    if (process.platform === "win32") {
      const drive = path.parse(workspacePath).root.replace(/\\$/, "");
      if (!drive) {
        return undefined;
      }

      try {
        const { stdout } = await execFileAsync("wmic", [
          "logicaldisk",
          "where",
          `Caption='${drive}'`,
          "get",
          "Size,FreeSpace",
          "/format:value"
        ], { windowsHide: true });
        const freeMatch = stdout.match(/FreeSpace=(\d+)/i);
        const sizeMatch = stdout.match(/Size=(\d+)/i);
        if (!freeMatch || !sizeMatch) {
          return undefined;
        }
        const free = Number(freeMatch[1]);
        const total = Number(sizeMatch[1]);
        if (Number.isNaN(free) || Number.isNaN(total) || total <= 0) {
          return undefined;
        }
        return { free, total };
      } catch {
        return undefined;
      }
    }

    const { stdout } = await execFileAsync("df", ["-k", workspacePath]);
    const lines = stdout.trim().split(/\r?\n/);
    if (lines.length < 2) {
      return undefined;
    }
    const columns = lines[1].trim().split(/\s+/);
    if (columns.length < 4) {
      return undefined;
    }
    const total = Number.parseInt(columns[1], 10) * 1024;
    const free = Number.parseInt(columns[3], 10) * 1024;
    if (Number.isNaN(total) || Number.isNaN(free) || total <= 0) {
      return undefined;
    }
    return { free, total };
  } catch {
    return undefined;
  }
}

async function defaultNetworkTester(url: string): Promise<void> {
  void url;
}

function defaultModuleResolver(specifier: string, fromDirectory: string): boolean {
  try {
    const moduleRequire = createRequire(path.join(fromDirectory, "noop.js"));
    moduleRequire.resolve(specifier);
    return true;
  } catch {
    return false;
  }
}

export class SystemDiagnostics {
  constructor(
    private readonly configService: ConfigurationService,
    private readonly diskUsageProvider: DiskUsageProvider = defaultDiskUsageProvider
  ) {}

  async checkVSCodeVersion(): Promise<DiagnosticResult> {
    const currentVersion = vscode.version;
    const requiredVersion = this.configService.getRequiredVSCodeVersion();
    const isCompatible = this.compareVersions(currentVersion, requiredVersion) >= 0;

    const result: DiagnosticResult = {
      category: "system",
      name: "vscode-version",
      status: isCompatible ? "pass" : "fail",
      message: `VS Code version: ${currentVersion}`,
      metadata: { currentVersion, requiredVersion }
    };

    const details = `Required: ${requiredVersion}, Current: ${currentVersion}`;
    if (details) {
      result.details = details;
    }

    if (!isCompatible) {
      result.suggestion = "Please update VS Code to the latest version";
    }

    return result;
  }

  async checkNodeVersion(): Promise<DiagnosticResult> {
    const currentVersion = process.version;
    const recommendedMajor = 18;
    const currentMajor = Number.parseInt(currentVersion.replace(/^v/, ""), 10);

    let status: DiagnosticResult["status"] = "pass";
    let suggestion: string | undefined;

    if (Number.isNaN(currentMajor) || currentMajor < 16) {
      status = "fail";
      suggestion = "Node.js 16+ is required for optimal performance";
    } else if (currentMajor < recommendedMajor) {
      status = "warning";
      suggestion = `Node.js ${recommendedMajor}+ is recommended for best performance`;
    }

    const result: DiagnosticResult = {
      category: "system",
      name: "node-version",
      status,
      message: `Node.js version: ${currentVersion}`,
      metadata: { currentVersion, currentMajor, recommendedMajor }
    };

    if (suggestion) {
      result.suggestion = suggestion;
    }

    return result;
  }

  async checkMemoryUsage(): Promise<DiagnosticResult> {
    const usage = process.memoryUsage();
    const totalMemory = os.totalmem();
    const usagePercent = totalMemory === 0 ? 0 : (usage.heapUsed / totalMemory) * 100;

    let status: DiagnosticResult["status"] = "pass";
    let suggestion: string | undefined;

    if (usagePercent > 90) {
      status = "fail";
      suggestion = "Critical memory usage detected. Please restart VS Code.";
    } else if (usagePercent > 80) {
      status = "warning";
      suggestion = "High memory usage detected. Consider processing smaller file sets.";
    }

    const result: DiagnosticResult = {
      category: "system",
      name: "memory-usage",
      status,
      message: `Memory usage: ${this.formatBytes(usage.heapUsed)} (${usagePercent.toFixed(1)}%)`,
      metadata: {
        heapUsed: usage.heapUsed,
        totalMemory,
        usagePercent
      }
    };

    const details = `Heap: ${this.formatBytes(usage.heapUsed)}, Total: ${this.formatBytes(totalMemory)}`;
    result.details = details;

    if (suggestion) {
      result.suggestion = suggestion;
    }

    return result;
  }

  async checkDiskSpace(): Promise<DiagnosticResult> {
    const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspacePath) {
      return {
        category: "system",
        name: "disk-space",
        status: "info",
        message: "No workspace open - disk space check skipped"
      };
    }

    const usage = await this.diskUsageProvider(workspacePath);
    if (!usage) {
      return {
        category: "system",
        name: "disk-space",
        status: "info",
        message: "Unable to determine disk space for current workspace"
      };
    }

    const freePercent = usage.total === 0 ? 0 : (usage.free / usage.total) * 100;

    let status: DiagnosticResult["status"] = "pass";
    let suggestion: string | undefined;

    if (freePercent < 5) {
      status = "fail";
      suggestion = "Critical: Very low disk space. Free up space before continuing.";
    } else if (freePercent < 15) {
      status = "warning";
      suggestion = "Low disk space detected. Consider freeing up space.";
    }

    const result: DiagnosticResult = {
      category: "system",
      name: "disk-space",
      status,
      message: `Free disk space: ${this.formatBytes(usage.free)} (${freePercent.toFixed(1)}%)`,
      metadata: {
        freeBytes: usage.free,
        totalBytes: usage.total,
        freePercent
      }
    };

    if (suggestion) {
      result.suggestion = suggestion;
    }

    return result;
  }

  private formatBytes(bytes: number): string {
    const units = ["B", "KB", "MB", "GB", "TB"];
    let size = bytes;
    let unitIndex = 0;

    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex += 1;
    }

    return `${size.toFixed(1)} ${units[unitIndex]}`;
  }

  private compareVersions(version1: string, version2: string): number {
    const v1Parts = version1.split(".").map((part) => Number.parseInt(part, 10) || 0);
    const v2Parts = version2.split(".").map((part) => Number.parseInt(part, 10) || 0);
    const length = Math.max(v1Parts.length, v2Parts.length);

    for (let index = 0; index < length; index += 1) {
      const v1 = v1Parts[index] ?? 0;
      const v2 = v2Parts[index] ?? 0;
      if (v1 > v2) {
        return 1;
      }
      if (v1 < v2) {
        return -1;
      }
    }

    return 0;
  }
}

export class ConfigurationDiagnostics {
  constructor(private readonly configService: ConfigurationService) {}

  async validateConfiguration(): Promise<DiagnosticResult[]> {
    const config = this.configService.getConfig();
    const results: DiagnosticResult[] = [];

    if (typeof config.maxFiles === "number") {
      results.push(await this.checkMaxFiles(config.maxFiles));
    }

    if (typeof config.maxDepth === "number") {
      results.push(await this.checkMaxDepth(config.maxDepth));
    }

    if (typeof config.outputFormat === "string") {
      results.push(await this.checkOutputFormat(config.outputFormat));
    }

    if (typeof config.binaryFilePolicy === "string") {
      results.push(await this.checkBinaryFilePolicy(config.binaryFilePolicy));
    }

    const redactionPatterns = Array.isArray((config as Record<string, unknown>).redactionPatterns)
      ? ((config as Record<string, unknown>).redactionPatterns as string[])
      : [];
    results.push(await this.checkRedactionPatterns(redactionPatterns));

    return results;
  }

  private async checkMaxFiles(maxFiles: number): Promise<DiagnosticResult> {
    let status: DiagnosticResult["status"] = "pass";
    let suggestion: string | undefined;

    if (maxFiles < 1) {
      status = "fail";
      suggestion = "maxFiles must be at least 1";
    } else if (maxFiles > 50_000) {
      status = "warning";
      suggestion = "Very high maxFiles setting may cause performance issues";
    }

    const result: DiagnosticResult = {
      category: "configuration",
      name: "max-files",
      status,
      message: `Maximum files setting: ${maxFiles}`,
      metadata: { maxFiles }
    };

    if (suggestion) {
      result.suggestion = suggestion;
    }

    return result;
  }

  private async checkMaxDepth(maxDepth: number): Promise<DiagnosticResult> {
    let status: DiagnosticResult["status"] = "pass";
    let suggestion: string | undefined;

    if (maxDepth < 0) {
      status = "fail";
      suggestion = "maxDepth cannot be negative";
    } else if (maxDepth > 10) {
      status = "warning";
      suggestion = "Deep directory traversal may slow down scanning";
    }

    const result: DiagnosticResult = {
      category: "configuration",
      name: "max-depth",
      status,
      message: `Maximum depth setting: ${maxDepth}`,
      metadata: { maxDepth }
    };

    if (suggestion) {
      result.suggestion = suggestion;
    }

    return result;
  }

  private async checkOutputFormat(format: string): Promise<DiagnosticResult> {
    const allowed = new Set(["markdown", "json", "text"]);
    const status = allowed.has(format) ? "pass" : "warning";

    const result: DiagnosticResult = {
      category: "configuration",
      name: "output-format",
      status,
      message: `Output format: ${format}`,
      metadata: { format }
    };

    if (status === "warning") {
      result.suggestion = "Unsupported output format. Consider markdown or json.";
    }

    return result;
  }

  private async checkBinaryFilePolicy(policy: string): Promise<DiagnosticResult> {
    const allowed = new Set(["skip", "base64", "placeholder"]);
    const status = allowed.has(policy) ? "pass" : "warning";

    const result: DiagnosticResult = {
      category: "configuration",
      name: "binary-policy",
      status,
      message: `Binary file policy: ${policy}`,
      metadata: { policy }
    };

    if (status === "warning") {
      result.suggestion = "Unsupported binary file policy";
    }

    return result;
  }

  private async checkRedactionPatterns(patterns: string[]): Promise<DiagnosticResult> {
    const invalid: string[] = [];

    patterns.forEach((pattern) => {
      try {
        RegExp(pattern);
      } catch {
        invalid.push(pattern);
      }
    });

    const status: DiagnosticResult["status"] = invalid.length > 0 ? "fail" : "pass";
    const result: DiagnosticResult = {
      category: "configuration",
      name: "redaction-patterns",
      status,
      message: `Redaction patterns: ${patterns.length} configured`,
      metadata: {
        totalPatterns: patterns.length,
        invalidPatterns: invalid
      }
    };

    if (invalid.length > 0) {
      result.details = `Invalid patterns: ${invalid.join(", ")}`;
      result.suggestion = "Fix invalid regex patterns in redaction settings";
    }

    return result;
  }
}

export class PerformanceDiagnostics {
  constructor(
    private readonly performanceMonitor: PerformanceMonitor,
    private readonly errorReporter: ErrorReporterLike,
    private readonly logger: Logger
  ) {}

  async analyzePerformance(): Promise<DiagnosticResult[]> {
    const report = this.performanceMonitor.generateReport();
    const history = this.performanceMonitor.getMetricsHistory();

    return [
      this.checkAverageOperationTime(report),
      this.checkMemoryUsagePatterns(history),
      this.checkBottlenecks(report.bottlenecks),
      this.checkErrorRates(history)
    ];
  }

  private checkAverageOperationTime(report: PerformanceReport): DiagnosticResult {
    const averageDuration = report.overall.averageDuration ?? 0;

    let status: DiagnosticResult["status"] = "pass";
    let suggestion: string | undefined;

    if (averageDuration > 60_000) {
      status = "fail";
      suggestion = "Operations are extremely slow. Review system resources and configuration.";
    } else if (averageDuration > 30_000) {
      status = "warning";
      suggestion = "Operations are slower than expected. Consider optimising settings.";
    }

    const result: DiagnosticResult = {
      category: "performance",
      name: "operation-time",
      status,
      message: `Average operation time: ${(averageDuration / 1000).toFixed(1)}s`,
      metadata: { averageDuration }
    };

    if (suggestion) {
      result.suggestion = suggestion;
    }

    return result;
  }

  private checkMemoryUsagePatterns(history: PerformanceMetrics[]): DiagnosticResult {
    if (history.length === 0) {
      return {
        category: "performance",
        name: "memory-usage-patterns",
        status: "info",
        message: "No performance metrics recorded yet"
      };
    }

    const averagePeak = history.reduce((sum, metric) => sum + metric.memoryUsage.peak.heapUsed, 0) / history.length;
    const status: DiagnosticResult["status"] = averagePeak > 512 * 1024 * 1024 ? "warning" : "pass";
    const suggestion = status === "warning"
      ? "High average memory usage detected during operations. Consider reducing batch sizes."
      : undefined;

    const result: DiagnosticResult = {
      category: "performance",
      name: "memory-usage-patterns",
      status,
      message: `Average peak heap usage: ${(averagePeak / (1024 * 1024)).toFixed(1)} MB`,
      metadata: { averagePeak }
    };

    if (suggestion) {
      result.suggestion = suggestion;
    }

    return result;
  }

  private checkBottlenecks(bottlenecks: Bottleneck[]): DiagnosticResult {
    if (bottlenecks.length === 0) {
      return {
        category: "performance",
        name: "bottlenecks",
        status: "pass",
        message: "No performance bottlenecks detected"
      };
    }

    const highSeverity = bottlenecks.filter((b) => b.severity === "high");
    const status: DiagnosticResult["status"] = highSeverity.length > 0 ? "warning" : "info";
    const suggestion = highSeverity.length > 0
      ? "Address high-impact bottlenecks for better performance"
      : undefined;

    const result: DiagnosticResult = {
      category: "performance",
      name: "bottlenecks",
      status,
      message: `Performance bottlenecks: ${bottlenecks.length} detected`,
      metadata: {
        bottlenecks: bottlenecks.map((b) => ({ type: b.type, severity: b.severity }))
      }
    };

    const details = bottlenecks.map((b) => `${b.type}: ${b.description}`).join("\n");
    if (details) {
      result.details = details;
    }

    if (suggestion) {
      result.suggestion = suggestion;
    }

    return result;
  }

  private checkErrorRates(history: PerformanceMetrics[]): DiagnosticResult {
    const errors = this.errorReporter.getErrorBuffer();
    const operations = history.length;

    if (operations === 0) {
      return {
        category: "performance",
        name: "error-rate",
        status: "info",
        message: "No recorded operations yet"
      };
    }

    const errorRate = errors.length / operations;
    let status: DiagnosticResult["status"] = "pass";
    let suggestion: string | undefined;

    if (errorRate > 0.25) {
      status = "fail";
      suggestion = "High error rate detected. Review error logs for root causes.";
    } else if (errorRate > 0.1) {
      status = "warning";
      suggestion = "Elevated error rate detected. Investigate recent failures.";
    }

    const result: DiagnosticResult = {
      category: "performance",
      name: "error-rate",
      status,
      message: `Error rate: ${(errorRate * 100).toFixed(1)}%`,
      metadata: { errorRate, operations }
    };

    if (suggestion) {
      result.suggestion = suggestion;
    }

    return result;
  }
}

export class ConnectivityDiagnostics {
  constructor(
    private readonly gitProcessManager: GitProcessManagerLike,
    private readonly logger: Logger,
    private readonly networkTester: NetworkTester = defaultNetworkTester
  ) {}

  async checkGitAvailability(): Promise<DiagnosticResult> {
    try {
      const result = await this.gitProcessManager.executeGitCommand(["--version"], {
        cwd: os.tmpdir(),
        timeout: 5_000
      });
      const match = result.stdout.match(/git version (\d+\.\d+\.\d+)/i);
      const version = match?.[1] ?? "unknown";

      return {
        category: "connectivity",
        name: "git-availability",
        status: "pass",
        message: `Git is available: version ${version}`,
        metadata: { version, available: true }
      };
    } catch (error) {
      this.logger.warn("diagnostics.git.unavailable", { message: (error as Error).message });
      return {
        category: "connectivity",
        name: "git-availability",
        status: "fail",
        message: "Git is not available or not in PATH",
        details: (error as Error).message,
        suggestion: "Install Git and ensure it is in your system PATH",
        metadata: { available: false }
      };
    }
  }

  async checkNetworkConnectivity(): Promise<DiagnosticResult> {
    await this.networkTester("local-only");
    this.logger.info("diagnostics.network.skipped", {
      reason: "outbound connectivity checks are disabled for Code-Ingest"
    });

    return {
      category: "connectivity",
      name: "network-connectivity",
      status: "info",
      message: "Outbound connectivity checks are disabled.",
      details: "Code-Ingest runs with local-only networking and does not probe external endpoints.",
      metadata: {
        outboundChecksEnabled: false,
        testedEndpoints: 0
      }
    };
  }
}

export class DependencyDiagnostics {
  constructor(
    private readonly configService: ConfigurationService,
    private readonly resolver: ModuleResolver = defaultModuleResolver
  ) {}

  async checkNodeDependencies(): Promise<DiagnosticResult> {
    const baseDir = this.configService.getExtensionPath();
    const requiredPackages = ["minimatch", "zustand"];
    const missingPackages = requiredPackages.filter((pkg) => !this.resolver(pkg, baseDir));

    const status: DiagnosticResult["status"] = missingPackages.length > 0 ? "fail" : "pass";

    const message = missingPackages.length === 0
      ? "All required npm dependencies are available"
      : `Missing dependencies: ${missingPackages.join(", ")}`;

    const result: DiagnosticResult = {
      category: "dependencies",
      name: "node-dependencies",
      status,
      message,
      metadata: { missingPackages }
    };

    if (missingPackages.length > 0) {
      result.suggestion = "Reinstall extension dependencies or run npm install.";
    }

    return result;
  }
}

interface DiagnosticServiceOptions {
  systemDiagnostics?: SystemDiagnostics;
  configurationDiagnostics?: ConfigurationDiagnostics;
  performanceDiagnostics?: PerformanceDiagnostics;
  connectivityDiagnostics?: ConnectivityDiagnostics;
  dependencyDiagnostics?: DependencyDiagnostics;
}

export class DiagnosticService {
  private readonly commands = new Map<string, DiagnosticCommand>();
  private readonly systemDiagnostics: SystemDiagnostics;
  private readonly configurationDiagnostics: ConfigurationDiagnostics;
  private readonly performanceDiagnostics: PerformanceDiagnostics;
  private readonly connectivityDiagnostics: ConnectivityDiagnostics;
  private readonly dependencyDiagnostics: DependencyDiagnostics;

  constructor(
    private readonly configService: ConfigurationService,
    private readonly performanceMonitor: PerformanceMonitor,
    private readonly errorReporter: ErrorReporterLike,
    private readonly gitProcessManager: GitProcessManagerLike,
    private readonly logger: Logger,
    options: DiagnosticServiceOptions = {}
  ) {
    this.systemDiagnostics = options.systemDiagnostics ?? new SystemDiagnostics(this.configService);
    this.configurationDiagnostics = options.configurationDiagnostics ?? new ConfigurationDiagnostics(this.configService);
    this.performanceDiagnostics = options.performanceDiagnostics
      ?? new PerformanceDiagnostics(this.performanceMonitor, this.errorReporter, this.logger);
    this.connectivityDiagnostics = options.connectivityDiagnostics
      ?? new ConnectivityDiagnostics(this.gitProcessManager, this.logger);
    this.dependencyDiagnostics = options.dependencyDiagnostics ?? new DependencyDiagnostics(this.configService);

    this.registerDiagnosticCommands();
  }

  async runDiagnostics(categories?: string[]): Promise<SystemHealthReport> {
    const allDiagnostics: DiagnosticResult[] = [];

    for (const command of this.commands.values()) {
      if (!categories || categories.includes(command.category)) {
        try {
          this.logger.debug("diagnostics.command.start", { command: command.id });
          const results = await command.execute();
          allDiagnostics.push(...results);
          this.logger.debug("diagnostics.command.complete", { command: command.id });
        } catch (error) {
          const message = (error as Error).message ?? "Unknown error";
          this.logger.error("diagnostics.command.failed", { command: command.id, message });
          const failure: DiagnosticResult = {
            category: "system",
            name: command.id,
            status: "fail",
            message: `Diagnostic command failed: ${message}`
          };

          const stack = (error as Error).stack;
          if (stack) {
            failure.details = stack;
          }

          allDiagnostics.push(failure);
        }
      }
    }

    return this.generateHealthReport(allDiagnostics);
  }

  registerCommand(command: DiagnosticCommand): void {
    this.commands.set(command.id, command);
  }

  getAvailableCommands(): DiagnosticCommand[] {
    return Array.from(this.commands.values());
  }

  private registerDiagnosticCommands(): void {
    this.registerCommand({
      id: "system.health",
      title: "System Health",
      description: "Checks VS Code version, Node runtime, memory, and disk space",
      category: "system",
      execute: async () => [
        await this.systemDiagnostics.checkVSCodeVersion(),
        await this.systemDiagnostics.checkNodeVersion(),
        await this.systemDiagnostics.checkMemoryUsage(),
        await this.systemDiagnostics.checkDiskSpace()
      ]
    });

    this.registerCommand({
      id: "configuration.validation",
      title: "Configuration Validation",
      description: "Validates Code Ingest configuration for common issues",
      category: "configuration",
      execute: async () => await this.configurationDiagnostics.validateConfiguration()
    });

    this.registerCommand({
      id: "performance.analysis",
      title: "Performance Analysis",
      description: "Analyses recent performance metrics and error rates",
      category: "performance",
      execute: async () => await this.performanceDiagnostics.analyzePerformance()
    });

    this.registerCommand({
      id: "connectivity.checks",
      title: "Connectivity Checks",
      description: "Validates git availability and remote network connectivity",
      category: "connectivity",
      execute: async () => [
        await this.connectivityDiagnostics.checkGitAvailability(),
        await this.connectivityDiagnostics.checkNetworkConnectivity()
      ]
    });

    this.registerCommand({
      id: "dependencies.audit",
      title: "Dependencies Audit",
      description: "Ensures extension runtime dependencies are available",
      category: "dependencies",
      execute: async () => [await this.dependencyDiagnostics.checkNodeDependencies()]
    });
  }

  private generateHealthReport(diagnostics: DiagnosticResult[]): SystemHealthReport {
    const summary = diagnostics.reduce(
      (accumulator, diagnostic) => {
        if (diagnostic.status === "pass") {
          accumulator.passed += 1;
        } else if (diagnostic.status === "warning" || diagnostic.status === "info") {
          accumulator.warnings += diagnostic.status === "warning" ? 1 : 0;
        } else if (diagnostic.status === "fail") {
          accumulator.failed += 1;
        }
        return accumulator;
      },
      { passed: 0, warnings: 0, failed: 0 }
    );

    let overall: SystemHealthReport["overall"] = "healthy";
    if (summary.failed > 0) {
      overall = "critical";
    } else if (summary.warnings > 0) {
      overall = "warning";
    }

    const recommendations = diagnostics
      .map((diagnostic) => diagnostic.suggestion)
      .filter((suggestion): suggestion is string => Boolean(suggestion));

    return {
      overall,
      timestamp: new Date(),
      diagnostics,
      summary,
      recommendations
    };
  }
}