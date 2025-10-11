import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import * as vscode from "vscode";

import { ConfigurationService } from "../configurationService";
import { ComplianceChecker } from "./complianceChecker";
import { DependencyScanner } from "./dependencyScanner";
import { DynamicSecurityTester } from "./dynamicTester";
import { SecurityReportGenerator } from "./reportGenerator";
import { StaticSecurityAnalyzer } from "./staticAnalyzer";
import { SecurityAuditService } from "./securityAuditService";

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
    jest.spyOn(DependencyScanner.prototype, "scanDependencies").mockResolvedValue([]);
    jest.spyOn(ComplianceChecker.prototype, "checkOWASPCompliance").mockResolvedValue({
      framework: "OWASP_TOP_10",
      compliant: true,
      coverage: 95,
      satisfied: [],
      missing: [],
      evidence: [],
      recommendations: []
    });
    jest.spyOn(ComplianceChecker.prototype, "checkCWECompliance").mockResolvedValue({
      framework: "CWE_TOP_25",
      compliant: true,
      coverage: 90,
      satisfied: [],
      missing: [],
      evidence: [],
      recommendations: []
    });
    jest.spyOn(ComplianceChecker.prototype, "checkDataProtectionCompliance").mockResolvedValue({
      framework: "DATA_PROTECTION",
      compliant: true,
      coverage: 92,
      satisfied: [],
      missing: [],
      evidence: [],
      recommendations: []
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
});
