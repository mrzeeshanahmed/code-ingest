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
  } catch (error) {
    const errno = (error as NodeJS.ErrnoException).code;
    if (errno === "ENOENT") {
      // Path doesn't exist on disk. Fall back to path.resolve + path.relative
      // for containment validation. This handles new file creation events
      // and test environments where mock paths don't correspond to real files.
      resolvedCandidate = path.resolve(workspaceRoot, candidatePath);
      try {
        resolvedWorkspace = fs.realpathSync(workspaceRoot);
      } catch (workspaceError) {
        if ((workspaceError as NodeJS.ErrnoException).code === "ENOENT") {
          // Workspace root also doesn't exist (common in test mocks).
          // Use the resolved workspace root as-is and validate containment
          // via path.relative only.
          resolvedWorkspace = path.resolve(workspaceRoot);
        } else {
          return { valid: false, reason: "Workspace root resolution failed" };
        }
      }
    } else {
      return { valid: false, reason: "Path resolution failed" };
    }
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
  } catch (error) {
    // ENOENT is expected for files that don't exist yet (new file creation events).
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return { valid: false, reason: "Path stat failed" };
    }
  }

  return { valid: true };
}
