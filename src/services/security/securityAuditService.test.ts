import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

import { ConfigurationService } from "../configurationService";
import { ComplianceChecker } from "./complianceChecker";
import { DependencyScanner } from "./dependencyScanner";
import { DynamicSecurityTester } from "./dynamicTester";
import { SecurityPipelineCoordinator } from "./pipelineCoordinator";
import { SecurityReportGenerator } from "./reportGenerator";
import { SecurityAuditService } from "./securityAuditService";
import { StaticSecurityAnalyzer } from "./staticAnalyzer";
import {
  createEmptySecurityReportingResult,
  type CategoryResult,
  type SecurityAuditResult,
  type SecurityPipelineContext
} from "./types";

function buildCategory(overrides: Partial<CategoryResult>): CategoryResult {
  return {
    name: overrides.name ?? "Category",
    status: overrides.status ?? "SECURE",
    score: overrides.score ?? 95,
    summary: overrides.summary ?? "",
    findings: overrides.findings ?? [],
    recommendations: overrides.recommendations ?? []
  };
}

function createMinimalAuditResult(): SecurityAuditResult {
  const categories: SecurityAuditResult["categories"] = {
    dataHandling: buildCategory({ name: "Data Handling" }),
    inputValidation: buildCategory({ name: "Input Validation" }),
    processExecution: buildCategory({ name: "Process Execution" }),
    webviewSecurity: buildCategory({ name: "Webview Security" }),
    fileSystemAccess: buildCategory({ name: "File System Access" }),
    cryptographicSecurity: buildCategory({ name: "Cryptographic Security" }),
    dependencyVulnerabilities: buildCategory({ name: "Dependency Security" }),
    complianceStatus: buildCategory({ name: "Compliance" })
  };

  return {
    overall: "SECURE",
    score: 95,
    timestamp: new Date(),
    categories,
    vulnerabilities: [],
    recommendations: []
  };
}

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
    jest.spyOn(DependencyScanner.prototype, "populateReporting").mockImplementation(async (_context, reporting, options) => {
      if (options?.abortSignal?.aborted) {
        throw new vscode.CancellationError();
      }
      reporting.dependencies = [];
      reporting.licenseCompliance = [];
      reporting.maliciousPackages = [];
      reporting.summary.totalDependencies = 0;
      reporting.summary.vulnerableDependencies = 0;
    });
    jest.spyOn(ComplianceChecker.prototype, "populateReporting").mockImplementation(async (_context, reporting, options) => {
      if (options?.abortSignal?.aborted) {
        throw new vscode.CancellationError();
      }
      const results = [
        {
          framework: "OWASP Top 10 2021",
          compliant: true,
          coverage: 95,
          satisfied: [],
          missing: [],
          evidence: [],
          recommendations: []
        },
        {
          framework: "CWE Top 25 2024",
          compliant: true,
          coverage: 90,
          satisfied: [],
          missing: [],
          evidence: [],
          recommendations: []
        },
        {
          framework: "Data Protection Essentials",
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
    expect(["SECURE", "WARNING", "VULNERABLE", "CRITICAL"]).toContain(audit.overall);
  });

  it("summarizes compliance coverage with canonical framework identifiers", async () => {
    const service = new SecurityAuditService(context, configService);
    const audit = await service.performComprehensiveAudit();
    const summary = audit.categories.complianceStatus.summary;
    expect(summary).toContain("OWASP coverage 95%");
    expect(summary).toContain("CWE coverage 90%");
    expect(summary).toContain("Data protection coverage 92%");
  });

  it("replaces templated placeholders when generating HTML artifacts", async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "code-ingest-report-"));
    const originalCwd = process.cwd();
    process.chdir(tempDir);

    try {
      const generator = new SecurityReportGenerator(createMinimalAuditResult());
      const html = await generator.generateHTML("<section>{{ content }}</section><p>{{content}}</p>", {
        content: "Rendered Output"
      });

      expect(html).toContain("Rendered Output");
      expect(html).not.toContain("{{");

      const stored = await fsp.readFile(path.join(tempDir, "out", "security-reports", "report.html"), "utf8");
      expect(stored).toContain("Rendered Output");
    } finally {
      process.chdir(originalCwd);
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("records generated executive PDF artifact path", async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "code-ingest-report-"));
    const originalCwd = process.cwd();
    process.chdir(tempDir);

    try {
      const generator = new SecurityReportGenerator(createMinimalAuditResult());
  const report = await generator.compileFullReport();
  expect(report.artifacts).toBeDefined();
  const pdfUri = report.artifacts!.executivePdfPath;

      expect(pdfUri).toBeDefined();
      const pdfPath = pdfUri!.fsPath;
      expect(pdfPath).toMatch(/executive-summary\.pdf$/);

      const pdfStat = await fsp.stat(pdfPath);
      expect(pdfStat.size).toBeGreaterThan(0);
    } finally {
      process.chdir(originalCwd);
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("classifies overall posture using warning band for intermediate scores", () => {
    const service = new SecurityAuditService(context, configService);
    const categories: SecurityAuditResult["categories"] = {
      dataHandling: buildCategory({ score: 78, status: "WARNING" }),
      inputValidation: buildCategory({ score: 82, status: "WARNING" }),
      processExecution: buildCategory({ score: 85, status: "WARNING" }),
      webviewSecurity: buildCategory({ score: 90, status: "SECURE" }),
      fileSystemAccess: buildCategory({ score: 88, status: "WARNING" }),
      cryptographicSecurity: buildCategory({ score: 92, status: "SECURE" }),
      dependencyVulnerabilities: buildCategory({ score: 86, status: "WARNING" }),
      complianceStatus: buildCategory({ score: 80, status: "WARNING" })
    };

    const resolver = (service as unknown as {
      resolveOverallStatus: (
        cats: SecurityAuditResult["categories"],
        score: number
      ) => SecurityAuditResult["overall"];
    }).resolveOverallStatus.bind(service);

    const overall = resolver(categories, 85);
    expect(overall).toBe("WARNING");
  });

  it("escalates to vulnerable when vulnerable categories exist in the warning band", () => {
    const service = new SecurityAuditService(context, configService);
    const categories: SecurityAuditResult["categories"] = {
      dataHandling: buildCategory({ score: 78, status: "WARNING" }),
      inputValidation: buildCategory({ score: 82, status: "WARNING" }),
      processExecution: buildCategory({ score: 85, status: "WARNING" }),
      webviewSecurity: buildCategory({ score: 70, status: "VULNERABLE" }),
      fileSystemAccess: buildCategory({ score: 88, status: "WARNING" }),
      cryptographicSecurity: buildCategory({ score: 92, status: "SECURE" }),
      dependencyVulnerabilities: buildCategory({ score: 86, status: "WARNING" }),
      complianceStatus: buildCategory({ score: 80, status: "WARNING" })
    };

    const resolver = (service as unknown as {
      resolveOverallStatus: (
        cats: SecurityAuditResult["categories"],
        score: number
      ) => SecurityAuditResult["overall"];
    }).resolveOverallStatus.bind(service);

    const overall = resolver(categories, 82);
    expect(overall).toBe("VULNERABLE");
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
        framework: "OWASP Top 10 2021",
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
