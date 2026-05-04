import * as fs from "node:fs";
import * as path from "node:path";

export interface PathValidationResult {
  valid: boolean;
  reason?: string;
}

export function validateWorkspacePath(
  workspaceRoot: string,
  candidatePath: string
): PathValidationResult {
  // Reject empty paths.
  if (!candidatePath || candidatePath.trim().length === 0) {
    return { valid: false, reason: "Empty path" };
  }

  // Reject URI-encoded escapes.
  if (/%[0-9a-fA-F]{2}/u.test(candidatePath)) {
    return { valid: false, reason: "URI-encoded escapes not allowed" };
  }

  // Reject UNC paths.
  if (candidatePath.startsWith("\\\\")) {
    return { valid: false, reason: "UNC paths not allowed" };
  }

  // Reject absolute drive paths outside workspace.
  if (path.isAbsolute(candidatePath)) {
    const normalizedCandidate = path.normalize(candidatePath);
    const normalizedWorkspace = path.normalize(workspaceRoot);
    const rel = path.relative(normalizedWorkspace, normalizedCandidate);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      return { valid: false, reason: "Absolute path outside workspace" };
    }
  }

  // Resolve and canonicalize.
  let resolvedCandidate: string;
  let resolvedWorkspace: string;
  try {
    resolvedCandidate = fs.realpathSync(path.resolve(workspaceRoot, candidatePath));
    resolvedWorkspace = fs.realpathSync(workspaceRoot);
  } catch {
    return { valid: false, reason: "Path resolution failed" };
  }

  // Check containment.
  const rel = path.relative(resolvedWorkspace, resolvedCandidate);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return { valid: false, reason: "Path traversal detected" };
  }

  // Check for symlinks (if realpath resolved differently, it might be a symlink).
  try {
    const lstat = fs.lstatSync(path.resolve(workspaceRoot, candidatePath));
    if (lstat.isSymbolicLink()) {
      return { valid: false, reason: "Symlinks not allowed" };
    }
  } catch {
    // File may not exist; that's okay for validation.
  }

  return { valid: true };
}
