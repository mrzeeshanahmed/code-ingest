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
  private currentAbortController: AbortController | undefined;

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

    if (this.inFlightExecution) {
      return this.inFlightExecution;
    }

    const abortController = new AbortController();
    const cleanUpLinkedSignal = this.linkExternalAbortSignal(context?.abortSignal, abortController);
    this.currentAbortController = abortController;

    const execution = this.execute(abortController.signal);
    this.inFlightExecution = execution;
    void execution.catch(() => undefined);

    void execution.finally(() => {
      cleanUpLinkedSignal?.();
      if (this.inFlightExecution === execution) {
        this.inFlightExecution = undefined;
      }
      if (this.currentAbortController === abortController) {
        this.currentAbortController = undefined;
      }
    });

    return execution;
  }

  private async execute(abortSignal: AbortSignal): Promise<SecurityPipelineContext> {
    const pipelineContext = this.createInitialContext();

    try {
      const staticStage = pipelineContext.stages.staticAnalysis;
      this.markStageRunning(staticStage);
      const staticFindings = await this.runStageWithCancellation(() => this.staticAnalyzer.scanCodebase(), abortSignal);
      this.markStageCompleted(staticStage, staticFindings);
      this.throwIfCancelled(abortSignal);

      const dynamicStage = pipelineContext.stages.dynamicTesting;
      this.markStageRunning(dynamicStage);
      const dynamicResults = await this.runStageWithCancellation(() => this.dynamicTester.runSecurityTests(), abortSignal);
      this.markStageCompleted(dynamicStage, dynamicResults);
      this.throwIfCancelled(abortSignal);

      const reportingStage = pipelineContext.stages.reporting;
      this.markStageRunning(reportingStage);
      const reportingResult = createEmptySecurityReportingResult();
      reportingStage.result = reportingResult;

      await this.runStageWithCancellation(
        () => this.dependencyScanner.populateReporting(pipelineContext, reportingResult, { abortSignal }),
        abortSignal
      );
      this.throwIfCancelled(abortSignal);

      const complianceResults = await this.runStageWithCancellation(
        () => this.complianceChecker.populateReporting(pipelineContext, reportingResult, { abortSignal }),
        abortSignal
      );
      this.throwIfCancelled(abortSignal);

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

  private linkExternalAbortSignal(signal: AbortSignal | undefined, controller: AbortController): (() => void) | undefined {
    if (!signal) {
      return undefined;
    }

    if (signal.aborted) {
      controller.abort();
      return undefined;
    }

    const handleAbort = () => {
      controller.abort();
    };
    signal.addEventListener("abort", handleAbort, { once: true });

    return () => {
      signal.removeEventListener("abort", handleAbort);
    };
  }

  private async runStageWithCancellation<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
    this.throwIfCancelled(signal);
    const result = await operation();
    this.throwIfCancelled(signal);
    return result;
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
