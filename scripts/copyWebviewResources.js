#!/usr/bin/env node
"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const SRC_DIR = path.join(ROOT, "resources", "webview");
const DEST_DIR = path.join(ROOT, "out", "resources", "webview");
const VENDOR_DEST = path.join(DEST_DIR, "vendor");
const INCLUDED_DIRECTORIES = ["graph", "sidebar", "settings", "vendor"];

async function collectFiles(directory, base = directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const results = [];

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await collectFiles(fullPath, base)));
      continue;
    }

    results.push({
      fullPath,
      relativePath: path.relative(base, fullPath)
    });
  }

  return results;
}

async function copyFile(file, destinationRoot) {
  const destination = path.join(destinationRoot, file.relativePath);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(file.fullPath, destination);
}

async function copyVendorAsset(sourceFile, destinationName) {
  await fs.mkdir(VENDOR_DEST, { recursive: true });
  await fs.copyFile(sourceFile, path.join(VENDOR_DEST, destinationName));
}

async function copyDirectory(relativeDirectory) {
  const sourceDirectory = path.join(SRC_DIR, relativeDirectory);
  const files = await collectFiles(sourceDirectory);
  await Promise.all(files.map((file) => copyFile(file, path.join(DEST_DIR, relativeDirectory))));
  return files.length;
}

async function main() {
  await fs.rm(DEST_DIR, { recursive: true, force: true });
  await fs.mkdir(DEST_DIR, { recursive: true });

  let copiedCount = 0;
  for (const relativeDirectory of INCLUDED_DIRECTORIES) {
    copiedCount += await copyDirectory(relativeDirectory);
  }

  const cytoscapePath = path.join(ROOT, "node_modules", "cytoscape", "dist", "cytoscape.min.js");
  const cosePath = path.join(ROOT, "node_modules", "cytoscape-cose-bilkent", "cytoscape-cose-bilkent.js");

  try {
    await copyVendorAsset(cytoscapePath, "cytoscape.min.js");
  } catch (error) {
    console.warn(`[copy-webview] Unable to copy Cytoscape vendor bundle: ${error.message}`);
  }

  try {
    await copyVendorAsset(cosePath, "cytoscape-cose-bilkent.js");
  } catch (error) {
    console.warn(`[copy-webview] Unable to copy Cytoscape COSE bundle: ${error.message}`);
  }

  console.log(`[copy-webview] Copied ${copiedCount} webview asset(s).`);
}

main().catch((error) => {
  console.error(`[copy-webview] ${error.message}`);
  process.exitCode = 1;
});
