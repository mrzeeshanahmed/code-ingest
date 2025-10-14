import * as vscode from "vscode";

import { ComplianceChecker } from "./complianceChecker";
import { DependencyScanner } from "./dependencyScanner";
import { DynamicSecurityTester } from "./dynamicTester";
import { StaticSecurityAnalyzer } from "./staticAnalyzer";
import {
  createEmptySecurityReportingResult,
  type ComplianceResult,
  type DynamicTestResult,
  type SecurityFinding,
  type SecurityPipelineContext,
  type SecurityPipelineStageState,
  type SecurityReportingResult
} from "./types";

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
    const pipelineContext = this.createInitialContext();

    try {
      const staticStage = pipelineContext.stages.staticAnalysis;
      this.markStageRunning(staticStage);
      const staticFindings = await this.staticAnalyzer.scanCodebase();
      this.throwIfCancelled(context?.abortSignal);
      this.markStageCompleted(staticStage, staticFindings);

      const dynamicStage = pipelineContext.stages.dynamicTesting;
      this.markStageRunning(dynamicStage);
      const dynamicResults = await this.dynamicTester.runSecurityTests();
      this.throwIfCancelled(context?.abortSignal);
      this.markStageCompleted(dynamicStage, dynamicResults);

      const reportingStage = pipelineContext.stages.reporting;
      this.markStageRunning(reportingStage);
      const reportingResult = createEmptySecurityReportingResult();
      reportingStage.result = reportingResult;

      await this.dependencyScanner.populateReporting(pipelineContext, reportingResult);
      this.throwIfCancelled(context?.abortSignal);

      const complianceResults = await this.complianceChecker.populateReporting(pipelineContext, reportingResult);
      this.throwIfCancelled(context?.abortSignal);

      reportingResult.summary.averageComplianceCoverage = this.calculateAverageCoverage(complianceResults);
      reportingResult.generatedAt = new Date();
      this.markStageCompleted(reportingStage, reportingResult);

      return pipelineContext;
    } catch (error) {
      this.recordStageFailure(pipelineContext, error);
      throw error;
    }
  }

  private throwIfCancelled(signal: AbortSignal | undefined): void {
    if (signal?.aborted) {
      throw new vscode.CancellationError();
    }
  }

  private createInitialContext(): SecurityPipelineContext {
    return {
      stages: {
        staticAnalysis: { stage: "STATIC_ANALYSIS", status: "PENDING" } as SecurityPipelineStageState<SecurityFinding[]>,
        dynamicTesting: { stage: "DYNAMIC_TESTING", status: "PENDING" } as SecurityPipelineStageState<DynamicTestResult[]>,
        reporting: { stage: "REPORTING", status: "PENDING" } as SecurityPipelineStageState<SecurityReportingResult>
      }
    };
  }

  private markStageRunning<T>(stage: SecurityPipelineStageState<T>): void {
    stage.status = "RUNNING";
    stage.startedAt = new Date();
    delete stage.error;
  }

  private markStageCompleted<T>(stage: SecurityPipelineStageState<T>, result: T): void {
    stage.status = "COMPLETED";
    stage.completedAt = new Date();
    stage.result = result;
  }

  private recordStageFailure(context: SecurityPipelineContext, error: unknown): void {
    const failingStage = Object.values(context.stages).find((stage) => stage.status === "RUNNING" || stage.status === "PENDING");
    if (failingStage) {
      failingStage.status = "FAILED";
      failingStage.completedAt = new Date();
      failingStage.error = error instanceof Error ? error.message : String(error);
    }
  }

  private calculateAverageCoverage(compliance: ComplianceResult[]): number {
    if (compliance.length === 0) {
      return 0;
    }
    const total = compliance.reduce((sum, result) => sum + result.coverage, 0);
    return Math.round(total / compliance.length);
  }
}
