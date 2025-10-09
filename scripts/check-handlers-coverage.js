'use strict';

const fs = require('fs').promises;
const path = require('path');

class HandlersCoverage {
  constructor() {
    this.webviewDir = path.join(process.cwd(), 'resources', 'webview');
    this.testDirs = [
      path.join(this.webviewDir, 'handlers', '__tests__'),
      path.join(process.cwd(), 'src', 'test', 'unit', 'webview'),
      path.join(process.cwd(), 'src', 'test', 'integration', 'webview')
    ];
    this.threshold = 80;
  }

  async checkCoverage() {
    console.log('🔍 Checking webview handlers test coverage...');

    try {
      const handlers = await this.findHandlers();
      const tests = await this.findHandlerTests();
      const coverage = this.calculateCoverage(handlers, tests);
      this.displayResults(coverage);

      if (coverage.percentage < this.threshold) {
        console.error(`❌ Handler coverage ${coverage.percentage}% is below threshold (${this.threshold}%)`);
        process.exit(1);
      }
    } catch (error) {
      console.error('❌ Handler coverage check failed:', error.message);
      process.exit(1);
    }
  }

  async findHandlers() {
    const handlerDir = path.join(this.webviewDir, 'handlers');
    const handlers = [];

    let entries;
    try {
      entries = await fs.readdir(handlerDir, { withFileTypes: true });
    } catch (error) {
      throw new Error(`Could not read handlers directory: ${error.message}`);
    }

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('Handler.js')) {
        continue;
      }

      const name = entry.name.replace('.js', '');
      handlers.push({
        name,
        file: entry.name,
        path: path.join(handlerDir, entry.name),
        tested: false
      });
    }

    return handlers;
  }

  async findHandlerTests() {
    const tests = [];

    for (const dir of this.testDirs) {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch (error) {
        continue;
      }

      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.test.js')) {
          continue;
        }

        const testPath = path.join(dir, entry.name);
        let content = '';
        try {
          content = await fs.readFile(testPath, 'utf8');
        } catch (error) {
          console.warn(`⚠️  Could not read test file ${testPath}: ${error.message}`);
        }

        tests.push({
          name: entry.name,
          path: testPath,
          content
        });
      }
    }

    return tests;
  }

  calculateCoverage(handlers, tests) {
    const handlerLookup = new Map();
    handlers.forEach((handler) => handlerLookup.set(handler.name.toLowerCase(), handler));

    for (const test of tests) {
      const testLower = test.name.toLowerCase();
      for (const handler of handlers) {
        if (testLower.includes(handler.name.toLowerCase())) {
          handler.tested = true;
        } else if (test.content && test.content.toLowerCase().includes(handler.name.toLowerCase())) {
          handler.tested = true;
        }
      }
    }

    const totalHandlers = handlers.length;
    const coveredHandlers = handlers.filter((handler) => handler.tested).length;
    const percentage = totalHandlers === 0 ? 0 : Math.round((coveredHandlers / totalHandlers) * 100);

    return {
      totalHandlers,
      coveredHandlers,
      percentage,
      uncoveredHandlers: handlers.filter((handler) => !handler.tested),
      handlers,
      tests
    };
  }

  displayResults(coverage) {
    console.log('\n📊 Handler Test Coverage Report');
    console.log('='.repeat(50));
    console.log(`Total handlers: ${coverage.totalHandlers}`);
    console.log(`Covered handlers: ${coverage.coveredHandlers}`);
    console.log(`Coverage: ${coverage.percentage}%`);

    if (coverage.uncoveredHandlers.length > 0) {
      console.log('\n❌ Uncovered handlers:');
      for (const handler of coverage.uncoveredHandlers) {
        console.log(`  - ${handler.name}`);
      }
    } else {
      console.log('\n✅ All handlers have test coverage');
    }

    if (coverage.percentage >= this.threshold) {
      console.log(`\n✅ Handler coverage meets minimum threshold (${this.threshold}%)`);
    } else {
      console.log(`\n⚠️  Handler coverage below minimum threshold (${this.threshold}%)`);
    }
  }
}

if (require.main === module) {
  const checker = new HandlersCoverage();
  checker.checkCoverage().catch((error) => {
    console.error('Handler coverage check failed:', error);
    process.exit(1);
  });
}

module.exports = { HandlersCoverage };
