import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

import type {
  PrioritizedVulnerability,
  RiskAnalysis,
  SecurityAuditResult,
  SecurityReport,
  Vulnerability
} from "./types";

export class SecurityReportGenerator {
  constructor(private readonly auditResult: SecurityAuditResult) {}

  async generateExecutiveReport(): Promise<string> {
    const summary = this.buildExecutiveSummary();
    await this.persistArtifact("executive-summary.md", summary);
    return summary;
  }

  async generateTechnicalReport(): Promise<string> {
    const details = this.buildTechnicalDetails();
    await this.persistArtifact("technical-report.md", details);
    return details;
  }

  async generateComplianceReport(): Promise<string> {
    const compliance = this.buildComplianceSummary();
    await this.persistArtifact("compliance-report.md", compliance);
    return compliance;
  }

  async generateRemediationPlan(): Promise<string> {
    const remediation = this.buildRemediationPlan();
    await this.persistArtifact("remediation-plan.md", remediation);
    return remediation;
  }

  private buildExecutiveSummary(): string {
    const { overall, score, categories, vulnerabilities } = this.auditResult;
    const topRisks = this.prioritizeVulnerabilities().slice(0, 5);
    const lines = [
      `# Security Executive Summary`,
      `- **Overall posture:** ${overall}`,
      `- **Score:** ${score}/100`,
      `- **Total vulnerabilities:** ${vulnerabilities.length}`,
      `- **Critical/high findings:** ${vulnerabilities.filter((vuln) => vuln.severity === "CRITICAL" || vuln.severity === "HIGH").length}`,
      `- **Top risks:**`,
      ...topRisks.map((risk, index) => `  ${index + 1}. ${risk.vulnerability.title} (${risk.vulnerability.severity}) - ${risk.rationale}`),
      `- **Categories requiring attention:** ${Object.values(categories).filter((category) => category.status !== "SECURE").map((category) => `${category.name} (${category.status})`).join(", ") || "All categories secure"}`
    ];
    return lines.join("\n");
  }

  private buildTechnicalDetails(): string {
    const { vulnerabilities, categories } = this.auditResult;
    const lines = ["# Technical Security Findings"];

    for (const vulnerability of vulnerabilities) {
      lines.push(
        `## ${vulnerability.title} (${vulnerability.severity})`,
        `- **Category:** ${vulnerability.category}`,
        `- **Impact:** ${vulnerability.impact}`,
        `- **Likelihood:** ${vulnerability.likelihood}`,
        `- **Affected files:** ${vulnerability.affectedFiles.join(", ") || "N/A"}`,
        `- **Remediation:** ${vulnerability.remediation}`,
        vulnerability.cwe ? `- **CWE:** ${vulnerability.cwe}` : "",
        vulnerability.cvss ? `- **CVSS:** ${vulnerability.cvss}` : ""
      );
    }

    lines.push("\n# Category Summaries");

    for (const category of Object.values(categories)) {
      lines.push(
        `## ${category.name}`,
        `- **Status:** ${category.status}`,
        `- **Score:** ${category.score}`,
        `- **Summary:** ${category.summary}`,
        `- **Findings:** ${category.findings.length}`,
        `- **Recommendations:** ${category.recommendations.length}`
      );
    }

    return lines.filter((line) => line.length > 0).join("\n");
  }

  private buildComplianceSummary(): string {
    const compliance = this.auditResult.categories.complianceStatus;
    const lines = [
      `# Compliance Summary`,
      `- **Status:** ${compliance.status}`,
      `- **Score:** ${compliance.score}`,
      `- **Summary:** ${compliance.summary}`,
      `- **Recommendations:** ${compliance.recommendations.length}`
    ];

    const frameworkLines = compliance.recommendations.map((rec) => `- ${rec.title}: ${rec.description} (Priority: ${rec.priority})`);
    if (frameworkLines.length > 0) {
      lines.push("\n## Required Actions", ...frameworkLines);
    }

    return lines.join("\n");
  }

  private buildRemediationPlan(): string {
    const prioritized = this.prioritizeVulnerabilities();
    const lines = [
      `# Remediation Plan`,
      `- **Total tasks:** ${prioritized.length}`,
      `- **Immediate actions:** ${prioritized.filter((item) => item.priority === "IMMEDIATE").length}`,
      `- **Short-term actions:** ${prioritized.filter((item) => item.priority === "SOON").length}`,
      `- **Long-term actions:** ${prioritized.filter((item) => item.priority === "PLANNED").length}`,
      "\n## Tasks"
    ];

    prioritized.forEach((item, index) => {
      lines.push(
        `${index + 1}. **${item.vulnerability.title}** (${item.vulnerability.severity})`,
        `   - Priority: ${item.priority}`,
        `   - Rationale: ${item.rationale}`,
        `   - Remediation: ${item.vulnerability.remediation}`
      );
    });

    return lines.join("\n");
  }

  private prioritizeVulnerabilities(): PrioritizedVulnerability[] {
    const sorted = [...this.auditResult.vulnerabilities].sort((a, b) => this.severityWeight(b.severity) - this.severityWeight(a.severity));
    return sorted.map((vulnerability) => ({
      vulnerability,
      priority: this.resolvePriority(vulnerability),
      rationale: `${vulnerability.severity} severity with ${vulnerability.likelihood} likelihood`
    }));
  }

  private resolvePriority(vulnerability: Vulnerability): "IMMEDIATE" | "SOON" | "PLANNED" {
    if (vulnerability.severity === "CRITICAL" || vulnerability.likelihood === "HIGH") {
      return "IMMEDIATE";
    }
    if (vulnerability.severity === "HIGH" || vulnerability.likelihood === "MEDIUM") {
      return "SOON";
    }
    return "PLANNED";
  }

  private severityWeight(severity: Vulnerability["severity"]): number {
    switch (severity) {
      case "CRITICAL":
        return 4;
      case "HIGH":
        return 3;
      case "MEDIUM":
        return 2;
      case "LOW":
        return 1;
      default:
        return 0;
    }
  }

  private calculateRiskScores(): RiskAnalysis {
    const categoryScores: Record<string, number> = {};
    for (const [name, category] of Object.entries(this.auditResult.categories)) {
      categoryScores[name] = category.score;
    }

    const topRisks = [...this.auditResult.vulnerabilities]
      .filter((vulnerability) => vulnerability.severity === "CRITICAL" || vulnerability.severity === "HIGH")
      .slice(0, 5);

    const averageScore = Object.values(categoryScores).reduce((sum, value) => sum + value, 0) / Object.keys(categoryScores).length;
    const overallRisk = averageScore >= 90 ? "LOW" : averageScore >= 70 ? "MODERATE" : averageScore >= 50 ? "HIGH" : "CRITICAL";

    return {
      overallRisk,
      categoryScores,
      topRisks
    };
  }

  private async persistArtifact(filename: string, content: string | Buffer): Promise<vscode.Uri> {
    const storagePath = path.join(process.cwd(), "out", "security-reports");
    await fs.mkdir(storagePath, { recursive: true });
    const targetPath = path.join(storagePath, filename);
    if (typeof content === "string") {
      await fs.writeFile(targetPath, content, "utf8");
    } else {
      await fs.writeFile(targetPath, content);
    }
    return vscode.Uri.file(targetPath);
  }

  private async generatePDF(html: string): Promise<Buffer> {
    const encoder = new TextEncoder();
    const pdfBytes = encoder.encode(html);
    return Buffer.from(pdfBytes);
  }

  async generateHTML(template: string, data: Record<string, unknown>): Promise<string> {
    let rendered = template;
    for (const [key, value] of Object.entries(data)) {
      const placeholder = new RegExp(`{{\\s*${this.escapePlaceholderKey(key)}\\s*}}`, "g");
      rendered = rendered.replace(placeholder, String(value));
    }
    await this.persistArtifact("report.html", rendered);
    return rendered;
  }

  async generatePDFReport(): Promise<Buffer> {
    const html = await this.generateHTML("<html><body>{{content}}</body></html>", {
      content: await this.generateExecutiveReport()
    });
    return this.generatePDF(html);
  }

  async compileFullReport(): Promise<SecurityReport> {
    const executiveSummary = await this.generateExecutiveReport();
    const technicalDetails = await this.generateTechnicalReport();
    const complianceSummary = await this.generateComplianceReport();
    const remediationPlan = await this.generateRemediationPlan();
    const pdfHtml = await this.generateHTML("<html><body>{{content}}</body></html>", {
      content: executiveSummary
    });
    const pdfBuffer = await this.generatePDF(pdfHtml);
    const pdfUri = await this.persistArtifact("executive-summary.pdf", pdfBuffer);

    const report: SecurityReport = {
      executiveSummary,
      technicalDetails,
      complianceSummary,
      remediationPlan,
      artifacts: {
        executiveHtml: executiveSummary,
        technicalHtml: technicalDetails,
        complianceHtml: complianceSummary,
        remediationHtml: remediationPlan,
        executivePdfPath: pdfUri
      }
    };

    return report;
  }

  private escapePlaceholderKey(key: string): string {
    return key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
}
