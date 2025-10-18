import { createHash } from "node:crypto";
import * as path from "node:path";
import * as vscode from "vscode";

function toFsPath(candidate: string): string {
  if (candidate.startsWith("file://")) {
    try {
      return vscode.Uri.parse(candidate).fsPath;
    } catch {
      // fall through and treat as plain string below
    }
  }
  return candidate;
}

function ensureSameDrive(workspacePath: string, candidatePath: string): boolean {
  if (process.platform !== "win32") {
    return true;
  }
  const workspaceRoot = path.parse(workspacePath).root.toLowerCase();
  const candidateRoot = path.parse(candidatePath).root.toLowerCase();
  return workspaceRoot === candidateRoot;
}

export function normalizeRelativePath(candidate: string | undefined, workspaceFsPath: string): string | null {
  if (typeof candidate !== "string") {
    return null;
  }

  const trimmed = candidate.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const workspaceAbsolute = path.resolve(workspaceFsPath);
  const candidateFsPath = (() => {
    const raw = toFsPath(trimmed);
    if (!path.isAbsolute(raw)) {
      return path.normalize(path.join(workspaceAbsolute, raw));
    }

    if (process.platform === "win32") {
      const hasDrivePrefix = /^[a-zA-Z]:/.test(raw);
      const startsWithSlash = /^[\\/]/.test(raw);
      if (!hasDrivePrefix && startsWithSlash) {
        const workspaceRoot = path.parse(workspaceAbsolute).root;
        if (workspaceRoot) {
          const driveRoot = workspaceRoot.replace(/[\\/]+$/, "");
          return path.normalize(`${driveRoot}${raw}`);
        }
      }
    }

    return path.normalize(raw);
  })();

  if (!ensureSameDrive(workspaceAbsolute, candidateFsPath)) {
    return null;
  }

  const relative = path.relative(workspaceAbsolute, candidateFsPath);
  if (!relative || relative === "." || path.isAbsolute(relative) || relative.startsWith("..")) {
    return null;
  }

  const segments = relative
    .split(path.sep)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0 && segment !== ".");

  if (segments.length === 0) {
    return null;
  }

  return segments.join("/");
}

export function normalizeSelectionInput(selection: unknown, workspaceFsPath: string): string[] {
  if (!Array.isArray(selection)) {
    return [];
  }

  const unique = new Set<string>();
  for (const entry of selection) {
    const normalized = normalizeRelativePath(typeof entry === "string" ? entry : undefined, workspaceFsPath);
    if (normalized) {
      unique.add(normalized);
    }
  }
  return Array.from(unique).sort((a, b) => a.localeCompare(b));
}

export function canonicalSelectionSignature(normalizedPaths: readonly string[]): string {
  const sanitized = normalizedPaths
    .filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .sort((a, b) => a.localeCompare(b));

  const hash = createHash("sha256");
  for (const value of sanitized) {
    hash.update(value, "utf8");
    hash.update("\n");
  }
  return hash.digest("hex");
}

const DEFAULT_SELECTION_SAMPLE_LIMIT = 500;

export interface SelectionMetadata {
  runId: string;
  total: number;
  mode: "explicit" | "all";
  sampled: boolean;
  transmitted: number;
  sampleLimit?: number;
  updatedAt: string;
}

export interface SelectionSnapshot extends Record<string, unknown> {
  selection?: string[];
  selectionMetadata: SelectionMetadata;
}

interface SelectionSnapshotOptions {
  mode?: "explicit" | "all";
  maxTransmit?: number;
  alreadySorted?: boolean;
  existingRunId?: string;
  totalOverride?: number;
}

export function createSelectionSnapshot(
  selection: readonly string[] | undefined,
  options: SelectionSnapshotOptions = {}
): SelectionSnapshot {
  const normalizedArray = Array.isArray(selection) ? selection : [];
  const mode = options.mode === "all" ? "all" : "explicit";
  const sortedSelection = options.alreadySorted
    ? [...normalizedArray]
    : [...normalizedArray].sort((a, b) => a.localeCompare(b));
  const total = typeof options.totalOverride === "number" && Number.isFinite(options.totalOverride)
    ? Math.max(0, Math.trunc(options.totalOverride))
    : sortedSelection.length;
  const runId = options.existingRunId && options.existingRunId.length > 0
    ? options.existingRunId
    : canonicalSelectionSignature(sortedSelection);

  const sampleLimit = Math.max(0, options.maxTransmit ?? DEFAULT_SELECTION_SAMPLE_LIMIT);

  let transmittedSelection: string[] | undefined;
  let sampled = false;

  if (sortedSelection.length > 0 && sampleLimit > 0) {
    if (sortedSelection.length > sampleLimit) {
      transmittedSelection = sortedSelection.slice(0, sampleLimit);
      sampled = true;
    } else {
      transmittedSelection = sortedSelection;
    }
  } else if (sampleLimit === 0) {
    transmittedSelection = [];
    sampled = sortedSelection.length > 0;
  }

  const metadata: SelectionMetadata = {
    runId,
    total,
    mode,
    sampled,
    transmitted: transmittedSelection?.length ?? 0,
    ...(sampleLimit > 0 ? { sampleLimit } : {}),
    updatedAt: new Date().toISOString()
  };

  const snapshot: SelectionSnapshot = {
    selectionMetadata: metadata
  };

  if (transmittedSelection && transmittedSelection.length > 0) {
    snapshot.selection = transmittedSelection;
  }

  return snapshot;
}

export {};
