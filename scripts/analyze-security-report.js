'use strict';

const fs = require('fs');
const path = require('path');

const SEVERITY_ORDER = ['info', 'low', 'moderate', 'high', 'critical'];
const SEVERITY_THRESHOLD_INDEX = SEVERITY_ORDER.indexOf('moderate');

function main() {
  const [, , reportPath] = process.argv;

  if (!reportPath) {
    console.error('Usage: node scripts/analyze-security-report.js <audit-report.json>');
    process.exit(1);
  }

  const absolutePath = path.isAbsolute(reportPath)
    ? reportPath
    : path.join(process.cwd(), reportPath);

  if (!fs.existsSync(absolutePath)) {
    console.error(`Audit report not found: ${absolutePath}`);
    process.exit(1);
  }

  let report;
  try {
    const content = fs.readFileSync(absolutePath, 'utf8');
    report = JSON.parse(content);
  } catch (error) {
    console.error(`Failed to parse audit report: ${error.message}`);
    process.exit(1);
  }

  const summary = buildSummary(report);
  printSummary(summary);

  if (summary.totalModerateOrHigher > 0) {
    console.error(`❌ Security audit failed: ${summary.totalModerateOrHigher} moderate+ vulnerabilities detected`);
    process.exit(1);
  }

  console.log('✅ Security audit passed: no moderate or higher vulnerabilities detected');
}

function buildSummary(report) {
  const metadataCounts =
    (report.metadata && report.metadata.vulnerabilities) ||
    (report['metadata'] && report['metadata']['vulnerabilities']) ||
    {};

  const counts = {
    info: metadataCounts.info || 0,
    low: metadataCounts.low || 0,
    moderate: metadataCounts.moderate || 0,
    high: metadataCounts.high || 0,
    critical: metadataCounts.critical || 0
  };

  const advisories = extractAdvisories(report);

  const totalModerateOrHigher = counts.moderate + counts.high + counts.critical;

  return {
    counts,
    advisories,
    totalModerateOrHigher
  };
}

function extractAdvisories(report) {
  const advisories = [];

  if (Array.isArray(report.vulnerabilities)) {
    for (const vulnerability of report.vulnerabilities) {
      advisories.push(normalizeVulnerability(vulnerability));
    }
  }

  if (report.vulnerabilities && typeof report.vulnerabilities === 'object' && !Array.isArray(report.vulnerabilities)) {
    for (const [, vulnerability] of Object.entries(report.vulnerabilities)) {
      if (Array.isArray(vulnerability.via)) {
        for (const via of vulnerability.via) {
          advisories.push(normalizeVulnerability(via, vulnerability));
        }
      } else {
        advisories.push(normalizeVulnerability(vulnerability));
      }
    }
  }

  return advisories.filter(Boolean);
}

function normalizeVulnerability(vulnerability, parent) {
  if (!vulnerability) {
    return null;
  }

  if (typeof vulnerability === 'string') {
    return {
      title: vulnerability,
      severity: parent && parent.severity ? parent.severity : 'unknown',
      package: parent && parent.name ? parent.name : undefined,
      version: parent && parent.version ? parent.version : undefined
    };
  }

  return {
    title: vulnerability.title || vulnerability.source || 'Unknown vulnerability',
    severity: vulnerability.severity || 'unknown',
    package: vulnerability.name || vulnerability.module_name || vulnerability.package,
    version: vulnerability.version || (parent && parent.version),
    recommendation: vulnerability.fixAvailable || vulnerability.recommendation || undefined,
    url: vulnerability.url || vulnerability.url_info && vulnerability.url_info[0]
  };
}

function printSummary(summary) {
  console.log('\n📋 Security Audit Summary');
  console.log('='.repeat(50));
  console.log(`Info: ${summary.counts.info}`);
  console.log(`Low: ${summary.counts.low}`);
  console.log(`Moderate: ${summary.counts.moderate}`);
  console.log(`High: ${summary.counts.high}`);
  console.log(`Critical: ${summary.counts.critical}`);

  if (summary.advisories.length > 0) {
    console.log('\nDetailed advisories:');
    for (const advisory of summary.advisories) {
      const severityIndex = SEVERITY_ORDER.indexOf((advisory.severity || 'unknown').toLowerCase());
      const highlight = severityIndex >= SEVERITY_THRESHOLD_INDEX ? '❌' : 'ℹ️';
      const packageName = advisory.package ? `${advisory.package}@${advisory.version || 'unknown'}` : 'Unknown package';
      console.log(`  ${highlight} [${(advisory.severity || 'unknown').toUpperCase()}] ${advisory.title} (${packageName})`);
      if (advisory.recommendation) {
        console.log(`     Recommendation: ${formatRecommendation(advisory.recommendation)}`);
      }
      if (advisory.url) {
        console.log(`     More info: ${advisory.url}`);
      }
    }
  }
}

function formatRecommendation(recommendation) {
  if (!recommendation || recommendation === true) {
    return 'Update to the latest available version';
  }

  if (typeof recommendation === 'object') {
    if (recommendation.isPatch) {
      return `Apply patch ${recommendation.name}`;
    }
    if (recommendation.available) {
      return 'Update to a patched version';
    }
  }

  return String(recommendation);
}

if (require.main === module) {
  main();
}

module.exports = { buildSummary, extractAdvisories, normalizeVulnerability };