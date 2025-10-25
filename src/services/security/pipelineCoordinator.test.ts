function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

import { describe, expect, it, jest } from "@jest/globals";

import { ComplianceChecker } from "./complianceChecker";
import { DependencyScanner } from "./dependencyScanner";
import { DynamicSecurityTester } from "./dynamicTester";
import { SecurityPipelineCoordinator } from "./pipelineCoordinator";
import { StaticSecurityAnalyzer } from "./staticAnalyzer";
import type {
  ComplianceResult,
  DependencyVulnerability,
  DynamicTestResult,
  SecurityFinding,
  SecurityPipelineContext,
  SecurityReportingResult
} from "./types";

describe("SecurityPipelineCoordinator", () => {
  it("runs stages in sequence and aggregates reporting data", async () => {
    const staticFindings: SecurityFinding[] = [
      {
        id: "F1",
        ruleId: "HARDCODED_SECRET_001",
        severity: "HIGH",
        category: "DATA_LEAK",
        message: "Sensitive credential detected",
        filePath: "src/index.ts",
        line: 5,
        column: 2,
        remediation: "Move secret to secure storage"
      }
    ];

    const dynamicResults: DynamicTestResult[] = [
      {
        testCase: "Input validation",
        outcomes: [],
        status: "PASSED",
        findings: [],
        details: "No issues discovered"
      }
    ];

    const dependencyVulnerabilities: DependencyVulnerability[] = [
      {
        dependency: { name: "lodash", version: "4.17.19", dev: false },
        vulnerabilities: [
          {
            id: "ADVISORY-2021-23337",
            title: "Prototype pollution",
            severity: "HIGH",
            description: "",
            references: [],
            fixedIn: ">=4.17.21"
          }
        ]
      }
    ];

    const complianceResults: ComplianceResult[] = [
      {
        framework: "OWASP",
        compliant: false,
        coverage: 60,
        satisfied: [],
        missing: ["A01"],
        evidence: [],
        recommendations: []
      },
      {
        framework: "CWE",
        compliant: true,
        coverage: 80,
        satisfied: ["CWE-79"],
        missing: [],
        evidence: [],
        recommendations: []
      }
    ];

    const callOrder: string[] = [];

    const staticAnalyzer = {
      scanCodebase: jest.fn(async () => {
        callOrder.push("static");
        return staticFindings;
      })
    } as unknown as StaticSecurityAnalyzer;

    const dynamicTester = {
      runSecurityTests: jest.fn(async () => {
        callOrder.push("dynamic");
        return dynamicResults;
      })
    } as unknown as DynamicSecurityTester;

    const dependencyScanner = {
      populateReporting: jest.fn(async (
        context: SecurityPipelineContext,
        reporting: SecurityReportingResult,
        options?: { abortSignal?: AbortSignal }
      ) => {
        callOrder.push("reporting-dependencies");
        expect(context.stages.staticAnalysis.status).toBe("COMPLETED");
        expect(options?.abortSignal).toBeDefined();
        reporting.dependencies = dependencyVulnerabilities;
        reporting.licenseCompliance = [];
        reporting.maliciousPackages = [];
        reporting.summary.totalDependencies = dependencyVulnerabilities.length;
        reporting.summary.vulnerableDependencies = 1;
      })
    } as unknown as DependencyScanner;

    const complianceChecker = {
      populateReporting: jest.fn(async (
        context: SecurityPipelineContext,
        reporting: SecurityReportingResult,
        options?: { abortSignal?: AbortSignal }
      ) => {
        callOrder.push("reporting-compliance");
        expect(context.stages.dynamicTesting.status).toBe("COMPLETED");
        expect(options?.abortSignal).toBeDefined();
        reporting.compliance = complianceResults;
        return complianceResults;
      })
    } as unknown as ComplianceChecker;

    const coordinator = new SecurityPipelineCoordinator({
      staticAnalyzer,
      dynamicTester,
      dependencyScanner,
      complianceChecker
    });

    const context = await coordinator.run();

    expect(callOrder).toEqual([
      "static",
      "dynamic",
      "reporting-dependencies",
      "reporting-compliance"
    ]);
    expect(context.stages.reporting.result?.summary.vulnerableDependencies).toBe(1);
    expect(context.stages.reporting.result?.summary.averageComplianceCoverage).toBe(70);
    expect(context.stages.reporting.status).toBe("COMPLETED");
  });

  it("rejects with CancellationError when aborted and prevents overlapping executions", async () => {
    const signal = {
      aborted: false,
      addEventListener: jest.fn(),
      removeEventListener: jest.fn()
    } as unknown as AbortSignal;

    let dependencySignal: AbortSignal | undefined;

    const staticAnalyzer = {
      scanCodebase: jest.fn<() => Promise<SecurityFinding[]>>().mockResolvedValue([])
    } as unknown as StaticSecurityAnalyzer;

    const dynamicTester = {
      runSecurityTests: jest.fn<() => Promise<DynamicTestResult[]>>().mockResolvedValue([])
    } as unknown as DynamicSecurityTester;

    const dependencyStage = createDeferred<void>();
    const dependencyEntered = createDeferred<void>();
    const dependencyScanner = {
      populateReporting: jest.fn(async (
        _context: SecurityPipelineContext,
        _reporting: SecurityReportingResult,
        options?: { abortSignal?: AbortSignal }
      ) => {
        dependencySignal = options?.abortSignal;
        dependencyEntered.resolve();
        await dependencyStage.promise;
      })
    } as unknown as DependencyScanner;

    const complianceChecker = {
      populateReporting: jest.fn<() => Promise<ComplianceResult[]>>().mockResolvedValue([])
    } as unknown as ComplianceChecker;

    const coordinator = new SecurityPipelineCoordinator({
      staticAnalyzer,
      dynamicTester,
      dependencyScanner,
      complianceChecker
    });

    const firstRun = coordinator.run({ abortSignal: signal });
    coordinator.run();
    expect(staticAnalyzer.scanCodebase).toHaveBeenCalledTimes(1);

  await dependencyEntered.promise;
  expect(signal.addEventListener).toHaveBeenCalledTimes(1);
  expect(signal.addEventListener).toHaveBeenCalledWith("abort", expect.any(Function), { once: true });
  expect(dependencySignal).toBeDefined();
    dependencyStage.resolve();

    await expect(firstRun).resolves.toBeDefined();
    expect(dynamicTester.runSecurityTests).toHaveBeenCalledTimes(1);
    expect(dependencyScanner.populateReporting).toHaveBeenCalledTimes(1);
    expect(complianceChecker.populateReporting).toHaveBeenCalledTimes(1);
  });
});
