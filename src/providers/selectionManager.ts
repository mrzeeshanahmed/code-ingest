import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

import { minimatch } from "minimatch";

import type { FilterService } from "../services/filterService";
import type { FileScanner, FileNode } from "../services/fileScanner";

const URI_SCHEME_PATTERN = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

interface KnownEntryMetadata {
  relPath: string;
  type: FileNode["type"];
}

interface SelectionEntry {
  key: string;
  uri: vscode.Uri;
  relPath: string;
}

export interface SelectionState {
  workspaceRoot: string;
  selectedFiles: Set<string>;
  previewFiles: Set<string>;
  excludedFiles: Set<string>;
  lastModified: Date;
}

export type SelectionChangeSource = "user" | "command" | "restore" | "pattern";

export interface SelectionChangeEvent {
  type: "added" | "removed" | "cleared" | "inverted" | "restored";
  files: string[];
  relativeFiles: string[];
  selected: string[];
  selectedRelative: string[];
  source: SelectionChangeSource;
}

export interface SelectionManagerOptions {
  workspaceRoot: string;
  storage: vscode.Memento;
  fileScanner?: Pick<FileScanner, "scan">;
  filterService?: Pick<FilterService, "validatePattern">;
  validatePathExists?: (absolute: string) => boolean;
  maxSelection?: number;
  selectionWarningThreshold?: number;
  autoSaveDebounceMs?: number;
  onStateApplied?: (state: SelectionState) => void;
}

interface StoredSelectionState {
  workspaceRoot: string;
  selected: string[];
  preview: string[];
  excluded: string[];
  lastModified: string;
}

const DEFAULT_MAX_SELECTION = 10_000;
const DEFAULT_WARNING_THRESHOLD = 5_000;
const DEFAULT_SAVE_DEBOUNCE = 500;

function toUri(input: string, workspaceRoot: string): vscode.Uri {
  if (URI_SCHEME_PATTERN.test(input)) {
    return vscode.Uri.parse(input);
  }
  const normalized = input === "." ? "" : input;
  const fsPath = path.isAbsolute(normalized) ? normalized : path.join(workspaceRoot, normalized);
  return vscode.Uri.file(fsPath);
}

function toKey(uri: vscode.Uri): string {
  return uri.toString();
}

function toRelative(uri: vscode.Uri, workspaceRoot: string): string {
  if (uri.scheme !== "file") {
    return uri.toString();
  }
  const relative = path.relative(workspaceRoot, uri.fsPath);
  const normalized = relative === "" ? "." : relative;
  return normalized.split(path.sep).join("/");
}

export class SelectionManager implements vscode.Disposable {
  private readonly workspaceRoot: string;
  private readonly storage: vscode.Memento;
  private readonly fileScanner: Pick<FileScanner, "scan"> | undefined;
  private readonly filterService: Pick<FilterService, "validatePattern"> | undefined;
  private readonly validatePathExists: (absolute: string) => boolean;
  private readonly maxSelection: number;
  private readonly warningThreshold: number;
  private readonly saveDebounce: number;
  private readonly onStateApplied: ((state: SelectionState) => void) | undefined;

  private readonly storageKey: string;
  private readonly selected = new Set<string>();
  private readonly preview = new Set<string>();
  private readonly excluded = new Set<string>();
  private readonly knownEntries = new Map<string, KnownEntryMetadata>();
  private lastModified = new Date();
  private saveTimer: NodeJS.Timeout | undefined;
  private disposed = false;

  private readonly onDidChangeSelectionEmitter = new vscode.EventEmitter<SelectionChangeEvent>();
  private readonly onDidChangePreviewEmitter = new vscode.EventEmitter<string[]>();

  readonly onDidChangeSelection: vscode.Event<SelectionChangeEvent> = this.onDidChangeSelectionEmitter.event;
  readonly onDidChangePreview: vscode.Event<string[]> = this.onDidChangePreviewEmitter.event;

  constructor(options: SelectionManagerOptions) {
    this.workspaceRoot = options.workspaceRoot;
    this.storage = options.storage;
    this.fileScanner = options.fileScanner;
    this.filterService = options.filterService;
    this.validatePathExists = options.validatePathExists ?? ((absolute: string) => {
      try {
        return fs.existsSync(absolute);
      } catch {
        return false;
      }
    });
    this.maxSelection = options.maxSelection ?? DEFAULT_MAX_SELECTION;
    this.warningThreshold = options.selectionWarningThreshold ?? DEFAULT_WARNING_THRESHOLD;
    this.saveDebounce = options.autoSaveDebounceMs ?? DEFAULT_SAVE_DEBOUNCE;
    this.onStateApplied = options.onStateApplied;

    const rootKey = Buffer.from(options.workspaceRoot).toString("base64url");
    this.storageKey = `code-ingest.selection.${rootKey}`;

    void this.initializeFromStorage();
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    void this.saveState();
    this.onDidChangeSelectionEmitter.dispose();
    this.onDidChangePreviewEmitter.dispose();
  }

  isSelected(target: string): boolean {
    const key = this.toKey(target);
    return this.selected.has(key);
  }

  isPreviewed(target: string): boolean {
    const key = this.toKey(target);
    return this.preview.has(key);
  }

  getSelectedUris(): string[] {
    return [...this.selected].sort();
  }

  getSelectedRelativePaths(): string[] {
    return this.getSelectedUris().map((uri) => this.getRelativeFromKey(uri));
  }

  getPreviewUris(): string[] {
    return [...this.preview].sort();
  }

  getExcludedUris(): string[] {
    return [...this.excluded].sort();
  }

  selectFile(target: string, source: SelectionChangeSource = "user"): void {
    const entry = this.ensureSelectable(target);
    if (!entry || this.selected.has(entry.key)) {
      return;
    }
    if (!this.tryAddSelection(entry.key)) {
      return;
    }
    this.emitChange("added", [entry.key], source);
  }

  deselectFile(target: string, source: SelectionChangeSource = "user"): void {
    const key = this.toKey(target);
    if (!this.selected.delete(key)) {
      return;
    }
    this.emitChange("removed", [key], source);
  }

  toggleFile(target: string, source: SelectionChangeSource = "user"): void {
    if (this.isSelected(target)) {
      this.deselectFile(target, source);
    } else {
      this.selectFile(target, source);
    }
  }

  selectMany(targets: string[], source: SelectionChangeSource = "command"): void {
    const additions: string[] = [];
    for (const target of targets) {
      const entry = this.ensureSelectable(target);
      if (!entry || this.selected.has(entry.key)) {
        continue;
      }
      if (!this.tryAddSelection(entry.key)) {
        break;
      }
      additions.push(entry.key);
    }
    if (additions.length > 0) {
      this.emitChange("added", additions, source);
    }
  }

  invertSelection(targets: string[], source: SelectionChangeSource = "command"): void {
    const additions: string[] = [];
    const removals: string[] = [];
    for (const target of targets) {
      const key = this.toKey(target);
      if (this.selected.has(key)) {
        this.selected.delete(key);
        removals.push(key);
      } else {
        const entry = this.ensureSelectable(target);
        if (!entry) {
          continue;
        }
        if (!this.tryAddSelection(entry.key)) {
          break;
        }
        additions.push(entry.key);
      }
    }
    if (additions.length === 0 && removals.length === 0) {
      return;
    }
    this.emitChange("inverted", [...additions, ...removals], source);
  }

  selectAllFromKnown(source: SelectionChangeSource = "command"): void {
    const entries = [...this.knownEntries.entries()].filter(([, meta]) => meta.type === "file");
    this.selectMany(entries.map(([key]) => key), source);
  }

  clearSelection(source: SelectionChangeSource = "command"): void {
    if (this.selected.size === 0) {
      return;
    }
    const removed = [...this.selected];
    this.selected.clear();
    this.emitChange("cleared", removed, source);
  }

  async selectPattern(pattern: string, mode: "glob" | "regex", source: SelectionChangeSource = "pattern"): Promise<void> {
    const candidates = await this.resolveCandidateFiles();
    if (candidates.length === 0) {
      return;
    }

    if (mode === "glob" && this.filterService) {
      const validation = this.filterService.validatePattern(pattern);
      if (!validation.ok) {
        void vscode.window.showErrorMessage(`Invalid glob pattern: ${validation.reason ?? "unknown"}`);
        return;
      }
    }

    let matcher: (relPath: string) => boolean;
    if (mode === "glob") {
      matcher = (relPath: string) => minimatch(relPath, pattern, { dot: true });
    } else {
      let regex: RegExp;
      try {
        regex = new RegExp(pattern);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(`Invalid regular expression: ${message}`);
        return;
      }
      matcher = (relPath: string) => regex.test(relPath);
    }

    const additions: string[] = [];
    for (const candidate of candidates) {
      if (!matcher(candidate.relPath)) {
        continue;
      }
      if (this.selected.has(candidate.key)) {
        continue;
      }
      if (!this.tryAddSelection(candidate.key)) {
        break;
      }
      additions.push(candidate.key);
    }

    if (additions.length === 0) {
      return;
    }
    this.emitChange("added", additions, source);
  }

  selectByType(types: FileNode["type"][], source: SelectionChangeSource = "command"): void {
    if (types.length === 0) {
      return;
    }
    const allowed = new Set(types);
    const additions: string[] = [];
    for (const [key, meta] of this.knownEntries.entries()) {
      if (!allowed.has(meta.type) || meta.type !== "file") {
        continue;
      }
      if (this.selected.has(key)) {
        continue;
      }
      if (!this.tryAddSelection(key)) {
        break;
      }
      additions.push(key);
    }
    if (additions.length > 0) {
      this.emitChange("added", additions, source);
    }
  }

  setPreview(files: string[], source: SelectionChangeSource = "command"): void {
    const normalized = new Set(files.map((file) => this.toKey(file)));
    const changed = this.symmetricDiff(this.preview, normalized);
    this.preview.clear();
    normalized.forEach((key) => this.preview.add(key));
    if (changed.size > 0) {
      this.onDidChangePreviewEmitter.fire(this.getPreviewUris());
      this.scheduleSave();
    }
    this.maybeNotifyPreview(source);
  }

  clearPreview(source: SelectionChangeSource = "command"): void {
    if (this.preview.size === 0) {
      return;
    }
    this.preview.clear();
    this.onDidChangePreviewEmitter.fire([]);
    this.scheduleSave();
    this.maybeNotifyPreview(source);
  }

  addExcluded(target: string): void {
    const key = this.toKey(target);
    if (this.excluded.has(key)) {
      return;
    }
    this.excluded.add(key);
    if (this.selected.delete(key)) {
      this.emitChange("removed", [key], "command");
    } else {
      this.scheduleSave();
    }
  }

  removeExcluded(target: string): void {
    const key = this.toKey(target);
    if (!this.excluded.delete(key)) {
      return;
    }
    this.scheduleSave();
  }

  registerEntries(entries: Iterable<FileNode>): void {
    for (const entry of entries) {
      const uri = vscode.Uri.parse(entry.uri);
      const key = toKey(uri);
      const relPath = entry.relPath ?? toRelative(uri, this.workspaceRoot);
      this.knownEntries.set(key, { relPath, type: entry.type });
    }
  }

  removeEntries(targets: Iterable<string>): void {
    const removed: string[] = [];
    for (const target of targets) {
      const key = this.toKey(target);
      this.knownEntries.delete(key);
      if (this.selected.delete(key)) {
        removed.push(key);
      }
      this.preview.delete(key);
      this.excluded.delete(key);
    }
    if (removed.length > 0) {
      this.emitChange("removed", removed, "command");
    } else {
      this.scheduleSave();
    }
  }

  handleDeletions(targets: Iterable<string>): void {
    this.removeEntries(targets);
  }

  getStateSnapshot(): SelectionState {
    return {
      workspaceRoot: this.workspaceRoot,
      selectedFiles: new Set(this.selected),
      previewFiles: new Set(this.preview),
      excludedFiles: new Set(this.excluded),
      lastModified: new Date(this.lastModified)
    };
  }

  async saveState(): Promise<void> {
    if (this.disposed) {
      return;
    }
    const stored: StoredSelectionState = {
      workspaceRoot: this.workspaceRoot,
      selected: this.serializeSet(this.selected),
      preview: this.serializeSet(this.preview),
      excluded: this.serializeSet(this.excluded),
      lastModified: this.lastModified.toISOString()
    };
    await this.storage.update(this.storageKey, stored);
  }

  async loadState(): Promise<SelectionState | null> {
    const stored = this.storage.get<StoredSelectionState | undefined>(this.storageKey);
    if (!stored || stored.workspaceRoot !== this.workspaceRoot) {
      return null;
    }
    return {
      workspaceRoot: stored.workspaceRoot,
      selectedFiles: new Set(stored.selected.map((rel) => this.toKey(rel))),
      previewFiles: new Set(stored.preview.map((rel) => this.toKey(rel))),
      excludedFiles: new Set(stored.excluded.map((rel) => this.toKey(rel))),
      lastModified: new Date(stored.lastModified)
    };
  }

  private async initializeFromStorage(): Promise<void> {
    const snapshot = await this.loadState();
    if (!snapshot) {
      return;
    }
    this.selected.clear();
    snapshot.selectedFiles.forEach((file) => this.selected.add(file));
    this.preview.clear();
    snapshot.previewFiles.forEach((file) => this.preview.add(file));
    this.excluded.clear();
    snapshot.excludedFiles.forEach((file) => this.excluded.add(file));
    this.lastModified = snapshot.lastModified;
    this.emitChange("restored", [...this.selected], "restore", {
      scheduleSave: false,
      updateTimestamp: false
    });
    if (this.preview.size > 0) {
      this.onDidChangePreviewEmitter.fire(this.getPreviewUris());
    }
    this.onStateApplied?.(this.getStateSnapshot());
  }

  private ensureSelectable(target: string): SelectionEntry | undefined {
    const uri = toUri(target, this.workspaceRoot);
    if (uri.scheme === "file") {
      const absolute = uri.fsPath;
      if (!this.validatePathExists(absolute)) {
        void vscode.window.showWarningMessage(`"${target}" no longer exists and was removed from selection.`);
        this.removeEntries([uri.toString()]);
        return undefined;
      }
    }
    const key = toKey(uri);
    if (this.excluded.has(key)) {
      return undefined;
    }
    const relPath = this.getRelativeFromKey(key, uri);
    return { key, uri, relPath };
  }

  private tryAddSelection(key: string): boolean {
    if (this.selected.size >= this.maxSelection) {
      void vscode.window.showWarningMessage(
        `Selection limit of ${this.maxSelection} items reached. Adjust settings to increase the limit.`
      );
      return false;
    }
    this.selected.add(key);
    if (this.selected.size >= this.warningThreshold) {
      void vscode.window.showWarningMessage(
        `You currently have ${this.selected.size} items selected. Large selections may impact performance.`
      );
    }
    return true;
  }

  private emitChange(
    type: SelectionChangeEvent["type"],
    files: string[],
    source: SelectionChangeSource,
    options: { scheduleSave?: boolean; updateTimestamp?: boolean } = {}
  ): void {
    if (files.length === 0) {
      return;
    }
    const shouldUpdateTimestamp = options.updateTimestamp ?? true;
    if (shouldUpdateTimestamp) {
      this.lastModified = new Date();
    }
    const relatives = files.map((key) => this.getRelativeFromKey(key));
    const selectedUris = this.getSelectedUris();
    const selectedRelative = selectedUris.map((key) => this.getRelativeFromKey(key));
    this.onDidChangeSelectionEmitter.fire({
      type,
      files,
      relativeFiles: relatives,
      selected: selectedUris,
      selectedRelative,
      source
    });
    const scheduleSave = options.scheduleSave ?? true;
    if (scheduleSave) {
      this.scheduleSave();
    }
    this.onStateApplied?.(this.getStateSnapshot());
  }

  private scheduleSave(): void {
    if (this.disposed) {
      return;
    }
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      void this.saveState();
    }, this.saveDebounce);
  }

  private symmetricDiff(a: Set<string>, b: Set<string>): Set<string> {
    const diff = new Set<string>();
    for (const value of a) {
      if (!b.has(value)) {
        diff.add(value);
      }
    }
    for (const value of b) {
      if (!a.has(value)) {
        diff.add(value);
      }
    }
    return diff;
  }

  private maybeNotifyPreview(_source: SelectionChangeSource): void {
    void _source;
    this.scheduleSave();
  }

  private serializeSet(values: Set<string>): string[] {
    return [...values].map((key) => this.getRelativeFromKey(key));
  }

  private toKey(target: string): string {
    const uri = toUri(target, this.workspaceRoot);
    return toKey(uri);
  }

  private getRelativeFromKey(key: string, uri?: vscode.Uri): string {
    const known = this.knownEntries.get(key);
    if (known) {
      return known.relPath;
    }
    try {
      const resolved = uri ?? vscode.Uri.parse(key);
      return toRelative(resolved, this.workspaceRoot);
    } catch {
      return key;
    }
  }

  private async resolveCandidateFiles(): Promise<SelectionEntry[]> {
    const existing = [...this.knownEntries.entries()]
      .filter(([, meta]) => meta.type === "file")
      .map(([key, meta]) => ({ key, uri: vscode.Uri.parse(key), relPath: meta.relPath }));
    if (existing.length > 0) {
      return existing;
    }
    if (!this.fileScanner) {
      return [];
    }
    const nodes = await this.fileScanner.scan({ maxEntries: this.maxSelection * 2 });
    const candidates: SelectionEntry[] = [];
    for (const node of nodes) {
      const uri = vscode.Uri.parse(node.uri);
      const key = toKey(uri);
      const relPath = node.relPath ?? toRelative(uri, this.workspaceRoot);
      this.knownEntries.set(key, { relPath, type: node.type });
      if (node.type === "file") {
        candidates.push({ key, uri, relPath });
      }
    }
    return candidates;
  }
}
