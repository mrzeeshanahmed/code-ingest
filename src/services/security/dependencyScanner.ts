import * as fs from "node:fs";
import * as path from "node:path";

import type {
  CVEEntry,
  Dependency,
  DependencyVulnerability,
  IntegrityCheck,
  KnownVulnerability,
  LicenseCompliance,
  MaliciousPackage,
  SecurityPipelineContext,
  SecurityReportingResult
} from "./types";

class VulnerabilityDB {
  private readonly advisories: Record<string, KnownVulnerability[]> = {
    lodash: [
      {
        id: "ADVISORY-2021-23337",
        title: "Prototype pollution in lodash",
        severity: "HIGH",
        cve: "CVE-2021-23337",
        cvssScore: 7.4,
        description: "lodash versions prior to 4.17.21 are vulnerable to prototype pollution.",
        references: ["https://nvd.nist.gov/vuln/detail/CVE-2021-23337"],
        fixedIn: ">=4.17.21"
      }
    ],
    minimist: [
      {
        id: "ADVISORY-2020-7598",
        title: "Prototype pollution in minimist",
        severity: "HIGH",
        cve: "CVE-2020-7598",
        cvssScore: 7.5,
        description: "minimist before 1.2.3 is vulnerable to prototype pollution.",
        references: ["https://nvd.nist.gov/vuln/detail/CVE-2020-7598"],
        fixedIn: ">=1.2.3"
      }
    ],
    "event-stream": [
      {
        id: "MALICIOUS-2018-EVENTSTREAM",
        title: "Malicious dependency version",
        severity: "CRITICAL",
        description: "event-stream@3.3.6 contained malicious code targeting cryptocurrency wallets.",
        references: ["https://github.com/dominictarr/event-stream/issues/116"]
      }
    ]
  };

  findVulnerabilities(dependency: Dependency): KnownVulnerability[] {
    return this.advisories[dependency.name]?.filter((advisory) => this.isVersionAffected(dependency.version, advisory.fixedIn)) ?? [];
  }

  private isVersionAffected(version: string, fixedIn?: string): boolean {
    if (!fixedIn) {
      return true;
    }
    if (!fixedIn.startsWith(">=")) {
      return true;
    }
    const minVersion = fixedIn.replace(">=", "").trim();
    return version < minVersion;
  }
}

export class DependencyScanner {
  private readonly vulnerabilityDatabase = new VulnerabilityDB();

  async scanDependencies(): Promise<DependencyVulnerability[]> {
    const dependencies = this.parseDependencies();
    return this.buildDependencyVulnerabilities(dependencies);
  }

  async checkForKnownVulnerabilities(): Promise<KnownVulnerability[]> {
    const results = await this.scanDependencies();
    return results.flatMap((entry) => entry.vulnerabilities);
  }

  async analyzeLicenseCompliance(): Promise<LicenseCompliance[]> {
    const dependencies = this.parseDependencies();
    return this.buildLicenseCompliance(dependencies);
  }

  async detectMaliciousPackages(): Promise<MaliciousPackage[]> {
    const dependencies = this.parseDependencies();
    return this.buildMaliciousPackages(dependencies);
  }

  async populateReporting(context: SecurityPipelineContext, reporting: SecurityReportingResult): Promise<void> {
    if (context.stages.staticAnalysis.status !== "COMPLETED" || context.stages.dynamicTesting.status !== "COMPLETED") {
      throw new Error("Security reporting requires analysis stages to complete");
    }

    const dependencies = this.parseDependencies();
    reporting.dependencies = this.buildDependencyVulnerabilities(dependencies);
    reporting.licenseCompliance = this.buildLicenseCompliance(dependencies);
    reporting.maliciousPackages = this.buildMaliciousPackages(dependencies);

    const vulnerableCount = reporting.dependencies.filter((entry) => entry.vulnerabilities.length > 0).length;
    reporting.summary.totalDependencies = dependencies.length;
    reporting.summary.vulnerableDependencies = vulnerableCount;
  }

  private parseDependencies(): Dependency[] {
    try {
      const packageJsonPath = path.resolve(process.cwd(), "package.json");
      const raw = fs.readFileSync(packageJsonPath, "utf8");
      const manifest = JSON.parse(raw) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };

      const results: Dependency[] = [];
      for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
        results.push({ name, version: version.replace(/^[^0-9]*/, ""), dev: false });
      }
      for (const [name, version] of Object.entries(manifest.devDependencies ?? {})) {
        results.push({ name, version: version.replace(/^[^0-9]*/, ""), dev: true });
      }
      return results;
    } catch {
      return [
        {
          name: "package-json-read-error",
          version: "0.0.0",
          dev: true
        }
      ];
    }
  }

  private buildDependencyVulnerabilities(dependencies: Dependency[]): DependencyVulnerability[] {
    return dependencies.map((dep) => ({
      dependency: dep,
      vulnerabilities: this.vulnerabilityDatabase.findVulnerabilities(dep)
    }));
  }

  private buildLicenseCompliance(dependencies: Dependency[]): LicenseCompliance[] {
    return dependencies.map((dependency) => {
      const license = this.readLicense(dependency.name) ?? "UNKNOWN";
      const compatible = !license.includes("GPL");
      return {
        dependency,
        license,
        compatible,
        notes: compatible ? "" : "GPL-like licenses require review"
      } satisfies LicenseCompliance;
    });
  }

  private buildMaliciousPackages(dependencies: Dependency[]): MaliciousPackage[] {
    const malicious = dependencies.filter((dependency) => dependency.name === "event-stream" && dependency.version === "3.3.6");
    return malicious.map((dependency) => ({
      dependency,
      reason: "Known malicious version detected",
      evidence: ["Version 3.3.6 contained credential-stealing payload"]
    } satisfies MaliciousPackage));
  }

  private readLicense(packageName: string): string | undefined {
    try {
      const licensePath = path.resolve(process.cwd(), "node_modules", packageName, "LICENSE");
      if (fs.existsSync(licensePath)) {
        const content = fs.readFileSync(licensePath, "utf8");
        const firstLine = content.split(/\r?\n/)[0];
        return firstLine.trim();
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  private crossReferenceWithCVE(dependency: Dependency): CVEEntry[] {
    const vulnerabilities = this.vulnerabilityDatabase.findVulnerabilities(dependency);
    return vulnerabilities
      .filter((item) => item.cve)
      .map((item) => ({
        id: item.cve!,
        description: item.description,
        cvssScore: item.cvssScore ?? 0,
        references: item.references
      } satisfies CVEEntry));
  }

  private checkPackageIntegrity(dependency: Dependency): IntegrityCheck {
    const knownTampered = dependency.name === "event-stream" && dependency.version === "3.3.6";
    const integrity: IntegrityCheck = {
      dependency,
      passed: !knownTampered,
      notes: knownTampered ? "Known malicious version" : ""
    };

    if (knownTampered) {
      integrity.checksum = "tampered";
      integrity.expectedChecksum = "verified";
    }

    return integrity;
  }
}
