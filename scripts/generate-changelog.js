'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

class ChangelogGenerator {
  constructor() {
    this.changelogPath = path.join(process.cwd(), 'CHANGELOG.md');
    this.packageJsonPath = path.join(process.cwd(), 'package.json');
  }

  async generateChangelog() {
    console.log('📝 Generating CHANGELOG.md...');

    try {
      const packageJson = JSON.parse(fs.readFileSync(this.packageJsonPath, 'utf8'));
      const currentVersion = packageJson.version;

      const commits = this.getCommitsSinceLastTag();
      const categorizedChanges = this.categorizeChanges(commits);
      const newEntry = this.formatChangelogEntry(currentVersion, categorizedChanges);

      await this.updateChangelog(newEntry);

      console.log(`✅ CHANGELOG.md updated for version ${currentVersion}`);
    } catch (error) {
      console.error('❌ Failed to generate changelog:', error.message);
      process.exit(1);
    }
  }

  getCommitsSinceLastTag() {
    try {
      const latestTag = execSync('git describe --tags --abbrev=0', { encoding: 'utf8' }).trim();
      console.log(`Latest tag: ${latestTag}`);

      return this.parseCommits(
        execSync(`git log ${latestTag}..HEAD --pretty=format:"%h|%s|%b"`, { encoding: 'utf8' })
      );
    } catch (error) {
      console.warn('No previous tags found, getting all commits');
      return this.parseCommits(execSync('git log --pretty=format:"%h|%s|%b"', { encoding: 'utf8' }));
    }
  }

  parseCommits(rawLog) {
    return rawLog
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        const [hash = '', subject = '', body = ''] = line.split('|');
        return {
          hash: hash.trim(),
          subject: subject.trim(),
          body: body.trim()
        };
      });
  }

  categorizeChanges(commits) {
    const categories = {
      breaking: [],
      features: [],
      improvements: [],
      fixes: [],
      security: [],
      performance: [],
      docs: [],
      internal: []
    };

    const patterns = {
      breaking: /breaking[\s:-]change|^breaking[\s:-]?|^BREAKING/i,
      features: /^feat[(:)]|^feature[(:)]|^add[(:)]|^\+/i,
      improvements: /^improv|^enhanc|^update|^refactor/i,
      fixes: /^fix[(:)]|^bug[(:)]|^hotfix|^patch/i,
      security: /^security|^sec[(:)]|vulnerab/i,
      performance: /^perf[(:)]|^performance|optimi[sz]e|speed/i,
      docs: /^docs[(:)]|^doc[(:)]|documentation|readme/i,
      internal: /^chore|^build|^ci|^test[(:)]|^style/i
    };

    commits.forEach((commit) => {
      const target = Object.entries(patterns).find(([category, pattern]) => {
        return pattern.test(commit.subject) || pattern.test(commit.body);
      });

      if (target) {
        const [category] = target;
        categories[category].push(commit);
      } else {
        categories.internal.push(commit);
      }
    });

    return categories;
  }

  formatChangelogEntry(version, categories) {
    const date = new Date().toISOString().split('T')[0];
    let entry = `## [${version}] - ${date}\n\n`;

    const categoryTitles = {
      breaking: '💥 BREAKING CHANGES',
      features: '✨ New Features',
      improvements: '🚀 Improvements',
      fixes: '🐛 Bug Fixes',
      security: '🔒 Security',
      performance: '⚡ Performance',
      docs: '📚 Documentation',
      internal: '🔧 Internal'
    };

    Object.entries(categories).forEach(([category, commits]) => {
      if (commits.length === 0) {
        return;
      }

      entry += `### ${categoryTitles[category]}\n\n`;

      commits.forEach((commit) => {
        const shortHash = commit.hash.substring(0, 7);
        const subject = commit.subject.replace(/^[^:]+:\s*/, '').replace(/^\w+\s*/, '');
        entry += `- ${subject} ([${shortHash}](https://github.com/your-org/code-ingest/commit/${commit.hash}))\n`;
      });

      entry += '\n';
    });

    return entry;
  }

  async updateChangelog(newEntry) {
    let existingChangelog;

    try {
      existingChangelog = fs.readFileSync(this.changelogPath, 'utf8');
    } catch (error) {
      existingChangelog =
        '# Changelog\n\nAll notable changes to the Code Ingest extension will be documented in this file.\n\n' +
        'The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),\n' +
        'and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).\n\n';
    }

    const headerEnd = existingChangelog.indexOf('\n## ');
    let updated;

    if (headerEnd !== -1) {
      const header = existingChangelog.substring(0, headerEnd);
      const entries = existingChangelog.substring(headerEnd);
      updated = `${header}\n${newEntry}${entries}`;
    } else {
      updated = `${existingChangelog}\n${newEntry}`;
    }

    fs.writeFileSync(this.changelogPath, updated.trimEnd() + '\n');
  }
}

if (require.main === module) {
  const generator = new ChangelogGenerator();
  generator.generateChangelog().catch((error) => {
    console.error('Changelog generation failed:', error);
    process.exit(1);
  });
}

module.exports = { ChangelogGenerator };