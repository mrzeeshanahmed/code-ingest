'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

class BundleSizeChecker {
  constructor() {
    this.limits = {
      'extension.js': 2 * 1024 * 1024,
      'webview/main.js': 500 * 1024,
      total: 5 * 1024 * 1024
    };

    this.baselinePath = path.join(process.cwd(), 'bundle-size-baseline.json');
    this.reportPath = path.join(process.cwd(), 'bundle-size-report.json');
  }

  hasBaselineEntries(candidate) {
    return candidate && typeof candidate === 'object' && Object.keys(candidate).length > 0;
  }

  async checkBundleSize() {
    console.log('🔍 Checking bundle sizes...');

    try {
      execSync('npm run build', { stdio: 'inherit' });

      const sizes = await this.measureBundleSizes();
      const baseline = await this.loadBaseline();
      const report = this.generateReport(sizes, baseline);

      await this.saveReport(report);
      this.displayResults(report);

      if (!this.validateSizes(report)) {
        process.exit(1);
      }
    } catch (error) {
      console.error('❌ Bundle size check failed:', error.message);
      process.exit(1);
    }
  }

  async measureBundleSizes() {
    const outDir = path.join(process.cwd(), 'out');
    const sizes = {};

    const extensionPath = path.join(outDir, 'extension.js');
    if (fs.existsSync(extensionPath)) {
      sizes['extension.js'] = fs.statSync(extensionPath).size;
    }

    const webviewDir = path.join(outDir, 'resources', 'webview');
    if (fs.existsSync(webviewDir)) {
      const entries = fs.readdirSync(webviewDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith('.js')) {
          const filePath = path.join(webviewDir, entry.name);
          sizes[`webview/${entry.name}`] = fs.statSync(filePath).size;
        }
      }
    }

    const fileSizes = Object.values(sizes);
    sizes.total = fileSizes.length > 0 ? fileSizes.reduce((sum, size) => sum + size, 0) : 0;

    return sizes;
  }

  async loadBaseline() {
    try {
      if (fs.existsSync(this.baselinePath)) {
        const content = fs.readFileSync(this.baselinePath, 'utf8');
        const parsed = JSON.parse(content);
        if (this.hasBaselineEntries(parsed)) {
          console.log('ℹ️  Using baseline from bundle-size-baseline.json');
          return parsed;
        }
      }
    } catch (error) {
      console.warn('⚠️  Could not load baseline sizes from bundle-size-baseline.json:', error.message);
    }

    try {
      if (fs.existsSync(this.reportPath)) {
        const content = fs.readFileSync(this.reportPath, 'utf8');
        const parsed = JSON.parse(content);
        if (parsed && this.hasBaselineEntries(parsed.baseline)) {
          console.log('ℹ️  Using baseline from bundle-size-report.json');
          return parsed.baseline;
        }
      }
    } catch (error) {
      console.warn('⚠️  Could not load baseline sizes from bundle-size-report.json:', error.message);
    }

    console.log('ℹ️  Baseline not found; current bundle sizes will seed a new baseline.');
    return {};
  }

  generateReport(current, baseline) {
    const effectiveBaseline = this.hasBaselineEntries(baseline) ? baseline : { ...current };

    const report = {
      timestamp: new Date().toISOString(),
      current,
      baseline: effectiveBaseline,
      changes: {},
      violations: []
    };

    for (const [key, size] of Object.entries(current)) {
      if (Object.prototype.hasOwnProperty.call(effectiveBaseline, key)) {
        const baselineSize = effectiveBaseline[key];
        if (typeof baselineSize === 'number') {
          const change = size - baselineSize;
          const percentBase = baselineSize === 0 ? 0 : (change / baselineSize) * 100;
          report.changes[key] = {
            absolute: change,
            percent: percentBase,
            size
          };
        }
      }
    }

    for (const [key, limit] of Object.entries(this.limits)) {
      const size = current[key];
      if (typeof size === 'number' && size > limit) {
        report.violations.push({
          file: key,
          size,
          limit,
          excess: size - limit
        });
      }
    }

    return report;
  }

  validateSizes(report) {
    let isValid = true;

    if (report.violations.length > 0) {
      console.error('\n❌ Bundle size limit violations:');
      for (const violation of report.violations) {
        console.error(
          `  ${violation.file}: ${this.formatBytes(violation.size)} ` +
            `(limit: ${this.formatBytes(violation.limit)}, ` +
            `excess: ${this.formatBytes(violation.excess)})`
        );
      }
      isValid = false;
    }

    const significantChanges = Object.entries(report.changes).filter(([, change]) => {
      return change.percent > 10 && change.absolute > 50 * 1024;
    });

    if (significantChanges.length > 0) {
      console.warn('\n⚠️  Significant bundle size increases:');
      for (const [key, change] of significantChanges) {
        const sign = change.absolute >= 0 ? '+' : '';
        console.warn(
          `  ${key}: ${sign}${this.formatBytes(change.absolute)} ` +
            `(${sign}${change.percent.toFixed(1)}%)`
        );
      }
      if (process.env.CI) {
        isValid = false;
      }
    }

    return isValid;
  }

  displayResults(report) {
    console.log('\n📊 Bundle Size Report');
    console.log('='.repeat(50));

    for (const [key, size] of Object.entries(report.current)) {
      const change = report.changes[key];
      let changeStr = '';
      if (change) {
        const sign = change.absolute >= 0 ? '+' : '';
        changeStr = ` (${sign}${this.formatBytes(change.absolute)}, ${sign}${change.percent.toFixed(1)}%)`;
      }

      console.log(`  ${key}: ${this.formatBytes(size)}${changeStr}`);
    }

    if (report.violations.length === 0) {
      console.log('\n✅ All bundles within size limits');
    }
  }

  async saveReport(report) {
    fs.writeFileSync(this.reportPath, JSON.stringify(report, null, 2));
  }

  formatBytes(bytes) {
    if (!Number.isFinite(bytes)) {
      return '0 B';
    }

    const units = ['B', 'KB', 'MB', 'GB'];
    let size = bytes;
    let unitIndex = 0;

    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex += 1;
    }

    return `${size.toFixed(1)} ${units[unitIndex]}`;
  }
}

if (require.main === module) {
  const checker = new BundleSizeChecker();
  checker.checkBundleSize().catch((error) => {
    console.error('Bundle size check failed:', error);
    process.exit(1);
  });
}

module.exports = { BundleSizeChecker };
