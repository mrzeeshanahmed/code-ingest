#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { Script } = require('node:vm');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'out');
const EXTENSION_BUNDLE_PATH = path.join(OUT_DIR, 'extension.js');
const WEBVIEW_OUT_DIR = path.join(OUT_DIR, 'resources', 'webview');
const REPORT_PATH = path.join(ROOT, 'build-report.json');
const PACKAGE_JSON_PATH = path.join(ROOT, 'package.json');
const WEBVIEW_REQUIRED_FILES = ['index.html', 'main.js', 'styles.css', 'store.js'];
const MAX_EXTENSION_BUNDLE_SIZE = 2 * 1024 * 1024; // 2 MB
const SOURCE_GLOB_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx'];

const report = {
  startedAt: new Date().toISOString(),
  durationMs: 0,
  memory: {},
  metrics: {
    extensionBundleBytes: 0,
    webviewBytes: 0,
    webviewFileCount: 0
  },
  dependencyAudit: {
    unusedDependencies: [],
    missingImports: [],
    securityFindings: []
  },
  validations: [],
  warnings: [],
  errors: []
};

function recordValidation(name, passed, details = '') {
  report.validations.push({ name, passed, details });
  if (!passed) {
    report.errors.push(`${name}: ${details}`.trim());
  }
}

function recordWarning(message) {
  report.warnings.push(message);
}

async function fileExists(filePath) {
  try {
    await fsp.access(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath) {
  const raw = await fsp.readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

async function collectFiles(dir, predicate) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const results = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = await collectFiles(fullPath, predicate);
      results.push(...nested);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    if (!predicate || predicate(fullPath)) {
      results.push(fullPath);
    }
  }

  return results;
}

function hasAllowedExtension(filePath) {
  return SOURCE_GLOB_EXTENSIONS.includes(path.extname(filePath));
}

async function validateExtensionBundle() {
  const name = 'extension-bundle';
  try {
    const stat = await fsp.stat(EXTENSION_BUNDLE_PATH);
    report.metrics.extensionBundleBytes = stat.size;

    if (stat.size === 0) {
      recordValidation(name, false, 'extension.js is empty.');
      return;
    }

    if (stat.size > MAX_EXTENSION_BUNDLE_SIZE) {
      recordWarning(`Extension bundle size ${stat.size} bytes exceeds threshold ${MAX_EXTENSION_BUNDLE_SIZE}.`);
    }

    const content = await fsp.readFile(EXTENSION_BUNDLE_PATH, 'utf8');
    const criticalDeps = ['minimatch', 'vscode'];
    const missing = criticalDeps.filter((dep) => !content.includes(dep));
    if (missing.length > 0) {
      recordWarning(`Critical dependencies not detected in bundle: ${missing.join(', ')}`);
    }

    recordValidation(name, true, `Bundle size ${stat.size} bytes.`);
  } catch (error) {
    recordValidation(name, false, `Failed to validate extension bundle: ${error.message}`);
  }
}

async function validateWebviewResources() {
  const name = 'webview-assets';
  try {
    const dirStat = await fsp.stat(WEBVIEW_OUT_DIR);
    if (!dirStat.isDirectory()) {
      recordValidation(name, false, 'Webview output path exists but is not a directory.');
      return;
    }

    const allFiles = await collectFiles(WEBVIEW_OUT_DIR);
    report.metrics.webviewFileCount = allFiles.length;
    report.metrics.webviewBytes = await allFiles.reduce(async (accPromise, file) => {
      const acc = await accPromise;
      const stat = await fsp.stat(file);
      return acc + stat.size;
    }, Promise.resolve(0));

    const missingRequired = WEBVIEW_REQUIRED_FILES.filter((rel) => !allFiles.some((file) => file.endsWith(rel)));
    if (missingRequired.length > 0) {
      recordValidation(name, false, `Missing required webview files: ${missingRequired.join(', ')}`);
      return;
    }

    // Validate CSP meta in HTML
    const htmlFiles = allFiles.filter((file) => file.endsWith('.html'));
    const htmlIssues = [];
    for (const file of htmlFiles) {
      const content = await fsp.readFile(file, 'utf8');
      if (!/Content-Security-Policy/i.test(content)) {
        htmlIssues.push(`${path.relative(WEBVIEW_OUT_DIR, file)} is missing CSP meta tag.`);
      }
    }

    if (htmlIssues.length > 0) {
      htmlIssues.forEach((issue) => recordWarning(issue));
    }

    // Basic JS syntax check
    const jsFiles = allFiles.filter((file) => file.endsWith('.js'));
    for (const file of jsFiles) {
      const content = await fsp.readFile(file, 'utf8');
      try {
        new Script(content, { filename: file });
      } catch (error) {
        recordValidation(name, false, `JavaScript syntax error in ${path.relative(WEBVIEW_OUT_DIR, file)}: ${error.message}`);
        return;
      }
    }

    recordValidation(name, true, `${allFiles.length} files checked.`);
  } catch (error) {
    recordValidation(name, false, `Failed to validate webview assets: ${error.message}`);
  }
}

async function validatePackageJsonIntegrity() {
  const name = 'package-json';
  try {
    const pkg = await readJson(PACKAGE_JSON_PATH);
    const srcFiles = await collectFiles(path.join(ROOT, 'src'), hasAllowedExtension);
    const srcContent = await Promise.all(srcFiles.map((file) => fsp.readFile(file, 'utf8')));
    const srcCombined = srcContent.join('\n');

    const commandIssues = [];
    if (pkg.contributes?.commands) {
      for (const command of pkg.contributes.commands) {
        const commandId = command.command;
        if (!commandId) {
          commandIssues.push('Found command without id in package.json.');
          continue;
        }

        if (!srcCombined.includes(commandId)) {
          commandIssues.push(`Command ${commandId} lacks implementation reference in src.`);
        }
      }
    }

    const viewIssues = [];
    if (pkg.contributes?.views) {
      for (const viewGroup of Object.values(pkg.contributes.views)) {
        for (const view of viewGroup) {
          if (!view.id) {
            continue;
          }
          if (!srcCombined.includes(view.id)) {
            viewIssues.push(`View ${view.id} is not referenced in source code.`);
          }
        }
      }
    }

    const scriptIssues = [];
    if (pkg.scripts) {
      for (const [scriptName, scriptValue] of Object.entries(pkg.scripts)) {
        const matches = scriptValue.match(/node\s+([^\s]+)/);
        if (matches) {
          const scriptPath = matches[1];
          const resolved = path.resolve(ROOT, scriptPath);
          if (!(await fileExists(resolved))) {
            scriptIssues.push(`Script "${scriptName}" references missing file ${scriptPath}`);
          }
        }
      }
    }

    const issues = [...commandIssues, ...viewIssues, ...scriptIssues];
    if (issues.length > 0) {
      issues.forEach((issue) => recordWarning(issue));
      recordValidation(name, commandIssues.length === 0 && viewIssues.length === 0 && scriptIssues.length === 0, issues.join(' | '));
      return;
    }

    recordValidation(name, true, 'package.json contributes sections validated.');
  } catch (error) {
    recordValidation(name, false, `Failed to validate package.json integrity: ${error.message}`);
  }
}

async function validateTypeScriptOutput() {
  const name = 'typescript-output';
  try {
    const dtsFiles = await collectFiles(OUT_DIR, (file) => file.endsWith('.d.ts'));
    if (dtsFiles.length === 0) {
      recordValidation(name, false, 'No .d.ts declaration files found in out/.');
      return;
    }

    const mapFiles = await collectFiles(OUT_DIR, (file) => file.endsWith('.map'));
    if (mapFiles.length === 0) {
      recordWarning('No source maps found in out/.');
    }

    // basic map validation: ensure extension.js.map references file
    const extMapPath = `${EXTENSION_BUNDLE_PATH}.map`;
    if (await fileExists(extMapPath)) {
      const mapJson = await readJson(extMapPath);
      if (!mapJson.sources || mapJson.sources.length === 0) {
        recordWarning('extension.js.map has empty sources array.');
      }
    }

    recordValidation(name, true, `${dtsFiles.length} declaration files detected.`);
  } catch (error) {
    recordValidation(name, false, `Failed to validate TypeScript output: ${error.message}`);
  }
}

async function analyzeDependencies() {
  const name = 'dependency-analysis';
  try {
    const pkg = await readJson(PACKAGE_JSON_PATH);
    const depNames = Object.keys(pkg.dependencies ?? {});
    const devDepNames = Object.keys(pkg.devDependencies ?? {});
    const allCodeFiles = [
      ...(await collectFiles(path.join(ROOT, 'src'), hasAllowedExtension)),
      ...(await collectFiles(path.join(ROOT, 'resources'), (file) => hasAllowedExtension(file) || file.endsWith('.json')))
    ];

    const fileContents = await Promise.all(allCodeFiles.map((file) => fsp.readFile(file, 'utf8')));
    const combined = fileContents.join('\n');

    const unused = depNames.filter((dep) => !combined.includes(dep));
    report.dependencyAudit.unusedDependencies = unused;
    if (unused.length > 0) {
      recordWarning(`Unused dependencies detected: ${unused.join(', ')}`);
    }

    // basic relative import resolution check
    const missingImports = [];
    const relativeImportRegex = /import\s+["'`]([^"'`]+)["'`]|require\(([^)]+)\)/g;
    for (let index = 0; index < allCodeFiles.length; index += 1) {
      const file = allCodeFiles[index];
      const dir = path.dirname(file);
      const content = fileContents[index];
      let match;
      while ((match = relativeImportRegex.exec(content))) {
        const specifierRaw = match[1] ?? match[2];
        if (!specifierRaw) {
          continue;
        }
        const specifier = specifierRaw.replace(/["'`]/g, '').trim();
        if (!specifier.startsWith('.') && !specifier.startsWith('..')) {
          continue;
        }

        const resolvedCandidates = [
          path.resolve(dir, `${specifier}.ts`),
          path.resolve(dir, `${specifier}.tsx`),
          path.resolve(dir, `${specifier}.js`),
          path.resolve(dir, `${specifier}.jsx`),
          path.resolve(dir, specifier),
          path.resolve(dir, specifier, 'index.ts'),
          path.resolve(dir, specifier, 'index.tsx'),
          path.resolve(dir, specifier, 'index.js')
        ];

        const exists = await Promise.any(
          resolvedCandidates.map(async (candidate) => {
            try {
              const stat = await fsp.stat(candidate);
              return stat.isFile();
            } catch {
              return false;
            }
          })
        ).catch(() => false);

        if (!exists) {
          missingImports.push(`${specifier} (from ${path.relative(ROOT, file)})`);
        }
      }
    }

    report.dependencyAudit.missingImports = missingImports;
    if (missingImports.length > 0) {
      recordWarning(`Missing imports detected: ${missingImports.join('; ')}`);
    }

    // security audit (best effort)
    const securityFindings = await runNpmAudit();
    report.dependencyAudit.securityFindings = securityFindings;
    if (securityFindings.length > 0) {
      recordWarning(`Security vulnerabilities reported: ${securityFindings.length}`);
    }

    recordValidation(name, missingImports.length === 0, missingImports.length === 0 ? 'Dependency analysis completed.' : 'Missing imports detected.');
  } catch (error) {
    recordValidation(name, false, `Dependency analysis failed: ${error.message}`);
  }
}

function runNpmAudit() {
  return new Promise((resolve) => {
    const audit = spawn('npm', ['audit', '--json', '--production'], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    audit.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    audit.on('error', (error) => {
      recordWarning(`npm audit failed to launch: ${error.message}`);
      resolve([]);
    });

    audit.on('close', (code) => {
      if (!stdout) {
        resolve([]);
        return;
      }

      try {
        const data = JSON.parse(stdout);
        const advisories = data.vulnerabilities
          ? Object.entries(data.vulnerabilities).flatMap(([pkg, info]) => (
              info.via
                ? info.via.map((item) =>
                    typeof item === 'string'
                      ? { package: pkg, advisory: item }
                      : { package: pkg, advisory: item.title ?? 'Unknown advisory' }
                  )
                : []
            ))
          : [];
        resolve(advisories);
      } catch (error) {
        recordWarning(`npm audit output parse failure: ${error.message}`);
        resolve([]);
      }
    });
  });
}

async function gatherPerformanceMetrics(startTime) {
  report.durationMs = Math.round(performance.now() - startTime);
  const mem = process.memoryUsage();
  report.memory = {
    rss: mem.rss,
    heapTotal: mem.heapTotal,
    heapUsed: mem.heapUsed,
    external: mem.external
  };
}

async function writeReport() {
  await fsp.writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

async function main() {
  const start = performance.now();

  await validateExtensionBundle();
  await validateWebviewResources();
  await validatePackageJsonIntegrity();
  await validateTypeScriptOutput();
  await analyzeDependencies();

  await gatherPerformanceMetrics(start);
  await writeReport();

  if (report.errors.length > 0) {
    console.error('\nBuild validation failed with the following issues:');
    report.errors.forEach((error) => {
      console.error(`  - ${error}`);
    });
    if (report.warnings.length > 0) {
      console.error('\nWarnings:');
      report.warnings.forEach((warning) => console.error(`  • ${warning}`));
    }
    console.error(`\nDetailed report written to ${REPORT_PATH}`);
    process.exitCode = 1;
    return;
  }

  if (report.warnings.length > 0) {
    console.warn('Build validation completed with warnings:');
    report.warnings.forEach((warning) => console.warn(`  • ${warning}`));
  }

  console.log('Build validation completed successfully.');
  console.log(`Report written to ${REPORT_PATH}`);
}

main().catch((error) => {
  console.error('Unexpected error during build validation.', error);
  process.exitCode = 1;
});
