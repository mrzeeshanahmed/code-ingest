import * as vscode from "vscode";

import { ComplianceChecker } from "./complianceChecker";
import { DependencyScanner } from "./dependencyScanner";
import { DynamicSecurityTester } from "./dynamicTester";
import { StaticSecurityAnalyzer } from "./staticAnalyzer";
import type {
  ComplianceResult,
  DependencyVulnerability,
  DynamicTestResult,
  SecurityFinding
} from "./types";

export interface SecurityPipelineContext {
  readonly staticFindings: SecurityFinding[];
  readonly dynamicResults: DynamicTestResult[];
  readonly dependencyResults: DependencyVulnerability[];
  readonly complianceResults: ComplianceResult[];
}

export interface SecurityPipelineDependencies {
  staticAnalyzer?: StaticSecurityAnalyzer;
  dynamicTester?: DynamicSecurityTester;
  dependencyScanner?: DependencyScanner;
  complianceChecker?: ComplianceChecker;
}

export class SecurityPipelineCoordinator {
  private readonly staticAnalyzer: StaticSecurityAnalyzer;
  private readonly dynamicTester: DynamicSecurityTester;
  private readonly dependencyScanner: DependencyScanner;
  private readonly complianceChecker: ComplianceChecker;
  private inFlightExecution: Promise<SecurityPipelineContext> | undefined;

  constructor(dependencies: SecurityPipelineDependencies = {}) {
    this.staticAnalyzer = dependencies.staticAnalyzer ?? new StaticSecurityAnalyzer();
    this.dynamicTester = dependencies.dynamicTester ?? new DynamicSecurityTester();
    this.dependencyScanner = dependencies.dependencyScanner ?? new DependencyScanner();
    this.complianceChecker = dependencies.complianceChecker ?? new ComplianceChecker();
  }

  async run(context?: { abortSignal?: AbortSignal }): Promise<SecurityPipelineContext> {
    if (context?.abortSignal?.aborted) {
      throw new vscode.CancellationError();
    }

    if (!this.inFlightExecution) {
      this.inFlightExecution = this.execute(context).finally(() => {
        this.inFlightExecution = undefined;
      });
    }

    if (context?.abortSignal) {
      context.abortSignal.addEventListener("abort", () => {
        this.inFlightExecution = undefined;
      }, { once: true });
    }

    return this.inFlightExecution;
  }

  private async execute(context?: { abortSignal?: AbortSignal }): Promise<SecurityPipelineContext> {
    const staticFindings = await this.staticAnalyzer.scanCodebase();
    this.throwIfCancelled(context?.abortSignal);

    const dynamicResults = await this.dynamicTester.runSecurityTests();
    this.throwIfCancelled(context?.abortSignal);

    const dependencyResults = await this.dependencyScanner.scanDependencies();
    this.throwIfCancelled(context?.abortSignal);

    const [owasp, cwe, dataProtection] = await Promise.all([
      this.complianceChecker.checkOWASPCompliance(),
      this.complianceChecker.checkCWECompliance(),
      this.complianceChecker.checkDataProtectionCompliance()
    ]);

    return {
      staticFindings,
      dynamicResults,
      dependencyResults,
      complianceResults: [owasp, cwe, dataProtection]
    } satisfies SecurityPipelineContext;
  }

  private throwIfCancelled(signal: AbortSignal | undefined): void {
    if (signal?.aborted) {
      throw new vscode.CancellationError();
    }
  }
}
