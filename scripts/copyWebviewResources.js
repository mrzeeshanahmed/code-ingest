#!/usr/bin/env node
"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "out");
const SRC_DIR = path.join(ROOT, "resources", "webview");
const DEST_DIR = path.join(OUT_DIR, "resources", "webview");
const VENDOR_DEST = path.join(DEST_DIR, "vendor");
const GRAMMARS_DEST = path.join(OUT_DIR, "grammars");
const WASM_DEST = path.join(OUT_DIR, "wasm");
const INCLUDED_DIRECTORIES = ["graph", "sidebar", "settings", "vendor"];
const CURATED_GRAMMARS = [
  {
    languageIds: ["javascript", "javascriptreact"],
    sourceFile: path.join(ROOT, "node_modules", "@vscode", "tree-sitter-wasm", "wasm", "tree-sitter-javascript.wasm"),
    packagedPath: "out/grammars/tree-sitter-javascript.wasm"
  },
  {
    languageIds: ["typescript"],
    sourceFile: path.join(ROOT, "node_modules", "@vscode", "tree-sitter-wasm", "wasm", "tree-sitter-typescript.wasm"),
    packagedPath: "out/grammars/tree-sitter-typescript.wasm"
  },
  {
    languageIds: ["typescriptreact"],
    sourceFile: path.join(ROOT, "node_modules", "@vscode", "tree-sitter-wasm", "wasm", "tree-sitter-tsx.wasm"),
    packagedPath: "out/grammars/tree-sitter-tsx.wasm"
  }
];
const RUNTIME_ASSETS = [
  {
    name: "tree-sitter-core",
    sourceFile: path.join(ROOT, "node_modules", "@vscode", "tree-sitter-wasm", "wasm", "tree-sitter.wasm"),
    packagedPath: "out/wasm/tree-sitter.wasm"
  },
  {
    name: "tree-sitter-web",
    sourceFile: path.join(ROOT, "node_modules", "web-tree-sitter", "web-tree-sitter.wasm"),
    packagedPath: "out/wasm/web-tree-sitter.wasm"
  },
  {
    name: "wa-sqlite-async",
    sourceFile: path.join(ROOT, "node_modules", "wa-sqlite", "dist", "wa-sqlite-async.wasm"),
    packagedPath: "out/wasm/wa-sqlite-async.wasm"
  }
];

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

async function copyPackagedAsset(sourceFile, packagedPath) {
  const destination = path.join(ROOT, ...packagedPath.split("/"));

  try {
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(sourceFile, destination);
  } catch (error) {
    throw new Error(`Unable to copy packaged asset from ${sourceFile} to ${packagedPath}: ${error.message}`);
  }
}

async function copyDirectory(relativeDirectory) {
  const sourceDirectory = path.join(SRC_DIR, relativeDirectory);
  const files = await collectFiles(sourceDirectory);
  await Promise.all(files.map((file) => copyFile(file, path.join(DEST_DIR, relativeDirectory))));
  return files.length;
}

async function copyPackagedRuntimeAssets() {
  const manifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    grammars: {},
    runtimes: {}
  };

  for (const asset of CURATED_GRAMMARS) {
    await copyPackagedAsset(asset.sourceFile, asset.packagedPath);
    for (const languageId of asset.languageIds) {
      manifest.grammars[languageId] = asset.packagedPath;
    }
  }

  for (const asset of RUNTIME_ASSETS) {
    await copyPackagedAsset(asset.sourceFile, asset.packagedPath);
    manifest.runtimes[asset.name] = asset.packagedPath;
  }

  await fs.mkdir(GRAMMARS_DEST, { recursive: true });
  await fs.writeFile(path.join(GRAMMARS_DEST, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  return {
    grammarCount: CURATED_GRAMMARS.length,
    runtimeCount: RUNTIME_ASSETS.length
  };
}

async function main() {
  await fs.rm(DEST_DIR, { recursive: true, force: true });
  await fs.rm(GRAMMARS_DEST, { recursive: true, force: true });
  await fs.rm(WASM_DEST, { recursive: true, force: true });
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

  const packagedAssets = await copyPackagedRuntimeAssets();

  console.log(
    `[copy-webview] Copied ${copiedCount} webview asset(s), ${packagedAssets.grammarCount} grammar asset(s), and ${packagedAssets.runtimeCount} runtime asset(s).`
  );
}

main().catch((error) => {
  console.error(`[copy-webview] ${error.message}`);
  process.exitCode = 1;
});
