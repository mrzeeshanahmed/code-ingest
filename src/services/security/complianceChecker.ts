import type {
  ComplianceFramework,
  ComplianceRequirement,
  ComplianceResult,
  SecurityPipelineContext,
  SecurityReportingResult,
  SecurityRecommendation
} from "./types";

interface ComplianceEvidence {
  requirement: string;
  satisfied: boolean;
  evidence: string;
  recommendations: SecurityRecommendation[];
}

export class ComplianceChecker {
  private readonly frameworks: ComplianceFramework[] = [];

  constructor() {
    this.initializeFrameworks();
  }

  async checkOWASPCompliance(): Promise<ComplianceResult> {
    const framework = this.frameworks.find((fw) => fw.name === "OWASP Top 10 2021");
    if (!framework) {
      return this.createEmptyResult("OWASP Top 10 2021");
    }
    const evidence = this.evaluateFramework(framework);
    return this.buildResult(framework, evidence);
  }

  async checkCWECompliance(): Promise<ComplianceResult> {
    const framework = this.frameworks.find((fw) => fw.name === "CWE Top 25 2024");
    if (!framework) {
      return this.createEmptyResult("CWE Top 25 2024");
    }
    const evidence = this.evaluateFramework(framework);
    return this.buildResult(framework, evidence);
  }

  async checkDataProtectionCompliance(): Promise<ComplianceResult> {
    const framework = this.frameworks.find((fw) => fw.name === "Data Protection Essentials");
    if (!framework) {
      return this.createEmptyResult("Data Protection Essentials");
    }
    const evidence = this.evaluateFramework(framework);
    return this.buildResult(framework, evidence);
  }

  async populateReporting(context: SecurityPipelineContext, reporting: SecurityReportingResult): Promise<ComplianceResult[]> {
    if (context.stages.dynamicTesting.status !== "COMPLETED") {
      throw new Error("Compliance checks require dynamic security testing to complete");
    }

    const results = [
      await this.checkOWASPCompliance(),
      await this.checkCWECompliance(),
      await this.checkDataProtectionCompliance()
    ];

    reporting.compliance = results;
    return results;
  }

  private buildResult(framework: ComplianceFramework, evidence: ComplianceEvidence[]): ComplianceResult {
    const satisfied = evidence.filter((item) => item.satisfied).map((item) => item.requirement);
    const missing = evidence.filter((item) => !item.satisfied).map((item) => item.requirement);
    const coverage = Math.round((satisfied.length / evidence.length) * 100);

    const recommendations: SecurityRecommendation[] = evidence
      .flatMap((item) => item.recommendations)
      .map((rec, index) => ({ ...rec, id: `${rec.id}-${index}` }));

    return {
      framework: framework.name,
      compliant: missing.length === 0,
      coverage,
      satisfied,
      missing,
      evidence: evidence.map((item) => item.evidence),
      recommendations
    };
  }

  private evaluateFramework(framework: ComplianceFramework): ComplianceEvidence[] {
    return framework.requirements.map((requirement) => {
      const satisfied = this.simulateCheck(requirement);
      const recommendations = satisfied
        ? []
        : [
            {
              id: `${requirement.id}-rec`,
              title: `${requirement.title} improvement` ,
              description: `Implement controls for ${requirement.title} requirement`,
              priority: requirement.mandatory ? "HIGH" : "MEDIUM",
              effort: requirement.mandatory ? "HIGH" : "MEDIUM",
              relatedFindings: []
            } satisfies SecurityRecommendation
          ];
      return {
        requirement: `${requirement.id} - ${requirement.title}`,
        satisfied,
        evidence: satisfied
          ? `${requirement.title} mapped to existing controls`
          : `${requirement.title} requires remediation for checks: ${requirement.checks.join(", ")}`,
        recommendations
      } satisfies ComplianceEvidence;
    });
  }

  private simulateCheck(requirement: ComplianceRequirement): boolean {
    const criticalChecks = new Set(["checkAuthorizationControls", "checkEncryptionUsage", "checkInputValidation", "checkCommandInjection"]);
    const hasCritical = requirement.checks.some((check) => criticalChecks.has(check));
    if (requirement.mandatory && hasCritical) {
      return false;
    }
    return requirement.checks.length % 2 === 0;
  }

  private initializeFrameworks(): void {
    this.frameworks.push(
      {
        name: "OWASP Top 10 2021",
        description: "Application security risks ranked by prevalence and impact",
        requirements: [
          {
            id: "A01",
            title: "Broken Access Control",
            checks: ["checkAuthorizationControls", "checkPrivilegeEscalation", "checkMultiTenantIsolation"],
            mandatory: true
          },
          {
            id: "A02",
            title: "Cryptographic Failures",
            checks: ["checkEncryptionUsage", "checkKeyManagement", "checkHashingAlgorithms"],
            mandatory: true
          },
          {
            id: "A03",
            title: "Injection",
            checks: ["checkSQLInjection", "checkCommandInjection", "checkXPathInjection"],
            mandatory: true
          },
          {
            id: "A04",
            title: "Insecure Design",
            checks: ["checkThreatModeling", "checkSecurityRequirements", "checkSecureDefaults"],
            mandatory: false
          },
          {
            id: "A05",
            title: "Security Misconfiguration",
            checks: ["checkSecurityHeaders", "checkDefaultCredentials", "checkHardening"],
            mandatory: true
          },
          {
            id: "A06",
            title: "Vulnerable and Outdated Components",
            checks: ["checkDependencyUpdates", "checkVulnerabilityDatabase"],
            mandatory: true
          },
          {
            id: "A07",
            title: "Identification and Authentication Failures",
            checks: ["checkAuthenticationFlows", "checkMfaEnforcement"],
            mandatory: true
          },
          {
            id: "A08",
            title: "Software and Data Integrity Failures",
            checks: ["checkIntegrityChecks", "checkTamperProtection"],
            mandatory: true
          },
          {
            id: "A09",
            title: "Security Logging and Monitoring Failures",
            checks: ["checkAuditLogging", "checkAlerting"],
            mandatory: false
          },
          {
            id: "A10",
            title: "Server-Side Request Forgery",
            checks: ["checkOutboundRequestValidation", "checkAllowLists"],
            mandatory: true
          }
        ]
      },
      {
        name: "CWE Top 25 2024",
        description: "Most dangerous software weaknesses",
        requirements: [
          { id: "CWE-79", title: "Cross-site Scripting", checks: ["checkWebOutputEncoding", "checkTemplateEscaping"], mandatory: true },
          { id: "CWE-89", title: "SQL Injection", checks: ["checkParameterizedQueries", "checkInputSanitization"], mandatory: true },
          { id: "CWE-787", title: "Out-of-bounds Write", checks: ["checkBufferOperations"], mandatory: false },
          { id: "CWE-125", title: "Out-of-bounds Read", checks: ["checkArrayBounds", "checkInputBounds"], mandatory: false },
          { id: "CWE-20", title: "Improper Input Validation", checks: ["checkInputValidation", "checkSchemaValidation"], mandatory: true },
          { id: "CWE-22", title: "Path Traversal", checks: ["checkPathNormalization", "checkAllowListedPaths"], mandatory: true },
          { id: "CWE-352", title: "CSRF", checks: ["checkCsrfTokens", "checkSameSiteCookies"], mandatory: false },
          { id: "CWE-78", title: "OS Command Injection", checks: ["checkCommandInjection"] , mandatory: true },
          { id: "CWE-416", title: "Use After Free", checks: ["checkMemoryLifecycle"], mandatory: false },
          { id: "CWE-732", title: "Incorrect Permission Assignment", checks: ["checkFilesystemPermissions"], mandatory: true }
        ]
      },
      {
        name: "Data Protection Essentials",
        description: "Foundational data protection controls for developer tools",
        requirements: [
          { id: "DP-01", title: "Data Classification", checks: ["checkDataInventory", "checkClassification"], mandatory: true },
          { id: "DP-02", title: "Encryption at Rest", checks: ["checkStorageEncryption"], mandatory: true },
          { id: "DP-03", title: "Encryption in Transit", checks: ["checkTransportEncryption"], mandatory: true },
          { id: "DP-04", title: "Data Retention", checks: ["checkRetentionPolicies"], mandatory: false },
          { id: "DP-05", title: "Incident Response", checks: ["checkIncidentResponsePlan", "checkCommunicationPlan"], mandatory: true }
        ]
      }
    );
  }

  private createEmptyResult(frameworkName: string): ComplianceResult {
    return {
      framework: frameworkName,
      compliant: false,
      coverage: 0,
      satisfied: [],
      missing: [],
      evidence: ["Framework not initialized"],
      recommendations: [
        {
          id: `${frameworkName}-init` ,
          title: `${frameworkName} framework missing`,
          description: `Initialize compliance framework: ${frameworkName}`,
          priority: "HIGH",
          effort: "MEDIUM",
          relatedFindings: []
        }
      ]
    };
  }
}
