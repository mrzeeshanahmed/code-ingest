#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const SRC_DIR = path.resolve(__dirname, '..', 'resources', 'webview');
const ICONS_SRC_DIR = path.resolve(__dirname, '..', 'resources', 'icons');
const DEST_DIR = path.resolve(__dirname, '..', 'out', 'resources', 'webview');
const ICONS_DEST_DIR = path.resolve(__dirname, '..', 'out', 'resources', 'webview', 'icons');
const MANIFEST_FILENAME = 'externals.json';
const MANIFEST_PATH = path.join(DEST_DIR, MANIFEST_FILENAME);
const ALLOWED_EXTENSIONS = new Set(['.html', '.js', '.css', '.json', '.svg', '.png']);
const REQUIRED_FILES = ['index.html', 'main.js', 'styles.css', 'store.js'];
const CONCURRENCY = Math.max(os.cpus().length - 1, 2);

async function ensureSourceDir() {
  try {
    const stat = await fsp.stat(SRC_DIR);
    if (!stat.isDirectory()) {
      throw new Error(`Webview source path exists but is not a directory: ${SRC_DIR}`);
    }
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      throw new Error(`Webview source directory is missing: ${SRC_DIR}`);
    }
    throw error;
  }
}

async function collectFiles(dir, base = dir) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = await collectFiles(fullPath, base);
      files.push(...nested);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const ext = path.extname(entry.name).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      continue;
    }

    const relativePath = path.relative(base, fullPath);
    const stats = await fsp.stat(fullPath);
    files.push({ fullPath, relativePath, stats });
  }

  return files;
}

function validateRequiredFiles(files) {
  const missing = REQUIRED_FILES.filter((file) => !files.some((f) => f.relativePath === file));
  if (missing.length > 0) {
    const details = missing.map((file) => `  • ${file}`).join('\n');
    throw new Error(`Required webview assets are missing:\n${details}`);
  }
}

async function ensureDestDir() {
  await fsp.mkdir(DEST_DIR, { recursive: true });
}

function shouldCopy(sourceStats, destStats) {
  if (!destStats) {
    return true;
  }
  if (sourceStats.mtimeMs > destStats.mtimeMs) {
    return true;
  }
  if (sourceStats.size !== destStats.size) {
    return true;
  }
  return false;
}

async function copyFileDescriptor(file) {
  const destinationPath = path.join(DEST_DIR, file.relativePath);
  const destinationDir = path.dirname(destinationPath);
  await fsp.mkdir(destinationDir, { recursive: true });

  let destStats;
  try {
    destStats = await fsp.stat(destinationPath);
  } catch (error) {
    if (!error || error.code !== 'ENOENT') {
      throw error;
    }
  }

  if (!shouldCopy(file.stats, destStats)) {
    return { copied: false, bytes: 0, destinationPath };
  }

  await fsp.copyFile(file.fullPath, destinationPath, fs.constants.COPYFILE_FICLONE);
  await fsp.chmod(destinationPath, file.stats.mode);
  await fsp.utimes(destinationPath, file.stats.atime, file.stats.mtime);

  return { copied: true, bytes: file.stats.size, destinationPath };
}

async function runWithConcurrency(items, worker) {
  const queue = items.slice();
  let active = 0;
  let resolveAll;
  let rejectAll;
  const results = [];

  return new Promise((resolve, reject) => {
    resolveAll = resolve;
    rejectAll = reject;

    const launchNext = () => {
      if (queue.length === 0 && active === 0) {
        resolveAll(results);
        return;
      }

      while (active < CONCURRENCY && queue.length > 0) {
        const item = queue.shift();
        const index = results.length;
        active += 1;
        Promise.resolve()
          .then(() => worker(item))
          .then((value) => {
            results[index] = value;
            active -= 1;
            launchNext();
          })
          .catch((error) => {
            rejectAll(error);
          });
      }
    };

    launchNext();
  });
}

function formatBytes(bytes) {
  if (bytes === 0) {
    return '0 B';
  }
  const units = ['B', 'KB', 'MB', 'GB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, exponent);
  return `${value.toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

function logProgress(message) {
  console.log(`[copy-webview] ${message}`);
}

async function writeManifest(files) {
  const manifest = {
    generatedAt: new Date().toISOString(),
    resources: {}
  };

  for (const file of files) {
    const relativePosix = file.relativePath.split(path.sep).join('/');
    manifest.resources[relativePosix] = `resources/webview/${relativePosix}`;
  }

  await fsp.mkdir(path.dirname(MANIFEST_PATH), { recursive: true });
  await fsp.writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

async function main() {
  const startTime = Date.now();
  logProgress('Starting webview asset copy.');

  await ensureSourceDir();
  const files = await collectFiles(SRC_DIR);
  
  // Also collect icon files
  try {
    const iconFiles = await collectFiles(ICONS_SRC_DIR, ICONS_SRC_DIR);
    // Prefix icon files with 'icons/' in their relative path
    iconFiles.forEach(file => {
      file.relativePath = path.join('icons', file.relativePath);
    });
    files.push(...iconFiles);
    logProgress(`Found ${iconFiles.length} icon file(s).`);
  } catch (error) {
    logProgress(`Warning: Could not copy icons: ${error.message}`);
  }
  
  validateRequiredFiles(files);
  await ensureDestDir();
  await fsp.mkdir(ICONS_DEST_DIR, { recursive: true });

  logProgress(`Found ${files.length} asset${files.length === 1 ? '' : 's'} to evaluate.`);

  let copiedCount = 0;
  let skippedCount = 0;
  let totalBytesCopied = 0;

  await runWithConcurrency(files, async (file) => {
    const result = await copyFileDescriptor(file);
    if (result.copied) {
      copiedCount += 1;
      totalBytesCopied += file.stats.size;
      logProgress(`Copied ${file.relativePath}`);
    } else {
      skippedCount += 1;
    }
    return result;
  });

  await writeManifest(files);

  const durationMs = Date.now() - startTime;
  logProgress('Webview asset copy complete.');
  logProgress(`Copied ${copiedCount} file${copiedCount === 1 ? '' : 's'}, skipped ${skippedCount}.`);
  logProgress(`Transferred ${formatBytes(totalBytesCopied)} in ${durationMs}ms.`);
  logProgress(`Manifest written to ${MANIFEST_PATH}`);
}

main().catch((error) => {
  console.error(`[copy-webview] Error: ${error.message}`);
  if (error.stack) {
    console.error(error.stack);
  }
  process.exitCode = 1;
});
