import type * as vscode from "vscode";

export type SeverityLevel = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
export type CategoryStatus = "SECURE" | "WARNING" | "VULNERABLE";
export type TestExpectation = "REJECT" | "SANITIZE" | "ISOLATE" | "ALLOW";
export type TestOutcome = "PASSED" | "FAILED" | "SKIPPED";

export interface CodeSnippet {
  path: string;
  startLine: number;
  endLine: number;
  content: string;
}

export interface SecurityFinding {
  id: string;
  ruleId: string;
  severity: SeverityLevel;
  category: string;
  message: string;
  filePath: string;
  line: number;
  column: number;
  snippet?: CodeSnippet;
  remediation: string;
  references?: string[];
}

export interface SecurityRecommendation {
  id: string;
  title: string;
  description: string;
  priority: "HIGH" | "MEDIUM" | "LOW";
  effort: "LOW" | "MEDIUM" | "HIGH";
  relatedFindings: string[];
}

export interface CategoryResult {
  name: string;
  status: CategoryStatus;
  score: number;
  summary: string;
  findings: SecurityFinding[];
  recommendations: SecurityRecommendation[];
}

export interface SecurityAuditResult {
  overall: "SECURE" | "VULNERABLE" | "CRITICAL";
  score: number;
  timestamp: Date;
  categories: {
    dataHandling: CategoryResult;
    inputValidation: CategoryResult;
    processExecution: CategoryResult;
    webviewSecurity: CategoryResult;
    fileSystemAccess: CategoryResult;
    cryptographicSecurity: CategoryResult;
    dependencyVulnerabilities: CategoryResult;
    complianceStatus: CategoryResult;
  };
  vulnerabilities: Vulnerability[];
  recommendations: SecurityRecommendation[];
}

export interface Vulnerability {
  id: string;
  severity: SeverityLevel;
  category: string;
  title: string;
  description: string;
  impact: string;
  likelihood: "HIGH" | "MEDIUM" | "LOW";
  affectedFiles: string[];
  codeSnippets: CodeSnippet[];
  remediation: string;
  cwe?: string;
  cvss?: number;
}

export interface SecurityReport {
  executiveSummary: string;
  technicalDetails: string;
  complianceSummary: string;
  remediationPlan: string;
  artifacts?: {
    executiveHtml?: string;
    technicalHtml?: string;
    complianceHtml?: string;
    remediationHtml?: string;
    executivePdfPath?: vscode.Uri;
    technicalPdfPath?: vscode.Uri;
  };
}

export interface SecurityRule {
  id: string;
  name: string;
  category: "INJECTION" | "XSS" | "PATH_TRAVERSAL" | "CRYPTO" | "AUTH" | "DATA_LEAK" | "DESERIALIZATION" | "WEBVIEW" | "PROCESS" | "FILE_SYSTEM";
  severity: SeverityLevel;
  pattern: RegExp | ((code: string, filePath: string) => SecurityFinding[]);
  description: string;
  remediation: string;
  cwe: string;
  references?: string[];
}

export interface SecurityFindingContext {
  rule: SecurityRule;
  filePath: string;
  match: RegExpExecArray;
}

export interface SecurityTestCase {
  name: string;
  payloads: string[];
  expectedBehavior: TestExpectation;
}

export interface DynamicTestResult {
  testCase: string;
  outcomes: TestResult[];
  status: TestOutcome;
  findings: SecurityFinding[];
  details: string;
}

export interface TestResult {
  payload: string;
  expectation: TestExpectation;
  outcome: TestOutcome;
  notes?: string;
  finding?: SecurityFinding;
}

export interface ComplianceFramework {
  name: string;
  version?: string;
  description?: string;
  requirements: ComplianceRequirement[];
}

export interface ComplianceRequirement {
  id: string;
  title: string;
  checks: string[];
  mandatory: boolean;
  description?: string;
}

export interface ComplianceResult {
  framework: string;
  compliant: boolean;
  coverage: number;
  satisfied: string[];
  missing: string[];
  evidence: string[];
  recommendations: SecurityRecommendation[];
}

export interface Dependency {
  name: string;
  version: string;
  dev: boolean;
}

export interface DependencyVulnerability {
  dependency: Dependency;
  vulnerabilities: KnownVulnerability[];
}

export interface KnownVulnerability {
  id: string;
  title: string;
  severity: SeverityLevel;
  cve?: string;
  cvssScore?: number;
  description: string;
  references: string[];
  fixedIn?: string;
}

export interface LicenseCompliance {
  dependency: Dependency;
  license: string;
  compatible: boolean;
  notes?: string;
}

export interface MaliciousPackage {
  dependency: Dependency;
  reason: string;
  evidence: string[];
}

export interface CVEEntry {
  id: string;
  description: string;
  cvssScore: number;
  references: string[];
}

export interface IntegrityCheck {
  dependency: Dependency;
  passed: boolean;
  checksum?: string;
  expectedChecksum?: string;
  notes?: string;
}

export interface RiskAnalysis {
  overallRisk: "LOW" | "MODERATE" | "HIGH" | "CRITICAL";
  categoryScores: Record<string, number>;
  topRisks: Vulnerability[];
}

export interface PrioritizedVulnerability {
  vulnerability: Vulnerability;
  priority: "IMMEDIATE" | "SOON" | "PLANNED";
  rationale: string;
}

export interface SecurityFindingSummary {
  total: number;
  bySeverity: Record<SeverityLevel, number>;
  byCategory: Record<string, number>;
}

export interface SecurityAuditMetrics {
  auditDurationMs: number;
  filesScanned: number;
  findingsSummary: SecurityFindingSummary;
}

export type SecurityPipelineStage = "STATIC_ANALYSIS" | "DYNAMIC_TESTING" | "REPORTING";

export type SecurityPipelineStageStatus = "PENDING" | "RUNNING" | "COMPLETED" | "FAILED";

export interface SecurityPipelineStageState<T> {
  stage: SecurityPipelineStage;
  status: SecurityPipelineStageStatus;
  startedAt?: Date;
  completedAt?: Date;
  result?: T;
  error?: string;
}

export interface SecurityReportingSummary {
  totalDependencies: number;
  vulnerableDependencies: number;
  averageComplianceCoverage: number;
}

export interface SecurityReportingResult {
  dependencies: DependencyVulnerability[];
  licenseCompliance: LicenseCompliance[];
  maliciousPackages: MaliciousPackage[];
  compliance: ComplianceResult[];
  summary: SecurityReportingSummary;
  generatedAt: Date;
}

export interface SecurityPipelineContext {
  stages: {
    staticAnalysis: SecurityPipelineStageState<SecurityFinding[]>;
    dynamicTesting: SecurityPipelineStageState<DynamicTestResult[]>;
    reporting: SecurityPipelineStageState<SecurityReportingResult>;
  };
}

export const createEmptySecurityReportingResult = (): SecurityReportingResult => ({
  dependencies: [],
  licenseCompliance: [],
  maliciousPackages: [],
  compliance: [],
  summary: {
    totalDependencies: 0,
    vulnerableDependencies: 0,
    averageComplianceCoverage: 0
  },
  generatedAt: new Date(0)
});
