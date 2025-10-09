import * as fs from "node:fs/promises";
import * as path from "node:path";

import { wrapError } from "../utils/errorHandling";
import type { GitProcessManager } from "../utils/gitProcessManager";
import { ContentProcessor } from "./contentProcessor";
import { FileScanner } from "./fileScanner";

export interface CommitAuthor {
  readonly name: string;
  readonly email: string;
}

export interface CommitInfo {
  readonly sha: string;
  readonly message: string;
  readonly author: CommitAuthor;
  readonly date: Date;
}

export interface FileInfo {
  readonly path: string;
  readonly relativePath: string;
  readonly name: string;
  readonly size: number;
  readonly extension: string;
  readonly isBinary: boolean;
  readonly modifiedAt?: Date;
}

export interface DirectoryInfo {
  readonly path: string;
  readonly relativePath: string;
  readonly depth: number;
  readonly fileCount: number;
  readonly totalSize: number;
}

export interface DependencyInfo {
  readonly name: string;
  readonly version?: string;
  readonly type: "runtime" | "dev" | "peer" | "build" | "unknown";
  readonly source?: string;
}

export interface PackageManagerInfo {
  readonly type: "npm" | "pip" | "maven" | "gradle" | "cargo" | "go" | "composer" | "nuget";
  readonly configFiles: string[];
  readonly lockFiles: string[];
  readonly dependencies: DependencyInfo[];
}

export interface FrameworkInfo {
  readonly name: string;
  readonly type: "web" | "mobile" | "desktop" | "backend" | "testing" | "build";
  readonly confidence: number;
  readonly indicators: string[];
}

export interface TechnicalDebtInfo {
  readonly duplicatedCode: number;
  readonly longMethods: number;
  readonly complexClasses: number;
  readonly smellsDetected: string[];
}

export interface PerformanceIndicator {
  readonly name: string;
  readonly description: string;
  readonly confidence: number;
}

export interface QualityMetrics {
  readonly testCoverage: number;
  readonly documentationScore: number;
  readonly codeComplexity: "low" | "medium" | "high";
  readonly maintainabilityIndex: number;
  readonly technicalDebt: TechnicalDebtInfo;
  readonly securityScore: number;
  readonly performanceIndicators: PerformanceIndicator[];
}

export interface RepositoryMetadata {
  readonly name: string;
  readonly description?: string;
  readonly defaultBranch: string;
  readonly size: number;
  readonly fileCount: number;
  readonly commitCount: number;
  readonly lastCommit: CommitInfo;
  readonly tags: string[];
  readonly branches: string[];
  readonly contributors: number;
  readonly createdAt?: Date;
  readonly updatedAt: Date;
  readonly license?: string;
  readonly readmeExists: boolean;
  readonly hasDocumentation: boolean;
}

export interface RepositoryStructure {
  readonly directories: DirectoryInfo[];
  readonly fileTypes: Map<string, number>;
  readonly largestFiles: FileInfo[];
  readonly binaryFiles: FileInfo[];
  readonly configFiles: FileInfo[];
  readonly testDirectories: string[];
  readonly sourceDirectories: string[];
  readonly buildArtifacts: string[];
  readonly packageManagers: PackageManagerInfo[];
  readonly hasReadme: boolean;
}

export interface LanguageAnalysis {
  readonly primary: string;
  readonly distribution: Map<string, number>;
  readonly frameworks: FrameworkInfo[];
  readonly dependencies: DependencyInfo[];
  readonly technicalStack: string[];
}

export interface RepositoryInsights {
  readonly healthScore: number;
  readonly strengths: string[];
  readonly risks: string[];
  readonly opportunities: string[];
  readonly summary: string;
}

export interface OptimizedSettings {
  readonly maxFiles: number;
  readonly binaryFilePolicy: "skip" | "base64" | "placeholder";
  readonly includeTests: boolean;
  readonly includeDocs: boolean;
  readonly sparseCheckoutPatterns: string[];
}

export interface ProcessingRecommendations {
  readonly suggestedFilters: string[];
  readonly priorityFiles: string[];
  readonly ignoredDirectories: string[];
  readonly optimizedSettings: OptimizedSettings;
  readonly warnings: string[];
}

export interface RepositoryAnalysis {
  readonly metadata: RepositoryMetadata;
  readonly structure: RepositoryStructure;
  readonly languages: LanguageAnalysis;
  readonly quality: QualityMetrics;
  readonly insights: RepositoryInsights;
  readonly recommendations: ProcessingRecommendations;
}

interface InternalFileRecord {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly name: string;
  readonly extension: string;
  readonly size: number;
  readonly mtime: Date;
  readonly isBinary: boolean;
}

interface InternalDirectoryRecord {
  readonly path: string;
  readonly relativePath: string;
  readonly depth: number;
  readonly fileCount: number;
  readonly totalSize: number;
}

interface RepositoryScanResult {
  readonly files: InternalFileRecord[];
  readonly directories: InternalDirectoryRecord[];
  readonly totalSize: number;
}

const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".bmp",
  ".ico",
  ".zip",
  ".gz",
  ".tar",
  ".7z",
  ".rar",
  ".pdf",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".bin",
  ".dat",
  ".class",
  ".jar",
  ".wasm",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf"
]);

const CONFIG_FILE_NAMES = new Set([
  "package.json",
  "tsconfig.json",
  "jsconfig.json",
  "pyproject.toml",
  "requirements.txt",
  "Pipfile",
  "setup.py",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "Cargo.toml",
  "go.mod",
  "composer.json",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "lerna.json",
  "webpack.config.js",
  "rollup.config.js",
  "vite.config.ts",
  "vite.config.js",
  "Makefile",
  "Dockerfile",
  "Gemfile",
  "Gemfile.lock",
  ".github/workflows",
  "azure-pipelines.yml"
]);

const TEST_DIRECTORY_PATTERNS = [/__tests__/i, /\btests?\b/i, /\bspecs?\b/i, /test-utils/i];
const SOURCE_DIRECTORY_PATTERNS = [/^src$/i, /^lib$/i, /^app$/i, /^packages$/i];
const BUILD_ARTIFACT_DIRECTORIES = ["dist", "build", "out", "coverage", "target", ".next", "public"].map((dir) => dir.toLowerCase());
const IGNORE_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "vendor",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".gitlab",
  ".svn",
  ".hg",
  ".idea",
  ".vscode",
  "tmp",
  "temp"
]);
const MAX_FILES_FOR_ANALYSIS = 5000;
const LARGEST_FILE_LIMIT = 10;
const FRAMEWORK_SOURCE_SAMPLE = 20;

/**
 * Extracts git metadata using a {@link GitProcessManager} wrapper.
 */
export class GitMetadataExtractor {
  constructor(private readonly gitProcessManager: GitProcessManager) {}

  async extractCommitInfo(repoPath: string): Promise<CommitInfo> {
    const result = await this.gitProcessManager.executeGitCommand(
      ["log", "-1", "--format=%H|%s|%an|%ae|%ad", "--date=iso"],
      { cwd: repoPath }
    );
    const [sha, message, authorName, authorEmail, date] = result.stdout.trim().split("|");
    return {
      sha: sha ?? "",
      message: message ?? "",
      author: {
        name: authorName ?? "",
        email: authorEmail ?? ""
      },
      date: date ? new Date(date) : new Date(0)
    } satisfies CommitInfo;
  }

  async countCommits(repoPath: string, since?: Date): Promise<number> {
    const args = ["rev-list", "--count", "HEAD"];
    if (since) {
      args.push(`--since=${since.toISOString()}`);
    }
    const result = await this.gitProcessManager.executeGitCommand(args, { cwd: repoPath });
    return Number.parseInt(result.stdout.trim(), 10) || 0;
  }

  async getBranches(repoPath: string): Promise<string[]> {
    const result = await this.gitProcessManager.executeGitCommand(
      ["branch", "-r", "--format=%(refname:short)"],
      { cwd: repoPath }
    );
    return result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((branch) => branch.replace(/^origin\//, ""));
  }

  async getTags(repoPath: string): Promise<string[]> {
    const result = await this.gitProcessManager.executeGitCommand(["tag", "--sort=-version:refname"], {
      cwd: repoPath
    });
    return result.stdout
      .split("\n")
      .map((tag) => tag.trim())
      .filter((tag) => tag.length > 0);
  }

  async getRepositorySize(repoPath: string): Promise<number> {
    const result = await this.gitProcessManager.executeGitCommand(["count-objects", "-vH"], {
      cwd: repoPath
    });
    const sizeMatch = result.stdout.match(/size-pack\s+(\d+)/);
    const sizeKiB = sizeMatch ? Number.parseInt(sizeMatch[1], 10) : 0;
    return sizeKiB * 1024;
  }

  async countContributors(repoPath: string): Promise<number> {
    const result = await this.gitProcessManager.executeGitCommand(["shortlog", "-sn", "HEAD"], {
      cwd: repoPath
    });
    return result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0).length;
  }

  async getDefaultBranch(repoPath: string): Promise<string> {
    try {
      const result = await this.gitProcessManager.executeGitCommand([
        "symbolic-ref",
        "--short",
        "HEAD"
      ], {
        cwd: repoPath
      });
      const branch = result.stdout.trim();
      if (branch) {
        return branch;
      }
    } catch {
      // Ignore and fall back to rev-parse.
    }
    const fallback = await this.gitProcessManager.executeGitCommand([
      "rev-parse",
      "--abbrev-ref",
      "HEAD"
    ], {
      cwd: repoPath
    });
    return fallback.stdout.trim() || "main";
  }

  async getFirstCommitDate(repoPath: string): Promise<Date | undefined> {
    try {
      const rootSha = await this.gitProcessManager.executeGitCommand(
        ["rev-list", "--max-parents=0", "HEAD"],
        { cwd: repoPath }
      );
      const sha = rootSha.stdout.trim().split("\n")[0];
      if (!sha) {
        return undefined;
      }
      const firstCommit = await this.gitProcessManager.executeGitCommand(
        ["show", "-s", "--format=%ad", "--date=iso", sha],
        { cwd: repoPath }
      );
      const date = firstCommit.stdout.trim();
      return date ? new Date(date) : undefined;
    } catch {
      return undefined;
    }
  }

  async getLicense(repoPath: string): Promise<string | undefined> {
    try {
      const result = await this.gitProcessManager.executeGitCommand(
        ["ls-files", "LICENSE*", "COPYING*"],
        { cwd: repoPath }
      );
      const first = result.stdout.split("\n").map((line) => line.trim()).find((line) => line.length > 0);
      if (!first) {
        return undefined;
      }
      const licensePath = path.join(repoPath, first);
      const contents = await fs.readFile(licensePath, "utf8");
      const firstLine = contents.split(/\r?\n/)[0]?.trim();
      return firstLine || "";
    } catch {
      return undefined;
    }
  }
}

class AdvancedLanguageDetector {
  constructor(private readonly contentProcessor: ContentProcessor) {}

  private readonly extensionMap = new Map<string, string>([
    [".js", "JavaScript"],
    [".ts", "TypeScript"],
    [".py", "Python"],
    [".java", "Java"],
    [".cpp", "C++"],
    [".c", "C"],
    [".cs", "C#"],
    [".go", "Go"],
    [".rs", "Rust"],
    [".rb", "Ruby"],
    [".php", "PHP"],
    [".swift", "Swift"],
    [".kt", "Kotlin"],
    [".scala", "Scala"],
    [".clj", "Clojure"],
    [".hs", "Haskell"],
    [".ml", "OCaml"],
    [".r", "R"],
    [".m", "Objective-C"],
    [".dart", "Dart"],
    [".tsx", "TypeScript"],
    [".jsx", "JavaScript"],
    [".sh", "Shell"],
    [".json", "JSON"],
    [".yaml", "YAML"],
    [".yml", "YAML"],
    [".md", "Markdown"]
  ]);

  private readonly filenamePatterns = new Map<string, RegExp>([
    ["Dockerfile", /^Dockerfile/i],
    ["Makefile", /^Makefile$/i],
    ["CMake", /^CMakeLists\.txt$/i]
  ]);

  async analyze(files: InternalFileRecord[]): Promise<Map<string, number>> {
    const distribution = new Map<string, number>();
    for (const file of files) {
      if (file.isBinary) {
        continue;
      }
      const language = await this.detectLanguage(file);
      if (!language) {
        continue;
      }
      const lines = await this.estimateLines(file);
      const current = distribution.get(language) ?? 0;
      distribution.set(language, current + lines);
    }
    return distribution;
  }

  private async detectLanguage(file: InternalFileRecord): Promise<string | undefined> {
    const extLanguage = this.extensionMap.get(file.extension);
    if (extLanguage) {
      return extLanguage;
    }
    for (const [language, pattern] of this.filenamePatterns.entries()) {
      if (pattern.test(file.name)) {
        return language;
      }
    }
    if (file.size > 200_000) {
      return undefined;
    }
    try {
      const content = await fs.readFile(file.absolutePath, "utf8");
      if (/^#!/.test(content)) {
        if (/python/.test(content)) {
          return "Python";
        }
        if (/node/.test(content)) {
          return "JavaScript";
        }
        if (/(bash|sh)/.test(content)) {
          return "Shell";
        }
      }
      if (/interface\s+\w+/.test(content) || /type\s+\w+\s*=/.test(content)) {
        return "TypeScript";
      }
      if (/class\s+\w+\s*:\s*\w+/.test(content) || /def\s+\w+\s*\(/.test(content)) {
        return "Python";
      }
      if (/public\s+class\s+\w+/.test(content) && /package\s+/.test(content)) {
        return "Java";
      }
    } catch {
      // ignore unreadable files
    }
    return undefined;
  }

  private async estimateLines(file: InternalFileRecord): Promise<number> {
    if (file.size > 1_000_000) {
      // Rough heuristic for huge files
      return Math.max(1, Math.floor(file.size / 40));
    }
    try {
      const content = await fs.readFile(file.absolutePath, "utf8");
      return this.contentProcessor.estimateLines(content);
    } catch {
      return Math.max(1, Math.floor(file.size / 60));
    }
  }
}

interface FrameworkConfig {
  readonly type: FrameworkInfo["type"];
  readonly patterns: string[];
  readonly files: string[];
  readonly indicators: RegExp[];
}

class FrameworkDetector {
  constructor(private readonly contentProcessor: ContentProcessor) {}

  private readonly frameworkPatterns = new Map<string, FrameworkConfig>([
    ["React", {
      type: "web" as const,
      patterns: ["react", "@types/react"],
      files: ["package.json"],
      indicators: [/from\s+['"]react['"]/]
    }],
    ["Vue.js", {
      type: "web" as const,
      patterns: ["vue", "@vue/"],
      files: ["package.json", "vue.config.js"],
      indicators: [/<template>/]
    }],
    ["Angular", {
      type: "web" as const,
      patterns: ["@angular/"],
      files: ["angular.json", "package.json"],
      indicators: [/@Component/, /@Injectable/]
    }],
    ["Express.js", {
      type: "backend" as const,
      patterns: ["express"],
      files: ["package.json"],
      indicators: [/require\(['"]express['"]\)/, /from\s+['"]express['"]/]
    }],
    ["Django", {
      type: "backend" as const,
      patterns: ["django", "Django"],
      files: ["requirements.txt", "Pipfile", "setup.py", "manage.py"],
      indicators: [/from\s+django\s+import/, /import\s+django/]
    }],
    ["Flask", {
      type: "backend" as const,
      patterns: ["flask", "Flask"],
      files: ["requirements.txt", "Pipfile", "setup.py"],
      indicators: [/from\s+flask\s+import/, /Flask\(__name__\)/]
    }],
    ["Spring Boot", {
      type: "backend" as const,
      patterns: ["spring-boot"],
      files: ["pom.xml", "build.gradle", "build.gradle.kts"],
      indicators: [/@SpringBootApplication/, /@RestController/]
    }]
  ]);

  async detectFrameworks(repoPath: string, files: InternalFileRecord[]): Promise<FrameworkInfo[]> {
    const frameworks: FrameworkInfo[] = [];
    const directoryFiles = new Map<string, InternalFileRecord>();
    for (const file of files) {
      directoryFiles.set(file.relativePath, file);
    }

    for (const [name, config] of this.frameworkPatterns.entries()) {
      let confidence = 0;
      const indicators: string[] = [];

      for (const configFile of config.files) {
        const match = files.find((file) => file.relativePath.endsWith(configFile));
        if (!match) {
          continue;
        }
        confidence += 0.3;
        indicators.push(`Config: ${configFile}`);
        try {
          const content = await fs.readFile(match.absolutePath, "utf8");
          const matched = config.patterns.filter((pattern) => content.includes(pattern));
          if (matched.length > 0) {
            confidence += 0.4;
            indicators.push(...matched.map((pattern) => `Dependency: ${pattern}`));
          }
        } catch {
          // ignore unreadable config files
        }
      }

      const candidateSources = files
        .filter((file) => file.relativePath.match(/\.(js|jsx|ts|tsx|py|java)$/i))
        .slice(0, FRAMEWORK_SOURCE_SAMPLE);
      let codeMatches = 0;
      for (const file of candidateSources) {
        try {
          const content = await fs.readFile(file.absolutePath, "utf8");
          if (config.indicators.some((indicator) => indicator.test(content))) {
            codeMatches += 1;
          }
        } catch {
          // ignore
        }
      }
      if (codeMatches > 0) {
        confidence += Math.min(codeMatches / Math.max(1, candidateSources.length), 0.3);
        indicators.push(`Matched code patterns in ${codeMatches} files`);
      }

      if (confidence > 0.2) {
        frameworks.push({
          name,
          type: config.type,
          confidence: Number(confidence.toFixed(2)),
          indicators
        });
      }
    }

    return frameworks.sort((a, b) => b.confidence - a.confidence);
  }
}

class QualityAnalyzer {
  constructor(private readonly contentProcessor: ContentProcessor) {}

  async analyzeQuality(repoPath: string, metadata: RepositoryMetadata, structure: RepositoryStructure): Promise<QualityMetrics> {
    const [testCoverage, documentation, complexity] = await Promise.all([
      this.estimateTestCoverage(structure),
      this.analyzeDocumentation(metadata, structure),
      this.analyzeComplexity(repoPath, structure)
    ]);

    const technicalDebt = await this.analyzeTechnicalDebt(repoPath, structure);
    const securityScore = await this.analyzeSecurityPractices(structure);
    const performanceIndicators = await this.analyzePerformanceIndicators(structure);

    return {
      testCoverage,
      documentationScore: documentation,
      codeComplexity: complexity,
      maintainabilityIndex: this.calculateMaintainabilityIndex(testCoverage, documentation, complexity),
      technicalDebt,
      securityScore,
      performanceIndicators
    } satisfies QualityMetrics;
  }

  private async estimateTestCoverage(structure: RepositoryStructure): Promise<number> {
    const testDirectories = new Set(structure.testDirectories);
    const sourceDirectories = new Set(structure.sourceDirectories);
    const testFiles = structure.directories
      .filter((dir) => testDirectories.has(dir.relativePath))
      .reduce((sum, dir) => sum + dir.fileCount, 0);
    const sourceFiles = structure.directories
      .filter((dir) => sourceDirectories.has(dir.relativePath))
      .reduce((sum, dir) => sum + dir.fileCount, 0);
    if (sourceFiles === 0) {
      return 0;
    }
    return Math.min(1, Number((testFiles / sourceFiles).toFixed(2)));
  }

  private async analyzeDocumentation(metadata: RepositoryMetadata, structure: RepositoryStructure): Promise<number> {
    let score = 0;
    if (metadata.readmeExists || structure.hasReadme) {
      score += 0.3;
    }
    const docsDirectoryExists = structure.directories.some((dir) =>
      ["docs", "doc", "documentation"].includes(path.basename(dir.relativePath).toLowerCase())
    );
    if (docsDirectoryExists) {
      score += 0.3;
    }
    const hasApiDocs = structure.configFiles.some((file) =>
      /(openapi|swagger|typedoc|jsdoc|redoc)/i.test(file.name)
    );
    if (hasApiDocs) {
      score += 0.2;
    }
    const commentDensity = await this.estimateCommentDensity(structure);
    score += Math.min(commentDensity, 0.2);
    return Math.min(1, Number(score.toFixed(2)));
  }

  private async estimateCommentDensity(structure: RepositoryStructure): Promise<number> {
    const sampleFiles = structure.largestFiles
      .filter((file) => !file.isBinary && file.extension.match(/\.(js|ts|py|java|cpp)$/i))
      .slice(0, 10);
    if (sampleFiles.length === 0) {
      return 0;
    }
    let totalLines = 0;
    let commentLines = 0;
    for (const file of sampleFiles) {
      try {
        const content = await fs.readFile(file.path, "utf8");
        const lines = content.split(/\r?\n/);
        totalLines += lines.length;
        commentLines += lines.filter((line) => line.trim().startsWith("//") || line.trim().startsWith("#") || line.trim().startsWith("/*") || line.trim().startsWith("*"))
          .length;
      } catch {
        // ignore
      }
    }
    if (totalLines === 0) {
      return 0;
    }
    return Number((commentLines / totalLines).toFixed(2));
  }

  private async analyzeComplexity(repoPath: string, structure: RepositoryStructure): Promise<"low" | "medium" | "high"> {
    const sourceFiles = structure.largestFiles.filter((file) =>
      file.extension.match(/\.(ts|js|py|java|cpp|cs|go|rs)$/i)
    );
    if (sourceFiles.length === 0) {
      return "low";
    }
    let complexityScore = 0;
    for (const file of sourceFiles.slice(0, 10)) {
      try {
        const content = await fs.readFile(file.path, "utf8");
        const lines = this.contentProcessor.estimateLines(content);
        const averageLineLength = lines > 0 ? content.length / lines : 0;
        if (lines > 500) {
          complexityScore += 2;
        } else if (lines > 200) {
          complexityScore += 1;
        }
        if (averageLineLength > 120) {
          complexityScore += 1;
        }
      } catch {
        // ignore
      }
    }
    if (complexityScore >= 8) {
      return "high";
    }
    if (complexityScore >= 4) {
      return "medium";
    }
    return "low";
  }

  private async analyzeTechnicalDebt(repoPath: string, structure: RepositoryStructure): Promise<TechnicalDebtInfo> {
    let duplicatedCode = 0;
    let longMethods = 0;
    let complexClasses = 0;
    const smells = new Set<string>();

    for (const file of structure.largestFiles.slice(0, 15)) {
      if (!file.extension.match(/\.(ts|js|py|java|cpp|cs|go|rs)$/i)) {
        continue;
      }
      try {
        const content = await fs.readFile(file.path, "utf8");
        const lines = content.split(/\r?\n/);
        const longFunctions = lines.filter((line) => line.trim().length > 0).length / Math.max(1, lines.length) > 0.5;
        if (longFunctions) {
          longMethods += 1;
          smells.add("Long or dense functions detected");
        }
        if (/TODO|FIXME|HACK/.test(content)) {
          duplicatedCode += 5;
          smells.add("TODO/FIXME markers present");
        }
        if (/class\s+\w+/.test(content) && content.split(/class\s+/).length > 4) {
          complexClasses += 1;
          smells.add("Multiple class declarations per file");
        }
      } catch {
        // ignore
      }
    }

    return {
      duplicatedCode: Math.min(100, duplicatedCode),
      longMethods,
      complexClasses,
      smellsDetected: Array.from(smells)
    } satisfies TechnicalDebtInfo;
  }

  private async analyzeSecurityPractices(structure: RepositoryStructure): Promise<number> {
    const hasSecurityPolicy = structure.configFiles.some((file) => /SECURITY\.md/i.test(file.name));
    const hasDependabot = structure.configFiles.some((file) => /dependabot\.yml/i.test(file.name));
    const hasWorkflows = structure.configFiles.some((file) => file.relativePath.startsWith(".github/workflows"));
    let score = 0;
    if (hasSecurityPolicy) {
      score += 0.4;
    }
    if (hasDependabot) {
      score += 0.3;
    }
    if (hasWorkflows) {
      score += 0.2;
    }
    if (structure.binaryFiles.length === 0) {
      score += 0.1;
    }
    return Number(Math.min(1, score).toFixed(2));
  }

  private async analyzePerformanceIndicators(structure: RepositoryStructure): Promise<PerformanceIndicator[]> {
    const indicators: PerformanceIndicator[] = [];
    if (structure.configFiles.some((file) => /webpack\.config|vite\.config|rollup\.config/.test(file.name))) {
      indicators.push({
        name: "Bundler configuration",
        description: "Custom bundler configuration detected, performance tuning likely applied.",
        confidence: 0.6
      });
    }
    if (structure.configFiles.some((file) => /tsconfig\.json/.test(file.name))) {
      indicators.push({
        name: "TypeScript project",
        description: "TypeScript configuration found, enabling type-driven optimisations.",
        confidence: 0.5
      });
    }
    if (structure.buildArtifacts.length > 0) {
      indicators.push({
        name: "Pre-built assets",
        description: "Build artefacts stored in repository, suggests optimisation focus.",
        confidence: 0.4
      });
    }
    return indicators;
  }

  private calculateMaintainabilityIndex(testCoverage: number, documentation: number, complexity: "low" | "medium" | "high"): number {
    const complexityScore = complexity === "low" ? 0.8 : complexity === "medium" ? 0.5 : 0.2;
    const index = (testCoverage * 0.35 + documentation * 0.25 + complexityScore * 0.4) * 100;
    return Number(Math.max(0, Math.min(100, index)).toFixed(0));
  }
}

class RecommendationEngine {
  generateRecommendations(analysis: RepositoryAnalysis): ProcessingRecommendations {
    const recommendations: ProcessingRecommendations = {
      suggestedFilters: [],
      priorityFiles: [],
      ignoredDirectories: [],
      optimizedSettings: this.getOptimizedSettings(analysis),
      warnings: []
    };

    this.addLanguageSpecificFilters(recommendations, analysis.languages);
    this.identifyPriorityFiles(recommendations, analysis.structure);
    this.suggestIgnoredDirectories(recommendations, analysis.structure);
    this.addWarnings(recommendations, analysis);

    return recommendations;
  }

  private getOptimizedSettings(analysis: RepositoryAnalysis): OptimizedSettings {
    const { metadata, structure } = analysis;
    let maxFiles = 1000;
    if (metadata.fileCount > 10_000) {
      maxFiles = 500;
    } else if (metadata.fileCount < 200) {
      maxFiles = metadata.fileCount;
    }
    const hasManyBinaries = structure.binaryFiles.length > metadata.fileCount * 0.1;
    const includeTests = analysis.quality.testCoverage > 0.3;
    const includeDocs = analysis.quality.documentationScore > 0.5;
    return {
      maxFiles,
      binaryFilePolicy: hasManyBinaries ? "skip" : "placeholder",
      includeTests,
      includeDocs,
      sparseCheckoutPatterns: this.generateSparseCheckoutPatterns(analysis)
    } satisfies OptimizedSettings;
  }

  private generateSparseCheckoutPatterns(analysis: RepositoryAnalysis): string[] {
    const patterns = new Set<string>(["*"]);
    for (const dir of analysis.structure.sourceDirectories) {
      patterns.add(`${dir}/**`);
    }
    if (analysis.quality.documentationScore > 0.5) {
      patterns.add("docs/**");
      patterns.add("documentation/**");
      patterns.add("*.md");
    }
    patterns.add("*.json");
    patterns.add("*.yml");
    patterns.add("*.yaml");
    patterns.add("*.toml");
    patterns.add("*.ini");
    return Array.from(patterns);
  }

  private addLanguageSpecificFilters(recommendations: ProcessingRecommendations, languages: LanguageAnalysis): void {
    if (languages.primary === "TypeScript") {
      recommendations.suggestedFilters.push("**/*.ts", "**/*.tsx");
    } else if (languages.primary === "Python") {
      recommendations.suggestedFilters.push("**/*.py");
    }
    if (languages.frameworks.some((fw) => fw.name === "React")) {
      recommendations.suggestedFilters.push("**/*.tsx", "**/*.jsx");
    }
  }

  private identifyPriorityFiles(recommendations: ProcessingRecommendations, structure: RepositoryStructure): void {
    const importantConfigs = structure.configFiles
      .filter((file) => /package\.json|pyproject\.toml|requirements\.txt|setup\.py|tsconfig\.json/.test(file.name))
      .map((file) => file.relativePath);
    recommendations.priorityFiles.push(...importantConfigs.slice(0, 10));
    const entryPoints = structure.largestFiles
      .filter((file) => /index\.(ts|js|py|java)$/i.test(file.name))
      .map((file) => file.relativePath);
    recommendations.priorityFiles.push(...entryPoints.slice(0, 10));
  }

  private suggestIgnoredDirectories(recommendations: ProcessingRecommendations, structure: RepositoryStructure): void {
    const ignoreCandidates = structure.directories
      .filter((dir) => BUILD_ARTIFACT_DIRECTORIES.includes(path.basename(dir.relativePath).toLowerCase()))
      .map((dir) => dir.relativePath);
    recommendations.ignoredDirectories.push(...ignoreCandidates);
  }

  private addWarnings(recommendations: ProcessingRecommendations, analysis: RepositoryAnalysis): void {
    if (analysis.quality.testCoverage < 0.2) {
      recommendations.warnings.push("Low estimated test coverage detected.");
    }
    if (analysis.quality.securityScore < 0.4) {
      recommendations.warnings.push("Security automation appears limited.");
    }
    if (analysis.structure.binaryFiles.length > 0) {
      recommendations.warnings.push("Repository contains binary assets that may need skipping.");
    }
  }
}

interface RepositoryScanContext {
  files: InternalFileRecord[];
  directories: InternalDirectoryRecord[];
  totalSize: number;
  processedFiles: number;
}

/**
 * Main entry-point for analysing repository metadata, structure and quality characteristics.
 */
export class RepositoryAnalyzer {
  private readonly gitMetadataExtractor: GitMetadataExtractor;
  private readonly languageDetector: AdvancedLanguageDetector;
  private readonly frameworkDetector: FrameworkDetector;
  private readonly qualityAnalyzer: QualityAnalyzer;
  private readonly recommendationEngine: RecommendationEngine;

  constructor(
    private readonly gitProcessManager: GitProcessManager,
    private readonly fileScanner: FileScanner,
    private readonly contentProcessor: ContentProcessor
  ) {
    this.gitMetadataExtractor = new GitMetadataExtractor(gitProcessManager);
    this.languageDetector = new AdvancedLanguageDetector(contentProcessor);
    this.frameworkDetector = new FrameworkDetector(contentProcessor);
    this.qualityAnalyzer = new QualityAnalyzer(contentProcessor);
    this.recommendationEngine = new RecommendationEngine();
  }

  async analyzeRepository(repoPath: string): Promise<RepositoryAnalysis> {
    try {
      const scanResult = await this.scanRepository(repoPath);
      const [metadata, structure, languages] = await Promise.all([
        this.analyzeMetadata(repoPath, scanResult),
        this.analyzeStructure(repoPath, scanResult),
        this.analyzeLanguages(repoPath, scanResult)
      ]);
      const quality = await this.qualityAnalyzer.analyzeQuality(repoPath, metadata, structure);
      const insights = this.generateInsights(metadata, structure, languages, quality);
      const recommendations = this.recommendationEngine.generateRecommendations({
        metadata,
        structure,
        languages,
        quality,
        insights,
        recommendations: {
          suggestedFilters: [],
          priorityFiles: [],
          ignoredDirectories: [],
          optimizedSettings: {
            maxFiles: 0,
            binaryFilePolicy: "skip",
            includeTests: false,
            includeDocs: false,
            sparseCheckoutPatterns: []
          },
          warnings: []
        }
      } as RepositoryAnalysis);
      return {
        metadata,
        structure,
        languages,
        quality,
        insights,
        recommendations
      };
    } catch (error) {
      throw wrapError(error, { scope: "repositoryAnalyzer", repoPath });
    }
  }

  private async analyzeMetadata(repoPath: string, scan: RepositoryScanResult): Promise<RepositoryMetadata> {
    const [commitInfo, commitCount, branches, tags, sizeBytes, contributors, defaultBranch, createdAt, license] = await Promise.all([
      this.gitMetadataExtractor.extractCommitInfo(repoPath),
      this.gitMetadataExtractor.countCommits(repoPath),
      this.gitMetadataExtractor.getBranches(repoPath),
      this.gitMetadataExtractor.getTags(repoPath),
      this.gitMetadataExtractor.getRepositorySize(repoPath),
      this.gitMetadataExtractor.countContributors(repoPath),
      this.gitMetadataExtractor.getDefaultBranch(repoPath),
      this.gitMetadataExtractor.getFirstCommitDate(repoPath),
      this.gitMetadataExtractor.getLicense(repoPath)
    ]);

    const readmeExists = scan.files.some((file) => /README/i.test(file.name));
    const hasDocumentation = scan.directories.some((dir) =>
      ["docs", "doc", "documentation"].includes(path.basename(dir.relativePath).toLowerCase())
    );

    const metadata: RepositoryMetadata = {
      name: path.basename(repoPath),
      defaultBranch,
      size: sizeBytes || scan.totalSize,
      fileCount: scan.files.length,
      commitCount,
      lastCommit: commitInfo,
      tags,
      branches,
      contributors,
      updatedAt: commitInfo.date,
      readmeExists,
      hasDocumentation,
      ...(createdAt ? { createdAt } : {}),
      ...(license ? { license } : {})
    };

    return metadata;
  }

  private async analyzeStructure(repoPath: string, scan: RepositoryScanResult): Promise<RepositoryStructure> {
    const largestFiles = [...scan.files]
      .sort((a, b) => b.size - a.size)
      .slice(0, LARGEST_FILE_LIMIT)
      .map((file) => this.toFileInfo(file));

    const binaryFiles = scan.files.filter((file) => file.isBinary).slice(0, 50).map((file) => this.toFileInfo(file));
    const configFiles = scan.files
      .filter((file) => CONFIG_FILE_NAMES.has(file.name) || file.relativePath.startsWith(".github/workflows"))
      .map((file) => this.toFileInfo(file));

    const fileTypes = new Map<string, number>();
    for (const file of scan.files) {
      const key = file.extension || "[no-ext]";
      fileTypes.set(key, (fileTypes.get(key) ?? 0) + 1);
    }

    const testDirectories = new Set<string>();
    const sourceDirectories = new Set<string>();
    const buildArtifacts = new Set<string>();

    for (const dir of scan.directories) {
      const dirName = path.basename(dir.relativePath).toLowerCase();
      if (TEST_DIRECTORY_PATTERNS.some((pattern) => pattern.test(dir.relativePath))) {
        testDirectories.add(dir.relativePath);
      }
      if (SOURCE_DIRECTORY_PATTERNS.some((pattern) => pattern.test(dirName)) || dir.fileCount > 0) {
        sourceDirectories.add(dir.relativePath);
      }
      if (BUILD_ARTIFACT_DIRECTORIES.includes(dirName)) {
        buildArtifacts.add(dir.relativePath);
      }
    }

    const packageManagers = await this.detectPackageManagers(repoPath, scan.files);

    return {
      directories: scan.directories,
      fileTypes,
      largestFiles,
      binaryFiles,
      configFiles,
      testDirectories: Array.from(testDirectories),
      sourceDirectories: Array.from(sourceDirectories),
      buildArtifacts: Array.from(buildArtifacts),
      packageManagers,
      hasReadme: scan.files.some((file) => /README/i.test(file.name))
    } satisfies RepositoryStructure;
  }

  private async analyzeLanguages(repoPath: string, scan: RepositoryScanResult): Promise<LanguageAnalysis> {
    const distribution = await this.languageDetector.analyze(scan.files.slice(0, MAX_FILES_FOR_ANALYSIS));
    const primary = Array.from(distribution.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "Unknown";
    const frameworks = await this.frameworkDetector.detectFrameworks(repoPath, scan.files);
    const dependencies = await this.collectDependencies(repoPath, scan.files);
    const technicalStack = this.buildTechnicalStack(primary, frameworks, dependencies);

    return {
      primary,
      distribution,
      frameworks,
      dependencies,
      technicalStack
    } satisfies LanguageAnalysis;
  }

  private generateInsights(
    metadata: RepositoryMetadata,
    structure: RepositoryStructure,
    languages: LanguageAnalysis,
    quality: QualityMetrics
  ): RepositoryInsights {
    const strengths: string[] = [];
    const risks: string[] = [];
    const opportunities: string[] = [];

    if (quality.testCoverage > 0.5) {
      strengths.push("Solid test coverage estimated.");
    } else {
      opportunities.push("Increase automated test coverage to improve confidence.");
    }

    if (languages.frameworks.length > 0) {
      strengths.push(`Frameworks detected: ${languages.frameworks.map((fw) => fw.name).join(", ")}.`);
    }

    if (structure.binaryFiles.length > 20) {
      risks.push("Large number of binary assets may slow processing.");
    }

    if (metadata.contributors < 3) {
      risks.push("Low contributor count may indicate knowledge silos.");
    }

    if (!metadata.hasDocumentation) {
      opportunities.push("Add dedicated documentation to accelerate onboarding.");
    }

    const healthScore = Number(
      (
        quality.maintainabilityIndex * 0.4 +
        quality.testCoverage * 30 +
        quality.documentationScore * 15 +
        quality.securityScore * 15
      ).toFixed(0)
    );

    const summary = `Primary language ${languages.primary} with ${metadata.fileCount} files across ${metadata.branches.length} branches.`;

    return {
      healthScore: Math.max(0, Math.min(100, healthScore)),
      strengths,
      risks,
      opportunities,
      summary
    } satisfies RepositoryInsights;
  }

  private toFileInfo(file: InternalFileRecord): FileInfo {
    return {
      path: file.absolutePath,
      relativePath: file.relativePath,
      name: file.name,
      size: file.size,
      extension: file.extension,
      isBinary: file.isBinary,
      modifiedAt: file.mtime
    } satisfies FileInfo;
  }

  private async detectPackageManagers(repoPath: string, files: InternalFileRecord[]): Promise<PackageManagerInfo[]> {
    const packageManagers: PackageManagerInfo[] = [];
    const fileMap = new Map(files.map((file) => [file.relativePath, file] as const));

    const npmConfig = fileMap.get("package.json");
    if (npmConfig) {
      const lockFiles = ["package-lock.json", "yarn.lock", "pnpm-lock.yaml"].filter((file) => fileMap.has(file));
      packageManagers.push({
        type: "npm",
        configFiles: [npmConfig.relativePath],
        lockFiles,
        dependencies: await this.readPackageJsonDependencies(repoPath, npmConfig)
      });
    }

    const pipConfig = ["requirements.txt", "Pipfile", "setup.py"].filter((file) => fileMap.has(file));
    if (pipConfig.length > 0) {
      packageManagers.push({
        type: "pip",
        configFiles: pipConfig,
        lockFiles: [],
        dependencies: await this.readRequirementsDependencies(repoPath, pipConfig)
      });
    }

    const mavenConfig = fileMap.get("pom.xml");
    if (mavenConfig) {
      packageManagers.push({
        type: "maven",
        configFiles: [mavenConfig.relativePath],
        lockFiles: [],
        dependencies: []
      });
    }

    const gradleConfig = ["build.gradle", "build.gradle.kts"].filter((file) => fileMap.has(file));
    if (gradleConfig.length > 0) {
      packageManagers.push({
        type: "gradle",
        configFiles: gradleConfig,
        lockFiles: [],
        dependencies: []
      });
    }

    const cargoConfig = fileMap.get("Cargo.toml");
    if (cargoConfig) {
      packageManagers.push({
        type: "cargo",
        configFiles: [cargoConfig.relativePath],
        lockFiles: fileMap.has("Cargo.lock") ? ["Cargo.lock"] : [],
        dependencies: []
      });
    }

    const goConfig = fileMap.get("go.mod");
    if (goConfig) {
      packageManagers.push({
        type: "go",
        configFiles: [goConfig.relativePath],
        lockFiles: fileMap.has("go.sum") ? ["go.sum"] : [],
        dependencies: await this.readGoModDependencies(repoPath, goConfig)
      });
    }

    const composerConfig = fileMap.get("composer.json");
    if (composerConfig) {
      packageManagers.push({
        type: "composer",
        configFiles: [composerConfig.relativePath],
        lockFiles: fileMap.has("composer.lock") ? ["composer.lock"] : [],
        dependencies: await this.readComposerDependencies(repoPath, composerConfig)
      });
    }

    const nugetConfig = files.filter((file) => file.relativePath.endsWith(".csproj") || file.name === "packages.config");
    if (nugetConfig.length > 0) {
      packageManagers.push({
        type: "nuget",
        configFiles: nugetConfig.map((file) => file.relativePath),
        lockFiles: [],
        dependencies: []
      });
    }

    return packageManagers;
  }

  private async collectDependencies(repoPath: string, files: InternalFileRecord[]): Promise<DependencyInfo[]> {
    const packageManagers = await this.detectPackageManagers(repoPath, files);
    const dependencies = new Map<string, DependencyInfo>();
    for (const manager of packageManagers) {
      for (const dependency of manager.dependencies) {
        if (!dependencies.has(dependency.name)) {
          dependencies.set(dependency.name, dependency);
        }
      }
    }
    return Array.from(dependencies.values());
  }

  private buildTechnicalStack(primaryLanguage: string, frameworks: FrameworkInfo[], dependencies: DependencyInfo[]): string[] {
    const stack = new Set<string>();
    if (primaryLanguage !== "Unknown") {
      stack.add(primaryLanguage);
    }
    for (const framework of frameworks) {
      stack.add(`${framework.name} (${framework.type})`);
    }
    const notableDependencies = dependencies
      .filter((dependency) => dependency.type === "runtime" || dependency.type === "unknown")
      .slice(0, 10)
      .map((dependency) => dependency.name);
    for (const dependency of notableDependencies) {
      stack.add(dependency);
    }
    return Array.from(stack);
  }

  private async readPackageJsonDependencies(repoPath: string, file: InternalFileRecord): Promise<DependencyInfo[]> {
    try {
      const fullPath = path.join(repoPath, file.relativePath);
      const content = await fs.readFile(fullPath, "utf8");
      const json = JSON.parse(content) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
      };
      const dependencies: DependencyInfo[] = [];
      for (const [name, version] of Object.entries(json.dependencies ?? {})) {
        dependencies.push({ name, version, type: "runtime", source: "package.json" });
      }
      for (const [name, version] of Object.entries(json.devDependencies ?? {})) {
        dependencies.push({ name, version, type: "dev", source: "package.json" });
      }
      for (const [name, version] of Object.entries(json.peerDependencies ?? {})) {
        dependencies.push({ name, version, type: "peer", source: "package.json" });
      }
      return dependencies;
    } catch {
      return [];
    }
  }

  private async readRequirementsDependencies(repoPath: string, files: string[]): Promise<DependencyInfo[]> {
    const dependencies: DependencyInfo[] = [];
    for (const fileRelPath of files) {
      try {
        const fullPath = path.join(repoPath, fileRelPath);
        const content = await fs.readFile(fullPath, "utf8");
        const lines = content.split(/\r?\n/);
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith("#")) {
            continue;
          }
          const [name, version] = trimmed.split(/==|>=|<=|~=|!=/);
          dependencies.push({ name: name ?? trimmed, version, type: "runtime", source: fileRelPath });
        }
      } catch {
        // ignore unreadable requirements
      }
    }
    return dependencies;
  }

  private async readGoModDependencies(repoPath: string, file: InternalFileRecord): Promise<DependencyInfo[]> {
    try {
      const fullPath = path.join(repoPath, file.relativePath);
      const content = await fs.readFile(fullPath, "utf8");
      const dependencies: DependencyInfo[] = [];
      const match = content.match(/require\s*\(([^)]+)\)/m);
      if (match) {
        const lines = match[1]?.split(/\r?\n/) ?? [];
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) {
            continue;
          }
          const [name, version] = trimmed.split(/\s+/);
          dependencies.push({ name, version, type: "runtime", source: file.relativePath });
        }
      }
      return dependencies;
    } catch {
      return [];
    }
  }

  private async readComposerDependencies(repoPath: string, file: InternalFileRecord): Promise<DependencyInfo[]> {
    try {
      const fullPath = path.join(repoPath, file.relativePath);
      const content = await fs.readFile(fullPath, "utf8");
      const json = JSON.parse(content) as {
        require?: Record<string, string>;
        "require-dev"?: Record<string, string>;
      };
      const dependencies: DependencyInfo[] = [];
      for (const [name, version] of Object.entries(json.require ?? {})) {
        dependencies.push({ name, version, type: "runtime", source: file.relativePath });
      }
      for (const [name, version] of Object.entries(json["require-dev"] ?? {})) {
        dependencies.push({ name, version, type: "dev", source: file.relativePath });
      }
      return dependencies;
    } catch {
      return [];
    }
  }

  private async scanRepository(repoPath: string): Promise<RepositoryScanResult> {
    const context: RepositoryScanContext = {
      files: [],
      directories: [],
      totalSize: 0,
      processedFiles: 0
    };

    await this.walkDirectory(repoPath, repoPath, 0, context);

    return {
      files: context.files,
      directories: context.directories,
      totalSize: context.totalSize
    } satisfies RepositoryScanResult;
  }

  private async walkDirectory(
    root: string,
    current: string,
    depth: number,
    context: RepositoryScanContext
  ): Promise<{ fileCount: number; totalSize: number }> {
    const entries = await fs.readdir(current, { withFileTypes: true });
    let directoryFileCount = 0;
    let directorySize = 0;

    for (const entry of entries) {
      if (IGNORE_DIRECTORIES.has(entry.name) && entry.isDirectory()) {
        continue;
      }
      const absolutePath = path.join(current, entry.name);
      const relativePath = path.relative(root, absolutePath) || entry.name;
      if (entry.isDirectory()) {
        const child = await this.walkDirectory(root, absolutePath, depth + 1, context);
        if (relativePath) {
          context.directories.push({
            path: absolutePath,
            relativePath,
            depth: depth + 1,
            fileCount: child.fileCount,
            totalSize: child.totalSize
          });
        }
        directoryFileCount += child.fileCount;
        directorySize += child.totalSize;
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const stats = await fs.stat(absolutePath);
      directoryFileCount += 1;
      directorySize += stats.size;
      context.totalSize += stats.size;
      context.processedFiles += 1;
      if (context.processedFiles > MAX_FILES_FOR_ANALYSIS && depth > 3) {
        continue;
      }
      const extension = path.extname(entry.name).toLowerCase();
      const isBinary = BINARY_EXTENSIONS.has(extension);
      context.files.push({
        absolutePath,
        relativePath,
        name: entry.name,
        extension,
        size: stats.size,
        mtime: stats.mtime,
        isBinary
      });
    }

    return { fileCount: directoryFileCount, totalSize: directorySize };
  }
}
