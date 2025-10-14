import * as vscode from "vscode";

import { ConfigurationService } from "../configurationService";
import type {
  CategoryResult,
  ComplianceResult,
  DynamicTestResult,
  SecurityAuditResult,
  SecurityFinding,
  SecurityRecommendation,
  SecurityReport,
  Vulnerability
} from "./types";
import { ComplianceChecker } from "./complianceChecker";
import { DependencyScanner } from "./dependencyScanner";
import { DynamicSecurityTester } from "./dynamicTester";
import { SecurityReportGenerator } from "./reportGenerator";
import { SecurityPipelineCoordinator, type SecurityPipelineContext, type SecurityPipelineDependencies } from "./pipelineCoordinator";
import { StaticSecurityAnalyzer } from "./staticAnalyzer";

const CATEGORY_BASELINE_SCORE = 85;
type CategoryCollection = SecurityAuditResult["categories"];

export interface SecurityAuditDependencies extends SecurityPipelineDependencies {
  pipelineCoordinator?: SecurityPipelineCoordinator;
}

export class SecurityAuditService {
  private readonly staticAnalyzer: StaticSecurityAnalyzer;
  private readonly dynamicTester: DynamicSecurityTester;
  private readonly complianceChecker: ComplianceChecker;
  private readonly dependencyScanner: DependencyScanner;
  private readonly pipelineCoordinator: SecurityPipelineCoordinator;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly configService: ConfigurationService,
    dependencies: SecurityAuditDependencies = {}
  ) {
    this.staticAnalyzer = dependencies.staticAnalyzer ?? new StaticSecurityAnalyzer();
    this.dynamicTester = dependencies.dynamicTester ?? new DynamicSecurityTester();
    this.complianceChecker = dependencies.complianceChecker ?? new ComplianceChecker();
    this.dependencyScanner = dependencies.dependencyScanner ?? new DependencyScanner();
    this.pipelineCoordinator = dependencies.pipelineCoordinator ?? new SecurityPipelineCoordinator({
      staticAnalyzer: this.staticAnalyzer,
      dynamicTester: this.dynamicTester,
      dependencyScanner: this.dependencyScanner,
      complianceChecker: this.complianceChecker
    });
  }

  async performComprehensiveAudit(): Promise<SecurityAuditResult> {
    const context = await this.pipelineCoordinator.run();
  const categories = this.buildCategoryMap(context);

    const vulnerabilities = this.collectVulnerabilities(categories);
    const recommendations = this.collectRecommendations(categories);
    const score = this.calculateOverallScore(categories);
    const overall = score >= 90 ? "SECURE" : score >= 70 ? "VULNERABLE" : "CRITICAL";

    return {
      overall,
      score,
      timestamp: new Date(),
      categories,
      vulnerabilities,
      recommendations
    };
  }

  private buildCategoryMap(context: SecurityPipelineContext): CategoryCollection {
    const dataHandling = this.auditDataHandling(context);
    const inputValidation = this.auditInputValidation(context);
    const processExecution = this.auditProcessExecution(context);
    const webviewSecurity = this.auditWebviewSecurity(context);
    const fileSystemAccess = this.auditFileSystemAccess(context);
    const cryptographicSecurity = this.auditCryptographicSecurity(context);
    const dependencyVulnerabilities = this.auditDependencies(context);
    const complianceStatus = this.checkCompliance(context);

    return {
      dataHandling,
      inputValidation,
      processExecution,
      webviewSecurity,
      fileSystemAccess,
      cryptographicSecurity,
      dependencyVulnerabilities,
      complianceStatus
    } satisfies CategoryCollection;
  }

  private auditDataHandling(context: SecurityPipelineContext): CategoryResult {
    const sensitiveFindings = context.staticFindings.filter((finding) => finding.category === "DATA_LEAK");
    const score = this.computeScoreFromFindings(CATEGORY_BASELINE_SCORE, sensitiveFindings);
    return {
      name: "Data Handling",
      status: this.resolveStatus(score, sensitiveFindings),
      score,
      summary: sensitiveFindings.length > 0 ? `${sensitiveFindings.length} data handling issues detected` : "Data handling controls appear effective",
      findings: sensitiveFindings,
      recommendations: sensitiveFindings.map((finding) => this.buildRecommendationFromFinding(finding))
    };
  }

  private auditInputValidation(context: SecurityPipelineContext): CategoryResult {
    const findings = this.flattenDynamicFindings(context.dynamicResults, (payload) => payload.includes("<") || payload.includes("'"));
    const score = this.computeScoreFromFindings(CATEGORY_BASELINE_SCORE, findings);
    return {
      name: "Input Validation",
      status: this.resolveStatus(score, findings),
      score,
      summary: findings.length > 0 ? `${findings.length} input validation gaps detected` : "Input validation handled correctly in dynamic tests",
      findings,
      recommendations: findings.map((finding) => this.buildRecommendationFromFinding(finding))
    };
  }

  private auditProcessExecution(context: SecurityPipelineContext): CategoryResult {
    const processFindings = context.staticFindings.filter((finding) => finding.category === "PROCESS" || finding.category === "INJECTION");
    const score = this.computeScoreFromFindings(CATEGORY_BASELINE_SCORE, processFindings);
    return {
      name: "Process Execution",
      status: this.resolveStatus(score, processFindings),
      score,
      summary: processFindings.length > 0 ? `${processFindings.length} potentially unsafe process operations` : "Process execution controls appear sound",
      findings: processFindings,
      recommendations: processFindings.map((finding) => this.buildRecommendationFromFinding(finding))
    };
  }

  private auditWebviewSecurity(context: SecurityPipelineContext): CategoryResult {
    const webviewFindings = context.staticFindings.filter((finding) => finding.category === "WEBVIEW" || finding.category === "XSS");
    const score = this.computeScoreFromFindings(CATEGORY_BASELINE_SCORE, webviewFindings);
    return {
      name: "Webview Security",
      status: this.resolveStatus(score, webviewFindings),
      score,
      summary: webviewFindings.length > 0 ? `${webviewFindings.length} webview hardening improvements required` : "Webview security controls are effective",
      findings: webviewFindings,
      recommendations: webviewFindings.map((finding) => this.buildRecommendationFromFinding(finding))
    };
  }

  private auditFileSystemAccess(context: SecurityPipelineContext): CategoryResult {
    const fsFindings = context.staticFindings.filter((finding) => finding.category === "FILE_SYSTEM" || finding.category === "PATH_TRAVERSAL");
    const score = this.computeScoreFromFindings(CATEGORY_BASELINE_SCORE, fsFindings);
    return {
      name: "File System Access",
      status: this.resolveStatus(score, fsFindings),
      score,
      summary: fsFindings.length > 0 ? `${fsFindings.length} filesystem boundary gaps detected` : "Filesystem access patterns appear safe",
      findings: fsFindings,
      recommendations: fsFindings.map((finding) => this.buildRecommendationFromFinding(finding))
    };
  }

  private auditCryptographicSecurity(context: SecurityPipelineContext): CategoryResult {
    const cryptoFindings = context.staticFindings.filter((finding) => finding.category === "CRYPTO");
    const score = this.computeScoreFromFindings(CATEGORY_BASELINE_SCORE, cryptoFindings);
    return {
      name: "Cryptographic Security",
      status: this.resolveStatus(score, cryptoFindings),
      score,
      summary: cryptoFindings.length > 0 ? `${cryptoFindings.length} weak cryptographic primitives detected` : "Strong cryptographic primitives in use",
      findings: cryptoFindings,
      recommendations: cryptoFindings.map((finding) => this.buildRecommendationFromFinding(finding))
    };
  }

  private auditDependencies(context: SecurityPipelineContext): CategoryResult {
    const affected = context.dependencyResults.filter((entry) => entry.vulnerabilities.length > 0);
    const findings: SecurityFinding[] = affected.flatMap((entry) =>
      entry.vulnerabilities.map((vuln) => ({
        id: `${entry.dependency.name}-${vuln.id}`,
        ruleId: "DEPENDENCY_VULNERABILITY",
        severity: vuln.severity,
        category: "DATA_LEAK",
        message: `${entry.dependency.name}@${entry.dependency.version} - ${vuln.title}`,
        filePath: "package.json",
        line: 0,
        column: 0,
        remediation: vuln.fixedIn ? `Upgrade to ${vuln.fixedIn}` : "Update dependency to a secure version",
        references: vuln.references
      }))
    );
    const score = this.computeScoreFromFindings(CATEGORY_BASELINE_SCORE, findings);
    return {
      name: "Dependency Security",
      status: this.resolveStatus(score, findings),
      score,
      summary: findings.length > 0 ? `${findings.length} vulnerable dependencies detected` : "All dependencies meet security requirements",
      findings,
      recommendations: findings.map((finding) => this.buildRecommendationFromFinding(finding))
    };
  }

  private checkCompliance(context: SecurityPipelineContext): CategoryResult {
    const evidence = context.complianceResults;
    const findings = this.buildComplianceFindings(evidence);
    const score = Math.round(evidence.reduce((sum, item) => sum + item.coverage, 0) / evidence.length);
    const owasp = evidence.find((item) => item.framework === "OWASP");
    const cwe = evidence.find((item) => item.framework === "CWE");
    const dataProtection = evidence.find((item) => item.framework === "DATA_PROTECTION");
    const summaryParts = [
      owasp ? `OWASP coverage ${owasp.coverage}%` : undefined,
      cwe ? `CWE coverage ${cwe.coverage}%` : undefined,
      dataProtection ? `Data protection coverage ${dataProtection.coverage}%` : undefined
    ].filter((part): part is string => Boolean(part));
    return {
      name: "Compliance",
      status: this.resolveStatus(score, findings),
      score,
      summary: summaryParts.length > 0 ? summaryParts.join(", ") : "Compliance coverage data unavailable",
      findings,
      recommendations: evidence.flatMap((item) => item.recommendations)
    };
  }

  async generateSecurityReport(): Promise<SecurityReport> {
    const auditResult = await this.performComprehensiveAudit();
    const generator = new SecurityReportGenerator(auditResult);
    return generator.compileFullReport();
  }

  private computeScoreFromFindings(base: number, findings: SecurityFinding[]): number {
    if (findings.length === 0) {
      return Math.min(100, base + 10);
    }
    const penalty = findings.reduce((sum, finding) => sum + this.penaltyForSeverity(finding.severity), 0);
    return Math.max(0, base - penalty);
  }

  private penaltyForSeverity(severity: SecurityFinding["severity"]): number {
    switch (severity) {
      case "CRITICAL":
        return 30;
      case "HIGH":
        return 20;
      case "MEDIUM":
        return 10;
      case "LOW":
        return 5;
      default:
        return 0;
    }
  }

  private resolveStatus(score: number, findings: SecurityFinding[]): "SECURE" | "WARNING" | "VULNERABLE" {
    if (findings.some((finding) => finding.severity === "CRITICAL")) {
      return "VULNERABLE";
    }
    if (score >= 85 && findings.length === 0) {
      return "SECURE";
    }
    return score >= 60 ? "WARNING" : "VULNERABLE";
  }

  private collectVulnerabilities(categories: CategoryCollection): Vulnerability[] {
    const vulnerabilities: Vulnerability[] = [];
    for (const category of Object.values(categories)) {
      for (const finding of category.findings) {
        vulnerabilities.push({
          id: finding.id,
          severity: finding.severity,
          category: category.name,
          title: finding.message,
          description: finding.message,
          impact: this.impactDescription(finding.severity),
          likelihood: finding.severity === "CRITICAL" || finding.severity === "HIGH" ? "HIGH" : finding.severity === "MEDIUM" ? "MEDIUM" : "LOW",
          affectedFiles: [finding.filePath],
          codeSnippets: finding.snippet
            ? [
                {
                  path: finding.filePath,
                  startLine: finding.snippet.startLine,
                  endLine: finding.snippet.endLine,
                  content: finding.snippet.content
                }
              ]
            : [],
          remediation: finding.remediation,
          cwe: finding.references?.[0] ?? "",
          cvss: finding.severity === "CRITICAL" ? 9.5 : finding.severity === "HIGH" ? 8.0 : finding.severity === "MEDIUM" ? 6.0 : 3.5
        });
      }
    }
    return vulnerabilities;
  }

  private collectRecommendations(categories: CategoryCollection): SecurityRecommendation[] {
    const recommendations: SecurityRecommendation[] = [];
    for (const category of Object.values(categories)) {
      recommendations.push(
        ...category.recommendations.map((recommendation, index) => ({
          ...recommendation,
          id: `${category.name}-${recommendation.id}-${index}`
        }))
      );
    }
    return recommendations;
  }

  private buildRecommendationFromFinding(finding: SecurityFinding): SecurityRecommendation {
    const priority = finding.severity === "CRITICAL" || finding.severity === "HIGH" ? "HIGH" : finding.severity === "MEDIUM" ? "MEDIUM" : "LOW";
    const effort = finding.severity === "LOW" ? "LOW" : finding.severity === "MEDIUM" ? "MEDIUM" : "HIGH";
    return {
      id: `REC-${finding.id}`,
      title: `Mitigate ${finding.ruleId}`,
      description: finding.remediation,
      priority,
      effort,
      relatedFindings: [finding.id]
    };
  }

  private flattenDynamicFindings(results: DynamicTestResult[], selector: (payload: string) => boolean): SecurityFinding[] {
    const findings: SecurityFinding[] = [];
    for (const result of results) {
      for (const outcome of result.outcomes) {
        if (outcome.outcome === "FAILED" && selector(outcome.payload) && outcome.finding) {
          findings.push(outcome.finding);
        }
      }
    }
    return findings;
  }

  private buildComplianceFindings(results: ComplianceResult[]): SecurityFinding[] {
    const findings: SecurityFinding[] = [];
    for (const result of results) {
      if (!result.compliant) {
        findings.push({
          id: `COMPLIANCE-${result.framework}`,
          ruleId: "COMPLIANCE_GAP",
          severity: result.coverage >= 80 ? "MEDIUM" : result.coverage >= 60 ? "HIGH" : "CRITICAL",
          category: "DATA_LEAK",
          message: `${result.framework} compliance coverage at ${result.coverage}%`,
          filePath: "compliance",
          line: 0,
          column: 0,
          remediation: result.recommendations[0]?.description ?? "Implement missing compliance controls"
        });
      }
    }
    return findings;
  }

  private impactDescription(severity: SecurityFinding["severity"]): string {
    switch (severity) {
      case "CRITICAL":
        return "Immediate compromise of sensitive data or execution environment";
      case "HIGH":
        return "High risk of data breach or privilege escalation";
      case "MEDIUM":
        return "Moderate impact requiring prompt remediation";
      case "LOW":
        return "Low impact, monitor and remediate during scheduled maintenance";
      default:
        return "";
    }
  }

  private calculateOverallScore(categories: CategoryCollection): number {
    const scores = Object.values(categories).map((category) => category.score);
    const total = scores.reduce((sum, value) => sum + value, 0);
    return Math.round(total / scores.length);
  }
}
