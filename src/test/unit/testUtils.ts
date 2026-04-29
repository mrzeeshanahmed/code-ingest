import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import { performance } from "node:perf_hooks";
import * as vscode from "vscode";
import type { Mock } from "jest-mock";

export interface FileSpec {
  content?: string | Buffer;
  mode?: number;
  symlinkTo?: string;
}

export type Structure = {
  [name: string]: Structure | string | Buffer | FileSpec;
};

export interface TempWorkspaceHandle {
  root: string;
  dispose(): Promise<void>;
}

export async function createTempWorkspace(structure: Structure = {}): Promise<TempWorkspaceHandle> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "code-ingest-test-"));
  await materializeStructure(root, structure);
  return {
    root,
    dispose: async () => {
      await fs.rm(root, { recursive: true, force: true });
    }
  };
}

export async function materializeStructure(root: string, structure: Structure): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  const entries = Object.entries(structure);
  for (const [name, value] of entries) {
    const target = path.join(root, name);
    if (typeof value === "string" || value instanceof Buffer) {
      await fs.writeFile(target, toWritePayload(value));
      continue;
    }

    if (isFileSpec(value)) {
      if (value.symlinkTo) {
        await fs.symlink(value.symlinkTo, target);
        continue;
      }
      const payload = value.content ?? "";
      await fs.writeFile(target, toWritePayload(payload));
      if (typeof value.mode === "number") {
        await fs.chmod(target, value.mode);
      }
      continue;
    }

    if (isStructure(value)) {
      await materializeStructure(target, value);
      continue;
    }

    throw new TypeError(`Unsupported structure entry for ${name}`);
  }
}

function isFileSpec(value: unknown): value is FileSpec {
  if (typeof value !== "object" || value === null || Buffer.isBuffer(value) || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return "content" in candidate || "mode" in candidate || "symlinkTo" in candidate;
}

function isStructure(value: unknown): value is Structure {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  if (Buffer.isBuffer(value) || Array.isArray(value)) {
    return false;
  }
  if (isFileSpec(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return Object.values(candidate).every((entry) => {
    return (
      typeof entry === "string" ||
      Buffer.isBuffer(entry) ||
      isFileSpec(entry) ||
      isStructure(entry)
    );
  });
}

function toWritePayload(value: string | Buffer): string | NodeJS.ArrayBufferView {
  return typeof value === "string" ? value : (value as unknown as NodeJS.ArrayBufferView);
}

export function createCancellationTokenSource(): vscode.CancellationTokenSource {
  return new vscode.CancellationTokenSource();
}

export function captureEvents<T>(register: (listener: (event: T) => void) => vscode.Disposable) {
  const events: T[] = [];
  const disposable = register((event) => {
    events.push(event);
  });
  return {
    events,
    dispose: () => disposable.dispose()
  };
}

export interface PerformanceResult {
  durationMs: number;
  iterations: number;
}

export async function measurePerformance(iterations: number, task: () => Promise<void>): Promise<PerformanceResult> {
  const start = performance.now();
  for (let index = 0; index < iterations; index += 1) {
    await task();
  }
  const durationMs = performance.now() - start;
  return { durationMs, iterations };
}

export async function withTempWorkspace<T>(structure: Structure, fn: (root: string) => Promise<T>): Promise<T> {
  const workspace = await createTempWorkspace(structure);
  try {
    return await fn(workspace.root);
  } finally {
    await workspace.dispose();
  }
}

export async function readDirectoryRecursive(root: string): Promise<string[]> {
  const results: string[] = [];
  async function walk(current: string) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else {
        results.push(fullPath);
      }
    }
  }
  await walk(root);
  return results;
}

export function setWorkspaceFolder(root: string): void {
  const folder: vscode.WorkspaceFolder = {
    index: 0,
    name: path.basename(root),
    uri: vscode.Uri.file(root)
  };
  (vscode.workspace as unknown as { workspaceFolders: vscode.WorkspaceFolder[] }).workspaceFolders = [folder];
  const getWorkspaceFolder = vscode.workspace.getWorkspaceFolder as unknown as Mock<(uri: vscode.Uri) => vscode.WorkspaceFolder | undefined>;
  getWorkspaceFolder.mockReturnValue(folder);
}