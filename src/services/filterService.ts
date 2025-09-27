import * as path from 'path';
import { Minimatch } from 'minimatch';
import { GitignoreService } from './gitignoreService';

/**
 * Stateless service that filters file lists in two stages:
 * 1) Remove files ignored by git (via GitignoreService).
 * 2) Apply user include/exclude globs.
 */
export class FilterService {
  /**
   * Filter a list of absolute file paths.
   *
   * - filePaths: array of absolute file paths to filter
   * - include: list of glob patterns to include (if empty, include all)
   * - exclude: list of glob patterns to exclude
   * - gitignoreService: instance used to query VCS ignore state
   * - workspaceRoot: absolute path to workspace root; used to make paths relative
   */
  public static async filterFileList(
    filePaths: string[],
    include: string[],
    exclude: string[],
    gitignoreService: GitignoreService,
    workspaceRoot: string
  ): Promise<string[]> {
    // Stage 1: run gitignore checks concurrently
    const ignoredResults = await Promise.all(
      filePaths.map(async (fp) => {
        try {
          return await gitignoreService.isIgnored(fp);
        } catch {
          // On error, assume not ignored to avoid accidental filtering
          return false;
        }
      })
    );

    const stage1 = filePaths.filter((_, i) => !ignoredResults[i]);

    // Prepare minimatch instances for include/exclude
    const mmOptions = { dot: true } as const;

    const includeMatchers = (include || []).map((p) => new Minimatch(p, mmOptions));
    const excludeMatchers = (exclude || []).map((p) => new Minimatch(p, mmOptions));

    // Stage 2: apply include and exclude against paths relative to workspaceRoot
    const normalizedRoot = path.resolve(workspaceRoot);

    const final = stage1.filter((absPath) => {
      const rel = path.relative(normalizedRoot, path.resolve(absPath)).split(path.sep).join('/');

  // Exclude patterns must take precedence. Check excludes first.
  const excluded = excludeMatchers.some((m) => m.match(rel));
  if (excluded) return false; // a match here always wins (file is rejected)

  // Include logic: if no include patterns provided, treat as matching
  const included = includeMatchers.length === 0 || includeMatchers.some((m) => m.match(rel));
  if (!included) return false;

  return true;
    });

    return final;
  }
}
