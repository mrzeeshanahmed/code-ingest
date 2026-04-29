'use strict';

const fs = require('fs').promises;
const path = require('path');
const { execSync } = require('child_process');

class ReleasePreparation {
  constructor() {
    this.packageJsonPath = path.join(process.cwd(), 'package.json');
    this.changelogPath = path.join(process.cwd(), 'CHANGELOG.md');
    this.distDir = path.join(process.cwd(), 'dist');
  }

  async prepareRelease(newVersion, releaseType = 'patch') {
    console.log(`🚀 Preparing release ${newVersion} (${releaseType})...`);

    try {
      await this.runPreReleaseChecks();
      await this.updateVersion(newVersion);
      await this.generateChangelog();
      await this.buildAndTest();
      await this.packageExtension();
      await this.generateReleaseNotes(newVersion);
      await this.validateRelease();

      console.log('✅ Release preparation complete!');
      console.log('Next steps:');
      console.log('  1. Review the generated CHANGELOG.md entry.');
      console.log('  2. Test the packaged VSIX file manually in VS Code.');
      console.log('  3. Create a git tag and push the release branch.');
      console.log('  4. Publish to the VS Code Marketplace.');
    } catch (error) {
      console.error('❌ Release preparation failed:', error.message);
      process.exit(1);
    }
  }

  async runPreReleaseChecks() {
    console.log('🔍 Running pre-release checks...');

    try {
      execSync('git diff --exit-code', { stdio: 'pipe' });
      execSync('git diff --cached --exit-code', { stdio: 'pipe' });
    } catch (error) {
      throw new Error('Working directory is not clean. Commit or stash changes before releasing.');
    }

    const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim();
    if (!['main', 'master'].includes(currentBranch)) {
      console.warn(`⚠️  Warning: Not on main/master branch (currently on ${currentBranch}).`);
    }

    execSync('npm run ci', { stdio: 'inherit' });

    console.log('✅ All pre-release checks passed.');
  }

  async updateVersion(newVersion) {
    console.log(`📝 Updating version to ${newVersion}...`);

    const packageJson = JSON.parse(await fs.readFile(this.packageJsonPath, 'utf8'));
    const oldVersion = packageJson.version;
    packageJson.version = newVersion;

    await fs.writeFile(this.packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);

    console.log(`✅ Version updated: ${oldVersion} → ${newVersion}`);
  }

  async generateChangelog() {
    console.log('📝 Generating changelog entry...');
    const { ChangelogGenerator } = require('./generate-changelog');
    const generator = new ChangelogGenerator();
    await generator.generateChangelog();
    console.log('✅ Changelog updated.');
  }

  async buildAndTest() {
    console.log('🔨 Building and testing...');

    execSync('npm run clean', { stdio: 'inherit' });
    execSync('npm run build', { stdio: 'inherit' });
    execSync('npm run test:all', { stdio: 'inherit' });

    console.log('✅ Build and tests completed.');
  }

  async packageExtension() {
    console.log('📦 Packaging extension...');

    await fs.mkdir(this.distDir, { recursive: true });
    execSync('npm run package', { stdio: 'inherit' });

    const packageJson = JSON.parse(await fs.readFile(this.packageJsonPath, 'utf8'));
    const expectedVsix = path.join(this.distDir, `${packageJson.name}-${packageJson.version}.vsix`);

    try {
      await fs.access(expectedVsix);
      console.log(`✅ Extension packaged: ${expectedVsix}`);
    } catch (error) {
      throw new Error(`Expected VSIX file not found: ${expectedVsix}`);
    }
  }

  async generateReleaseNotes(version) {
    console.log('📄 Generating release notes...');

    const packageJson = JSON.parse(await fs.readFile(this.packageJsonPath, 'utf8'));
    const changelog = await fs.readFile(this.changelogPath, 'utf8');
    const versionPattern = new RegExp(`## \\[${version}\\].*?\n(.*?)(?=\n## \\[|$)`, 's');
    const match = changelog.match(versionPattern);
    const changelogSection = match ? match[1].trim() : 'No changes documented.';

    const releaseNotes = `# Code Ingest ${version}\n\n${packageJson.description}\n\n## What's Changed\n\n${changelogSection}\n\n## Installation\n\n` +
      'Download the VSIX file from this release and install it in VS Code:\n' +
      '1. Open VS Code\n' +
      '2. Go to Extensions (Ctrl+Shift+P)\n' +
      '3. Run "Extensions: Install from VSIX..."\n' +
      '4. Select the downloaded .vsix file\n\n' +
      'Or install from the VS Code Marketplace: [Code Ingest](https://marketplace.visualstudio.com/items?itemName=your-publisher.code-ingest)\n\n' +
      '## Documentation\n\n' +
      '- [User Guide](https://github.com/your-org/code-ingest/blob/main/docs/USER_GUIDE.md)\n' +
      '- [Configuration Reference](https://github.com/your-org/code-ingest/blob/main/docs/CONFIGURATION.md)\n' +
      '- [Troubleshooting](https://github.com/your-org/code-ingest/blob/main/docs/TROUBLESHOOTING.md)\n\n' +
      '## Support\n\n' +
      'If you encounter any issues, please [open an issue](https://github.com/your-org/code-ingest/issues) or check our [discussions](https://github.com/your-org/code-ingest/discussions).\n';

    await fs.writeFile(path.join(this.distDir, `release-notes-${version}.md`), releaseNotes);

    console.log('✅ Release notes generated.');
  }

  async validateRelease() {
    console.log('🔍 Validating release package...');

    const packageJson = JSON.parse(await fs.readFile(this.packageJsonPath, 'utf8'));
    const vsixPath = path.join(this.distDir, `${packageJson.name}-${packageJson.version}.vsix`);

    const stats = await fs.stat(vsixPath);
    const sizeMB = stats.size / (1024 * 1024);
    if (sizeMB > 50) {
      console.warn(`⚠️  Warning: Large VSIX file (${sizeMB.toFixed(1)} MB).`);
    }

    try {
      execSync(`code --install-extension "${vsixPath}" --force`, { stdio: 'pipe' });
      console.log('✅ VSIX installation test passed.');
    } catch (error) {
      console.warn('⚠️  Could not perform VSIX installation test (VS Code CLI might be unavailable).');
    }

    console.log('✅ Release validation completed.');
  }
}

if (require.main === module) {
  const [, , newVersion, releaseType = 'patch'] = process.argv;

  if (!newVersion) {
    console.error('Usage: node scripts/prepare-release.js <version> [release-type]');
    console.error('Example: node scripts/prepare-release.js 1.2.3 minor');
    process.exit(1);
  }

  const preparer = new ReleasePreparation();
  preparer.prepareRelease(newVersion, releaseType).catch((error) => {
    console.error('Release preparation failed:', error);
    process.exit(1);
  });
}

module.exports = { ReleasePreparation };