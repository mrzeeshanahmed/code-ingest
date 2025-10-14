import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import * as vscode from "vscode";

import { ConfigurationService } from "../configurationService";
import { ComplianceChecker } from "./complianceChecker";
import { DependencyScanner } from "./dependencyScanner";
import { DynamicSecurityTester } from "./dynamicTester";
import { SecurityPipelineCoordinator } from "./pipelineCoordinator";
import { SecurityReportGenerator } from "./reportGenerator";
import { SecurityAuditService } from "./securityAuditService";
import { StaticSecurityAnalyzer } from "./staticAnalyzer";
import { createEmptySecurityReportingResult, type SecurityPipelineContext } from "./types";

describe("SecurityAuditService", () => {
  const context = {
    globalStorageUri: vscode.Uri.file("/tmp")
  } as vscode.ExtensionContext;
  const configService = {
    get: jest.fn(),
    update: jest.fn()
  } as unknown as ConfigurationService;

  beforeEach(() => {
    jest.spyOn(StaticSecurityAnalyzer.prototype, "scanCodebase").mockResolvedValue([]);
    jest.spyOn(DynamicSecurityTester.prototype, "runSecurityTests").mockResolvedValue([]);
    jest.spyOn(DependencyScanner.prototype, "populateReporting").mockImplementation(async (_context, reporting) => {
      reporting.dependencies = [];
      reporting.licenseCompliance = [];
      reporting.maliciousPackages = [];
      reporting.summary.totalDependencies = 0;
      reporting.summary.vulnerableDependencies = 0;
    });
    jest.spyOn(ComplianceChecker.prototype, "populateReporting").mockImplementation(async (_context, reporting) => {
      const results = [
        {
          framework: "OWASP_TOP_10",
          compliant: true,
          coverage: 95,
          satisfied: [],
          missing: [],
          evidence: [],
          recommendations: []
        },
        {
          framework: "CWE_TOP_25",
          compliant: true,
          coverage: 90,
          satisfied: [],
          missing: [],
          evidence: [],
          recommendations: []
        },
        {
          framework: "DATA_PROTECTION",
          compliant: true,
          coverage: 92,
          satisfied: [],
          missing: [],
          evidence: [],
          recommendations: []
        }
      ];
      reporting.compliance = results;
      return results;
    });
    jest.spyOn(SecurityReportGenerator.prototype, "compileFullReport").mockResolvedValue({
        executiveSummary: "Security Overview",
        technicalDetails: "",
        complianceSummary: "",
        remediationPlan: "",
        artifacts: {
          executiveHtml: "",
          technicalHtml: "",
          complianceHtml: "",
          remediationHtml: "",
          executivePdfPath: vscode.Uri.file("/tmp/executive.pdf")
        }
      });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("performs comprehensive audit without throwing", async () => {
    const service = new SecurityAuditService(context, configService);
    const result = await service.performComprehensiveAudit();
    expect(result.categories.dataHandling.name).toBe("Data Handling");
    expect(result.vulnerabilities).toBeDefined();
    expect(result.recommendations).toBeDefined();
  });

  it("generates security report with markdown content", async () => {
    const service = new SecurityAuditService(context, configService);
    const report = await service.generateSecurityReport();
    expect(report.executiveSummary).toContain("Security Overview");
    expect(report.artifacts?.executivePdfPath).toBeDefined();
  });

  it("calculates risk aware status", async () => {
    const service = new SecurityAuditService(context, configService);
    const audit = await service.performComprehensiveAudit();
    expect(["SECURE", "VULNERABLE", "CRITICAL"]).toContain(audit.overall);
  });

  it("merges dependency and compliance data from shared context", async () => {
    const findings = [
      {
        id: "FINDING-1",
        ruleId: "HARDCODED_SECRET_001",
        severity: "HIGH" as const,
        category: "DATA_LEAK",
        message: "Sensitive data exposed",
        filePath: "src/index.ts",
        line: 10,
        column: 2,
        remediation: "Remove hardcoded secret"
      }
    ];

    const reportingResult = createEmptySecurityReportingResult();
    reportingResult.dependencies = [
      {
        dependency: { name: "lodash", version: "4.17.19", dev: false },
        vulnerabilities: [
          {
            id: "ADVISORY-2021-23337",
            title: "Prototype pollution in lodash",
            severity: "HIGH",
            description: "",
            references: [],
            fixedIn: ">=4.17.21"
          }
        ]
      }
    ];
    reportingResult.compliance = [
      {
        framework: "OWASP",
        compliant: false,
        coverage: 60,
        satisfied: [],
        missing: ["A01"],
        evidence: [],
        recommendations: []
      }
    ];
    reportingResult.summary.totalDependencies = 1;
    reportingResult.summary.vulnerableDependencies = 1;
    reportingResult.summary.averageComplianceCoverage = 60;
    reportingResult.generatedAt = new Date();

    const pipelineContext: SecurityPipelineContext = {
      stages: {
        staticAnalysis: {
          stage: "STATIC_ANALYSIS",
          status: "COMPLETED",
          startedAt: new Date(),
          completedAt: new Date(),
          result: findings
        },
        dynamicTesting: {
          stage: "DYNAMIC_TESTING",
          status: "COMPLETED",
          startedAt: new Date(),
          completedAt: new Date(),
          result: [
            {
              testCase: "Injection",
              outcomes: [],
              status: "PASSED",
              findings: [],
              details: ""
            }
          ]
        },
        reporting: {
          stage: "REPORTING",
          status: "COMPLETED",
          startedAt: new Date(),
          completedAt: new Date(),
          result: reportingResult
        }
      }
    };

    const pipelineCoordinator = {
      run: jest.fn(async () => pipelineContext)
    } as unknown as SecurityPipelineCoordinator;

    const service = new SecurityAuditService(context, configService, { pipelineCoordinator });
    const audit = await service.performComprehensiveAudit();

    expect(audit.categories.dependencyVulnerabilities.findings).toHaveLength(1);
    expect(audit.categories.complianceStatus.score).toBe(60);
    expect(audit.vulnerabilities.some((item) => item.id.includes("lodash"))).toBe(true);
  });
});
