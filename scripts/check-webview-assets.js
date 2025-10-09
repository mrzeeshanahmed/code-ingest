'use strict';

const fs = require('fs').promises;
const path = require('path');
const esbuild = require('esbuild');

class WebviewAssetValidator {
  constructor() {
    this.webviewDir = path.join(process.cwd(), 'resources', 'webview');
    this.outDir = path.join(process.cwd(), 'out', 'resources', 'webview');

    this.requiredFiles = [
      'index.html',
      'main.js',
      'store.js',
      'styles.css',
      'commandRegistry.js',
      'commandMap.generated.js'
    ];

    this.requiredHandlers = [
      'ingestPreviewHandler.js',
      'progressHandler.js',
      'treeDataHandler.js',
      'configHandler.js',
      'generationResultHandler.js',
      'ingestErrorHandler.js',
      'remoteRepoLoadedHandler.js',
      'restoredStateHandler.js',
      'stateHandler.js',
      'previewDeltaHandler.js'
    ];
  }

  async validateAssets() {
    console.log('🔍 Validating webview assets...');
    const issues = [];

    try {
      await this.checkSourceFiles(issues);
      await this.checkHandlers(issues);
      await this.checkBuildOutput(issues);
      await this.validateHTML(issues);
      await this.validateJavaScript(issues);
      await this.validateCSS(issues);

      this.reportResults(issues);

      const errorCount = issues.filter((issue) => issue.severity === 'error').length;
      if (errorCount > 0) {
        process.exit(1);
      }
    } catch (error) {
      console.error('❌ Asset validation failed:', error.message);
      process.exit(1);
    }
  }

  async checkSourceFiles(issues) {
    for (const file of this.requiredFiles) {
      const filePath = path.join(this.webviewDir, file);
      try {
        await fs.access(filePath);
      } catch (error) {
        issues.push({
          severity: 'error',
          category: 'missing-file',
          message: `Required file missing: ${file}`,
          file: filePath
        });
      }
    }
  }

  async checkHandlers(issues) {
    const handlerDir = path.join(this.webviewDir, 'handlers');
    try {
      await fs.access(handlerDir);
    } catch (error) {
      issues.push({
        severity: 'error',
        category: 'missing-directory',
        message: 'Handlers directory missing',
        file: handlerDir
      });
      return;
    }

    for (const handler of this.requiredHandlers) {
      const handlerPath = path.join(handlerDir, handler);
      try {
        await fs.access(handlerPath);
      } catch (error) {
        issues.push({
          severity: 'error',
          category: 'missing-handler',
          message: `Required handler missing: ${handler}`,
          file: handlerPath
        });
      }
    }
  }

  async checkBuildOutput(issues) {
    for (const file of this.requiredFiles) {
      const outPath = path.join(this.outDir, file);
      try {
        await fs.access(outPath);
      } catch (error) {
        issues.push({
          severity: 'warning',
          category: 'build-output',
          message: `Built file not found: ${file}`,
          file: outPath
        });
      }
    }
  }

  async validateHTML(issues) {
    const htmlPath = path.join(this.webviewDir, 'index.html');
    try {
      const content = await fs.readFile(htmlPath, 'utf8');

      if (!content.includes('<meta http-equiv="Content-Security-Policy"')) {
        issues.push({
          severity: 'warning',
          category: 'html-validation',
          message: 'Missing Content-Security-Policy meta tag',
          file: htmlPath
        });
      }

      const requiredIds = ['file-tree-container', 'preview-container', 'progress-container'];
      for (const id of requiredIds) {
        if (!content.includes(`id="${id}"`)) {
          issues.push({
            severity: 'warning',
            category: 'html-validation',
            message: `Missing required container: ${id}`,
            file: htmlPath
          });
        }
      }

      const requiredScripts = ['main.js', 'store.js'];
      for (const script of requiredScripts) {
        if (!content.includes(`src="${script}"`) && !content.includes(`src="./${script}"`)) {
          issues.push({
            severity: 'error',
            category: 'html-validation',
            message: `Missing script reference: ${script}`,
            file: htmlPath
          });
        }
      }
    } catch (error) {
      issues.push({
        severity: 'error',
        category: 'file-read',
        message: `Could not read HTML file: ${error.message}`,
        file: htmlPath
      });
    }
  }

  async validateJavaScript(issues) {
    const jsFiles = this.requiredFiles.filter((file) => file.endsWith('.js'));
    for (const jsFile of jsFiles) {
      const jsPath = path.join(this.webviewDir, jsFile);
      try {
        const content = await fs.readFile(jsPath, 'utf8');
        this.basicJSValidation(content, jsPath, issues);
      } catch (error) {
        issues.push({
          severity: 'error',
          category: 'file-read',
          message: `Could not read JavaScript file ${jsFile}: ${error.message}`,
          file: jsPath
        });
      }
    }
  }

  basicJSValidation(content, filePath, issues) {
    try {
      esbuild.transformSync(content, {
        loader: 'js',
        format: 'esm',
        target: 'es2020',
        sourcemap: false
      });
    } catch (error) {
      issues.push({
        severity: 'error',
        category: 'js-syntax',
        message: `JavaScript syntax error: ${error.message}`,
        file: filePath
      });
    }

    const lines = content.split('\n');
    lines.forEach((line, index) => {
      const trimmed = line.trim();
      if (trimmed.includes('console.log') && !trimmed.startsWith('//')) {
        issues.push({
          severity: 'warning',
          category: 'js-quality',
          message: `console.log found at line ${index + 1}`,
          file: filePath
        });
      }

      if (trimmed.includes('TODO') || trimmed.includes('FIXME')) {
        issues.push({
          severity: 'info',
          category: 'js-quality',
          message: `TODO/FIXME comment at line ${index + 1}`,
          file: filePath
        });
      }
    });
  }

  async validateCSS(issues) {
    const cssPath = path.join(this.webviewDir, 'styles.css');
    try {
      const content = await fs.readFile(cssPath, 'utf8');
      const requiredVariables = [
        '--vscode-editor-background',
        '--vscode-editor-foreground',
        '--vscode-button-background'
      ];

      for (const variable of requiredVariables) {
        if (!content.includes(variable)) {
          issues.push({
            severity: 'warning',
            category: 'css-validation',
            message: `Missing VS Code theme variable: ${variable}`,
            file: cssPath
          });
        }
      }
    } catch (error) {
      issues.push({
        severity: 'error',
        category: 'file-read',
        message: `Could not read CSS file: ${error.message}`,
        file: cssPath
      });
    }
  }

  reportResults(issues) {
    console.log('\n📋 Webview Asset Validation Results');
    console.log('='.repeat(50));

    if (issues.length === 0) {
      console.log('\n✅ No issues detected');
      return;
    }

    const grouped = issues.reduce((acc, issue) => {
      if (!acc[issue.category]) {
        acc[issue.category] = [];
      }
      acc[issue.category].push(issue);
      return acc;
    }, {});

    for (const [category, categoryIssues] of Object.entries(grouped)) {
      console.log(`\n${category.toUpperCase()}:`);
      for (const issue of categoryIssues) {
        const icon = issue.severity === 'error' ? '❌' : issue.severity === 'warning' ? '⚠️' : 'ℹ️';
        console.log(`  ${icon} ${issue.message}`);
        if (issue.file) {
          console.log(`     ${path.relative(process.cwd(), issue.file)}`);
        }
      }
    }

    const errorCount = issues.filter((issue) => issue.severity === 'error').length;
    const warningCount = issues.filter((issue) => issue.severity === 'warning').length;
    console.log(`\n${errorCount === 0 ? '✅' : '❌'} ${errorCount} errors, ${warningCount} warnings`);
  }
}

if (require.main === module) {
  const validator = new WebviewAssetValidator();
  validator.validateAssets().catch((error) => {
    console.error('Webview asset validation failed:', error);
    process.exit(1);
  });
}

module.exports = { WebviewAssetValidator };
