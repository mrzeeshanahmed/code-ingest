import * as path from 'path';
import { promises as fs } from 'fs';
import { Minimatch } from 'minimatch';

/**
 * A function that returns true when a given file path should be ignored,
 * false when explicitly un-ignored, and null when no pattern matches.
 */
export type PathMatcher = (filePath: string) => boolean | null;

/**
 * Service responsible for loading and caching `.gitignore` matchers. This
 * implementation minimizes filesystem access by caching compiled matchers per
 * directory and applying .gitignore precedence correctly (parent -> child).
 */
export class GitignoreService {
  private readonly matchersByDir: Map<string, PathMatcher> = new Map();

  constructor() {}

  /**
   * Search upwards from `startDir` collecting `.gitignore` file paths. Stops
   * when a `.git` directory is found (repo root) or the filesystem root is
   * reached. Returned array is ordered from root -> closest (parent to child)
   * so callers can apply rules in increasing specificity.
   */
  private async findGitignoreFiles(startDir: string): Promise<string[]> {
    const files: string[] = [];
    let dir = path.resolve(startDir);

    while (true) {
      const gitignorePath = path.join(dir, '.gitignore');
      try {
        const stat = await fs.stat(gitignorePath).catch(() => null);
        if (stat && stat.isFile()) files.push(gitignorePath);
      } catch {
        // ignore IO errors for individual checks
      }

      // stop if we've reached a repo root marker
      try {
        const gitDir = path.join(dir, '.git');
        const gitStat = await fs.stat(gitDir).catch(() => null);
        if (gitStat && (gitStat.isDirectory() || gitStat.isFile())) break;
      } catch {
        // ignore
      }

      const parent = path.dirname(dir);
      if (parent === dir) break; // reached filesystem root
      dir = parent;
    }

    // files collected are from child->parent; reverse to parent->child
    return files.reverse();
  }

  /**
   * Read and compile a `.gitignore` into a PathMatcher. Uses cache aggressively
   * to avoid repeated parsing. The matcher returns `true` for ignore, `false`
   * for explicit un-ignore (negation), and `null` when no pattern matches.
   */
  private async getMatcher(gitignorePath: string): Promise<PathMatcher> {
    const dir = path.dirname(gitignorePath);
    const cached = this.matchersByDir.get(dir);
    if (cached) return cached;

    // Read file
    let content: string;
    try {
      content = await fs.readFile(gitignorePath, 'utf8');
    } catch {
      // On read errors, cache a matcher that never matches to avoid repeated IO
      const noop: PathMatcher = () => null;
      this.matchersByDir.set(dir, noop);
      return noop;
    }

    const lines = content.split(/\r?\n/);
    type Pattern = { raw: string; negated: boolean; pattern: string };
    const patterns: Pattern[] = [];

    for (let raw of lines) {
      raw = raw.trim();
      if (!raw || raw.startsWith('#')) continue; // skip empty/comment

      let negated = false;
      if (raw.startsWith('!')) {
        negated = true;
        raw = raw.slice(1);
      }

      if (!raw) continue; // lone !

      // gitignore directory-relative patterns: keep as-is for matching
      patterns.push({ raw: raw, negated, pattern: raw });
    }

    const matcher: PathMatcher = (filePath: string) => {
      // compute path relative to gitignore directory
      let rel = path.relative(dir, filePath);
      // Normalize to posix-style for minimatch
      rel = rel.split(path.sep).join('/');

      let lastMatch: boolean | null = null;

      for (const p of patterns) {
        let pat = p.pattern;

        // If pattern starts with '/', treat it as anchored to the gitignore dir
        if (pat.startsWith('/')) pat = pat.slice(1);

        // If pattern ends with '/', it matches directories; convert to glob
        if (pat.endsWith('/')) pat = pat + '**';

  type MMOpts = { dot?: boolean; nocase?: boolean; matchBase?: boolean };
  const opts: MMOpts = { dot: true, nocase: false };
        const usesMatchBase = pat.indexOf('/') === -1;
  if (usesMatchBase) opts.matchBase = true;

        try {
          const m = new Minimatch(pat, opts as MMOpts);
          if (m.match(rel)) {
            lastMatch = p.negated ? false : true;
          }
        } catch {
          // ignore pattern parsing errors and continue
        }
      }

      return lastMatch;
    };

    this.matchersByDir.set(dir, matcher);
    return matcher;
  }

  /**
   * Public API: determine whether `filePath` should be ignored. This method
   * collects all applicable .gitignore files (parent -> child), evaluates
   * patterns in order, and returns the final decision. Negations in more
   * specific .gitignore files can override ignores from parent files.
   */
  public async isIgnored(filePath: string): Promise<boolean> {
    const startDir = path.dirname(path.resolve(filePath));
    const gitignoreFiles = await this.findGitignoreFiles(startDir);

    // If no gitignore files found, nothing is ignored
    if (gitignoreFiles.length === 0) return false;

    let decision: boolean | null = null;

    // Evaluate matchers in order parent -> child so that child rules override
    for (const gi of gitignoreFiles) {
      const matcher = await this.getMatcher(gi);
      const result = matcher(filePath);
      if (result !== null) decision = result;
    }

    return decision === true;
  }

  public clearCache(): void {
    this.matchersByDir.clear();
  }

  public preloadDir(dir: string, matcher: PathMatcher): void {
    this.matchersByDir.set(dir, matcher);
  }
}
