'use strict';

const fs = require('fs').promises;
const path = require('path');

class MarketplaceOptimizer {
  constructor() {
    this.assetsDir = path.join(__dirname, '..', '..', 'marketplace-assets');
    this.metadataPath = path.join(this.assetsDir, 'marketing', 'MARKETPLACE_README.md');
    this.packagePath = path.join(this.assetsDir, 'marketing', 'package.marketplace.json');
  }

  async optimizeForDiscoverability() {
    await this.optimizeKeywords();
    await this.optimizeDescription();
    await this.optimizeTags();
    await this.optimizeImageSizes();
    await this.validateAssetCompliance();
    await this.generateVariations();
  }

  async optimizeKeywords() {
    const pkg = await this.readPackage();
    const keywordSet = new Set([...(pkg.keywords || [])]);
    ['developer-tools', 'documentation', 'automation', 'knowledge-base', 'digest'].forEach((keyword) => keywordSet.add(keyword));
    pkg.keywords = Array.from(keywordSet);
    await this.writePackage(pkg);
  }

  async optimizeDescription() {
    const pkg = await this.readPackage();
    const headline = 'Generate professional documentation digests with Code Ingest.';
    const highlights = [
      'Smart file tree selection with remote repository support.',
      'Multi-format exports: Markdown, JSON, and concise briefs.',
      'Performance dashboards and Jupyter notebook insights.'
    ];
    pkg.description = `${headline} ${highlights.join(' ')}`;
    await this.writePackage(pkg);
  }

  async optimizeTags() {
    const pkg = await this.readPackage();
    pkg.categories = Array.from(new Set([...(pkg.categories || []), 'Documentation', 'Productivity', 'Source Control']));
    await this.writePackage(pkg);
  }

  async optimizeImageSizes() {
    const manifestPath = path.join(this.assetsDir, 'asset-manifest.json');
    try {
      const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
      manifest.metadata.optimizedAt = new Date().toISOString();
      await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    } catch (error) {
      // ignore if manifest missing; asset generator will create it
    }
  }

  async validateAssetCompliance() {
    const screenshotsDir = path.join(this.assetsDir, 'screenshots');
    let files = [];
    try {
      files = await fs.readdir(screenshotsDir);
    } catch (error) {
      return;
    }

    const invalid = files.filter((file) => !file.endsWith('.png'));
    if (invalid.length > 0) {
      throw new Error(`Non-compliant screenshot formats detected: ${invalid.join(', ')}`);
    }
  }

  async generateVariations() {
    const templatePath = path.join(this.assetsDir, 'marketing', 'MARKETPLACE_README.md');
    try {
      const baseReadme = await fs.readFile(templatePath, 'utf8');
      const variants = [
        { suffix: 'performance', emphasis: 'performance dashboards and throughput metrics.' },
        { suffix: 'docs', emphasis: 'documentation teams generating concise briefs.' }
      ];

      for (const variant of variants) {
        const content = baseReadme.replace('Code Ingest is crafted for documentation teams, developer advocates, and engineers shipping high-quality knowledge bases.', `Code Ingest excels for ${variant.emphasis}`);
        const variantPath = path.join(this.assetsDir, 'marketing', `MARKETPLACE_README_${variant.suffix.toUpperCase()}.md`);
        await fs.writeFile(variantPath, `${content}\n`);
      }
    } catch (error) {
      // ignore if base README missing; asset generator should run first
    }
  }

  async readPackage() {
    const data = await fs.readFile(this.packagePath, 'utf8');
    return JSON.parse(data);
  }

  async writePackage(pkg) {
    await fs.writeFile(this.packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
  }
}

module.exports = { MarketplaceOptimizer };

if (require.main === module) {
  (async () => {
    try {
      const optimizer = new MarketplaceOptimizer();
      await optimizer.optimizeForDiscoverability();
      console.log('✅ Marketplace optimization complete.');
    } catch (error) {
      console.error('❌ Marketplace optimization failed:', error);
      process.exitCode = 1;
    }
  })();
}
