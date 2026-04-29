# Code-Ingest — Phased Implementation Plan

**Version:** 1.2.4 — Architecture Hardened
**Status:** Ready for Implementation
**Companion Document:** [prd.md](prd.md)

> **How to use this plan:** Finish each phase, including its checkpoint, before starting the next. This plan is intentionally implementation-oriented and targets the current merged extension repository in this workspace. References to `code-ingest-demo-master` and `code-digest-main` are historical source ancestry only, not required sibling folders in the active workspace. The goal is to keep the extension host responsive, the graph trustworthy, and the user-facing behavior consistent with the PRD.

---

## Table of Contents

- [Phase 0: Workspace and Source Verification](#phase-0-workspace-and-source-verification)
- [Phase 1: Dependency Reset and Scaffold Cleanup](#phase-1-dependency-reset-and-scaffold-cleanup)
- [Phase 2: WASM SQLite Storage Layer](#phase-2-wasm-sqlite-storage-layer)
- [Phase 3: Tree-Sitter Ingestion Pipeline](#phase-3-tree-sitter-ingestion-pipeline)
- [Phase 4: Trust-Gated Bootstrap and Reconciliation](#phase-4-trust-gated-bootstrap-and-reconciliation)
- [Phase 5: Relevance Walking, Token Budgeting, and Prompt Safety](#phase-5-relevance-walking-token-budgeting-and-prompt-safety)
- [Phase 6: Semantic Worker and JIT Knowledge](#phase-6-semantic-worker-and-jit-knowledge)
- [Phase 7: Copilot Chat Participant](#phase-7-copilot-chat-participant)
- [Phase 8: Canvas and Worker Graph View](#phase-8-canvas-and-worker-graph-view)
- [Phase 9: Sidebar, Settings, and Root-Aware Commands](#phase-9-sidebar-settings-and-root-aware-commands)
- [Phase 10: Preview-First Export Governance](#phase-10-preview-first-export-governance)
- [Phase 11: Security and Compliance Hardening](#phase-11-security-and-compliance-hardening)
- [Phase 12: Testing, Packaging, and Release](#phase-12-testing-packaging-and-release)
- [Appendix A: Key Modules](#appendix-a-key-modules)
- [Appendix B: Gap Traceability Summary](#appendix-b-gap-traceability-summary)

---

## Phase 0: Workspace and Source Verification

**Goal:** Confirm the workspace contains the primary codebase and that implementation work targets the correct surface.

### Step 0.1 — Confirm Repository Roles

- The current repository root is the primary extension codebase.
- `code-ingest-demo-master` and `code-digest-main` are historical source references only when those materials are available.
- Work only inside the current extension tree; do not assume sibling repositories must exist.

### Step 0.2 — Verify Required Source Areas Exist

At minimum, confirm the presence of:

- `src/extension.ts`
- `src/services/fileScanner.ts`
- `src/services/filterService.ts`
- `src/services/digestGenerator.ts`
- `src/providers/webviewHelpers.ts`
- `resources/webview/`
- `scripts/copyWebviewResources.js`

### Step 0.3 — Record the Architecture Pivot Before Coding

Before implementation starts, make sure the team is aligned on the v1 direction now reflected in the PRD:

- WASM SQLite storage
- Tree-sitter extraction
- worker-backed semantic retrieval
- PPR-style relevance ranking
- model-aware token counting
- Canvas plus worker graph rendering
- JIT knowledge synthesis only
- mandatory raw export policy gate

### ✅ Checkpoint 0

- [ ] Primary extension codebase verified
- [ ] Any historical reference codebase treated as read-only when present
- [ ] PRD and phased plan both point to the same v1 architecture

---

## Phase 1: Dependency Reset and Scaffold Cleanup

**Goal:** Remove stale implementation assumptions and prepare the project structure for the new architecture.

### Step 1.1 — Remove Obsolete Runtime Assumptions

Delete or stop planning around any native database, heuristic token counting, or DOM-heavy graph renderer paths. The v1 implementation path must not depend on platform-specific SQLite bindings or whitespace-based token estimators.

### Step 1.2 — Install the New Runtime Dependencies

Recommended dependency set:

```bash
npm install wa-sqlite web-tree-sitter hnswlib-wasm @vscode/prompt-tsx
npm install ignore minimatch
```

Use an Asyncify-enabled `wa-sqlite` build path. A synchronous WASM SQLite build that assumes blocking file I/O is not compatible with the required storage bridge and is out of scope for v1.

Keep existing base dependencies that still serve digest generation, testing, and standard extension bootstrapping.

### Step 1.3 — Create the New Directory Layout

```bash
mkdir -p src/graph/database
mkdir -p src/graph/indexer
mkdir -p src/graph/semantic
mkdir -p src/graph/traversal
mkdir -p src/graph/models
mkdir -p src/services/security
mkdir -p resources/webview/graph
mkdir -p resources/webview/sidebar
mkdir -p resources/webview/settings
mkdir -p scripts
```

### Step 1.4 — Add WASM Asset Build Support

Extend `scripts/copyWebviewResources.js` or add `scripts/buildWasmAssets.js` so the build moves these assets into `out/`:

- graph webview HTML/CSS/JS
- graph worker bundle
- Tree-sitter WASM grammars
- any WASM SQLite runtime asset

The bundler configuration must explicitly treat `.wasm` files as emitted static assets rather than relying on fragile relative runtime imports. The required outcome is a stable packaged layout such as:

- `out/grammars/*.wasm`
- `out/wasm/*.wasm`
- a manifest that maps logical grammar names to packaged asset paths

Both extension-host code and worker code must resolve grammar assets from packaged URIs derived from `context.extensionUri`, not from source-relative paths.

Do not bundle every Tree-sitter grammar in v1. Ship a curated minimal grammar set first, with TypeScript/JavaScript as the default packaged baseline. Any additional grammars must be lazy-loaded or explicitly deferred so the VSIX remains under budget.

### Step 1.4a — Extend `constants.ts`

Extend `src/config/constants.ts` before storage and retrieval work begins.

Required defaults:

- `VFS_DRAIN_TIMEOUT_MS = 5000`
- `KNOWLEDGE_MAX_CONCURRENT_SYNTHESIZES = 2`
- `HNSW_COMPACTION_DOC_THRESHOLD = 5000`
- `HNSW_COMPACTION_STALENESS_RATIO = 0.3`

Later phases must reference these constants rather than re-introducing inline numeric defaults.

### Step 1.5 — Define the Grammar Asset Resolver Contract

Create a clear asset-resolution contract before parser work starts.

Minimum requirements:

- resolve grammar URIs from `vscode.Uri.joinPath(context.extensionUri, 'out', 'grammars', '<grammar>.wasm')`
- expose a worker-safe representation of that path or URI
- fail fast with a typed error if a required grammar asset is missing from the packaged extension

### Step 1.5a — Implement `GrammarAssetResolver`

Create `src/graph/indexer/GrammarAssetResolver.ts` before parser work begins.

It must:

- accept `context.extensionUri`
- expose `resolve(languageId: string): string | undefined`
- throw `GrammarNotFoundError` when a required packaged grammar is missing
- include path-resolution tests and grammar bundle validation before Phase 3 begins

### Step 1.6 — Extend `.gitignore`

Add:

```gitignore
.vscode/code-ingest/
```

### ✅ Checkpoint 1

- [ ] New dependencies installed
- [ ] Asyncify-capable WASM SQLite runtime path selected
- [ ] Obsolete native/runtime assumptions removed from the plan of record
- [ ] WASM and worker asset copy/build path defined
- [ ] Grammar assets resolve from packaged extension output, not relative source paths
- [ ] `.vscode/code-ingest/` ignored in git

---

## Phase 2: WASM SQLite Storage Layer

**Goal:** Implement a per-root storage runtime that is cross-platform, VFS-backed, and safe under a single-writer discipline.

### Step 2.1 — Create the Schema Module

Create `src/graph/database/schema.ts` with the normative tables from the PRD:

- `nodes`
- `edges`
- `code_chunks`
- `comment_chunks`
- `knowledge_chunks`
- `knowledge_links`
- `terms`
- `term_links`
- `module_summaries`
- `directory_state`
- `index_state`
- `embedding_document_metadata`
- `artifact_state`

Use explicit `ON DELETE CASCADE` foreign keys for all chunk and edge relationships.

The schema must also include:

- `lineage` columns on `code_chunks` and `comment_chunks`
- `pii_detected` and `pii_redacted_summary` on `knowledge_chunks`
- semantic metadata only in `embedding_document_metadata`; vectors remain in HNSW sidecars

### Step 2.2 — Standardize ID Generation Contracts

Create helpers that use the exact delimiter contract required by the PRD:

```typescript
export function generateNodeId(workspaceRoot: string, relativePath: string, symbolName = ''): string {
  return sha256(`${workspaceRoot}::${relativePath}::${symbolName}`);
}

export function generateEdgeId(sourceId: string, targetId: string, type: string): string {
  return sha256(`${sourceId}::${targetId}::${type}`);
}

export function generateChunkId(fileNodeId: string, startLine: number, endLine: number): string {
  return sha256(`${fileNodeId}::${startLine}::${endLine}`);
}
```

No alternate delimiter may be used anywhere in the codebase.

For file-level nodes, `symbolName` MUST be `''` rather than `undefined` or `null`, so the trailing delimiter remains part of the hash input.

### Step 2.3 — Implement the Graph Database Wrapper

Create `src/graph/database/GraphDatabase.ts` as a wrapper around the chosen WASM SQLite runtime.

The existing native `GraphDatabase.ts` is a complete throwaway. Do not refactor it. Reimplement the storage layer from scratch over `wa-sqlite` plus `VscodeAsyncVfs`.

Mandatory behavior:

- open one DB per trusted workspace root
- use an Asyncify-compatible `wa-sqlite/src/VFS.js` bridge over Node's built-in `fs` module
- implement pager I/O with descriptor-based random-access operations such as `fs.open`, `fs.read`, and `fs.write`
- bypass `vscode.workspace.fs` for the SQLite `.db` file because it cannot satisfy offset-based partial writes
- fail fast if the runtime resolves to a non-Asyncify SQLite build
- initialize the WASM module once through a shared singleton promise and await it from every root runtime
- set `PRAGMA foreign_keys = ON`
- enable WAL when the runtime supports it; otherwise enforce a chunked-commit strategy that still preserves pager-level partial writes
- initialize schema and migration state
- expose typed CRUD helpers for nodes, edges, chunks, knowledge, and artifact metadata
- create `.vscode/code-ingest/semantic-index/` alongside the DB on first use

The implementation must not buffer the full database into memory and overwrite it on every transaction. If the VFS path would force whole-file rewrites for ordinary SQLite page updates, that design is blocked and must be rejected.

`VscodeAsyncVfs.ts` implementation contract:

1. Extend the `wa-sqlite` VFS base class.
2. Implement async, Asyncify-safe `xOpen`, `xRead`, `xWrite`, `xTruncate`, `xSync`, `xFileSize`, `xDelete`, and `xAccess` methods over Node `fs` descriptor I/O.
3. Maintain a `Map<number, FileHandle>` keyed by SQLite file descriptor integers.
4. Translate runtime failures into SQLite error codes rather than throwing raw Node errors into the pager.
5. Register the VFS before the first DB open and fail activation if registration does not succeed.

### Step 2.4 — Implement the Single Writer Queue

Create `src/graph/database/SingleWriterQueue.ts`.

Representative shape:

```typescript
export interface PendingWriteBatch {
  reason: string;
  priority: 'HIGH' | 'MEDIUM' | 'LOW';
  filePaths: string[];
  abortSignal?: AbortSignal;
  nodeUpserts: GraphNode[];
  edgeUpserts: GraphEdge[];
  codeChunkUpserts: GraphCodeChunk[];
  commentChunkUpserts: GraphCommentChunk[];
  deletes: Array<{ table: string; filePath?: string; ids?: string[] }>;
}

export class SingleWriterQueue {
  enqueue(batch: PendingWriteBatch): Promise<void>;
  flush(): Promise<void>;
  isBusy(): boolean;
  waitForQuiescent(): Promise<void>;
}
```

Rules:

- all storage writes go through this queue
- `GraphDatabase` public writes are removed in favor of one exclusive `executeWriteBatch(batch: PendingWriteBatch): Promise<void>` path
- flushing occurs inside one SQLite transaction
- concurrent parsing is allowed; concurrent writes are not
- writes are batched with a short time window and a maximum operations-per-flush threshold
- queued work is coalesced by `filePath`
- backpressure is bounded; low-priority rebuild work may be merged, but active-file work must not starve
- cancellation is honored before flush for superseded or aborted work
- the queue must await Asyncify VFS drain before accepting the next write batch
- VFS drain awaits must race against `VFS_DRAIN_TIMEOUT_MS`; on timeout, emit an Output Channel warning and mark the root runtime degraded without disposing it
- `last_full_index` is committed only in the final transaction of a rebuild batch, never independently
- `waitForQuiescent()` resolves only when the queue has no active flush and no pending coalesced batch in the current write generation; read-side callers must not resume on a merely idle worker while buffered work still exists
- queue-driven writes must preserve SQLite's offset-based page updates rather than rewriting the full database file

### Step 2.5 — Implement Directory Merkle State

Add storage and update helpers for directory-level Merkle hashing.

Required behavior:

- persist one `directory_state` row per indexed directory
- derive each directory hash from sorted child file hashes plus child directory hashes
- on file add/change/delete, recalculate the parent directory and cascade upward until the root stabilizes
- persist `module_summaries.source_merkle_root` when generating a module summary
- allow module staleness checks to compare cached `source_merkle_root` against `directory_state.merkle_hash` in $O(1)$ time

### ✅ Checkpoint 2

- [ ] Schema matches the PRD
- [ ] Chunk foreign keys cascade correctly
- [ ] ID helpers all use `::`
- [ ] One root produces one DB and one semantic-index directory
- [ ] All writes are routed through `SingleWriterQueue`
- [ ] Queue batching, backpressure, and coalescing are specified and validated
- [ ] SQLite pager I/O uses Node `fs` random-access reads and writes, not `vscode.workspace.fs`
- [ ] Ordinary transactions do not degrade into whole-file database rewrites
- [ ] The queue waits for Asyncify VFS drain before the next write batch
- [ ] Drain timeouts degrade the runtime with a warning instead of deadlocking silently
- [ ] Directory Merkle roots are updated transactionally with file changes
- [ ] Module staleness can be checked without rescanning every child file

---

## Phase 3: Tree-Sitter Ingestion Pipeline

**Goal:** Replace the old extraction path with AST-based parsing, early sanitization, and memory-safe chunking.

### Step 3.0 — Implement `PIIService` Before Parser Work

Create `src/services/security/piiService.ts` before `TreeSitterExtractor` lands.

It must:

- support baseline `strict`, `mask`, and `allow` modes
- sanitize extracted content before storage
- provide a stable API that later export-policy work can extend in Phase 11

This resolves the forward dependency created when Phase 3 writes already require sanitized chunks.

### Step 3.1 — Implement `TreeSitterExtractor`

Create `src/graph/indexer/TreeSitterExtractor.ts`.

Delete `src/graph/indexer/LspExtractor.ts` before building this path. Do not adapt or reuse the LSP extractor; Tree-sitter is the normative v1 implementation.

It must:

- load grammars lazily
- resolve grammar assets through the packaged grammar resolver contract
- parse supported files in a worker-safe way
- accept marshaled parse jobs from the host instead of calling `vscode` APIs directly
- emit symbol records with ranges and containment
- degrade to file-level nodes if a grammar is unavailable

Representative parse job:

```typescript
export interface ParseJob {
  filePath: string;
  relativePath: string;
  languageId: string;
  content: string | Uint8Array;
  contentSource: 'dirty-buffer' | 'disk';
  grammarUri: string;
}
```

Representative types:

```typescript
export interface ExtractedSymbol {
  name: string;
  type: 'function' | 'class' | 'interface' | 'method';
  startLine: number;
  endLine: number;
  parentName?: string;
}

export interface ExtractionResult {
  symbols: ExtractedSymbol[];
  codeChunks: GraphCodeChunk[];
  commentChunks: GraphCommentChunk[];
}
```

### Step 3.2 — Implement `DirtyBufferResolver` and the Host-to-Worker Buffer Marshal

Create `src/graph/indexer/DirtyBufferResolver.ts`.

Behavior:

- if a target file is open and dirty, use `document.getText()` on the extension host
- otherwise read from disk on the extension host
- compute content hashes on the host side for both paths
- attach snapshot timestamp metadata and `diskMtimeMsAtResolve` to dirty-buffer reads
- return content, content source marker, and resolved grammar URI
- package a `ParseJob` and dispatch it to the Tree-sitter worker

The worker must never call `vscode.workspace.textDocuments`, `document.getText()`, or any other `vscode` API directly.

If a dirty-buffer snapshot is queued for commit, the writer path must re-read the file's on-disk `mtimeMs` immediately before flush. Discard and re-queue from disk only when `currentDiskMtimeMs > diskMtimeMsAtResolve`. Equality keeps the buffered snapshot. This contract exists to avoid false discards on coarse timestamp resolutions.

### Step 3.3 — Implement AST-Enforced Chunking

Create `src/graph/indexer/FileChunker.ts`.

Rules:

- chunk by AST unit whenever possible
- preserve class/function boundaries
- emit lineage metadata like `Auth > UserService > validateSession`
- if AST chunking is unavailable, fall back to a line-safe chunker with overlap

### Step 3.4 — Wire in Early PII Handling

Before storage, pass extracted content through `PIIService` implemented in Step 3.0.

Required flow:

`content -> PIIService -> sanitized chunk model -> writer queue`

### Step 3.5 — Build the New `GraphIndexer`

Create `src/graph/indexer/GraphIndexer.ts` that reuses:

- `FileScanner`
- `FilterService`
- `DirtyBufferResolver`
- `TreeSitterExtractor`
- `SingleWriterQueue`

The indexer is also responsible for:

- marshaling dirty-buffer content from host to worker
- updating directory Merkle state when files change
- ensuring grammar resolution happens before worker dispatch

Wiring contract:

1. `GraphIndexer.indexFile(relativePath)` calls `DirtyBufferResolver.resolve(relativePath)`
2. the resolver returns `{ content, contentSource, contentHash, snapshotTimestamp, grammarUri }`
2a. dirty-buffer resolutions also carry `diskMtimeMsAtResolve` for pre-flush stale-snapshot comparison
3. the host dispatches the parse job to the worker
4. the worker returns extracted symbols and raw chunk candidates
5. `FileChunker` finalizes AST-safe chunk boundaries and lineage
6. `PIIService` sanitizes chunk content
7. `SingleWriterQueue.enqueue(batch)` receives the final write batch

The indexer must also compile exclusions from:

- `.gitignore`
- `.codeingestignore`
- `files.exclude`
- `search.exclude`
- `codeIngest.indexing.excludePatterns`

### Step 3.6 — Add File Size and Memory Guards

- skip or file-node-only index files above the configured cap
- do not buffer the entire repository in memory
- keep parse/read concurrency bounded

### ✅ Checkpoint 3

- [ ] Supported files produce AST-based symbols and chunks
- [ ] Dirty buffers override disk content during indexing
- [ ] Dirty-buffer content is marshaled from host to worker without worker-side `vscode` calls
- [ ] Dirty-buffer stale-snapshot checks compare `currentDiskMtimeMs` against `diskMtimeMsAtResolve` with equality-case coverage
- [ ] PII is handled before data reaches storage
- [ ] Grammar assets resolve from packaged extension output
- [ ] Exclusion compilation includes VS Code excludes and ignore files
- [ ] Worker crashes and grammar-missing paths degrade safely without corrupting the queue
- [ ] Large files are safely bounded

---

## Phase 4: Trust-Gated Bootstrap and Reconciliation

**Goal:** Wire the new storage and indexer into activation with multi-root, trust, watcher coalescing, workspace-folder lifecycle disposal, and git-aware reconciliation.

### Step 4.1 — Build the Per-Root Runtime Registry

The existing single-root `workspaceFolders?.[0]` activation pattern is discarded. `src/extension.ts` becomes a trust-gated multi-root bootstrapper.

In `src/extension.ts`, define a runtime that is explicit about ownership and disposal:

```typescript
interface RootRuntime {
  folder: vscode.WorkspaceFolder;
  db: GraphDatabase;
  writerQueue: SingleWriterQueue;
  indexer: GraphIndexer;
  health: 'healthy' | 'degraded';
  fileWatchers: vscode.FileSystemWatcher[];
  gitMonitor: GitActivityMonitor;
  embeddingService: EmbeddingService;
  parseWorker: vscode.Disposable;
  semanticWorker: vscode.Disposable;
  outputChannel: vscode.OutputChannel;
  disposables: vscode.Disposable[];
  dispose(): Promise<void>;
}
```

Track one runtime per trusted root and centralize add/remove behavior in a dedicated registry.

### Step 4.1b — Extract `rootRuntimeRegistry.ts`

Create `src/services/rootRuntimeRegistry.ts`.

It must:

- maintain `Map<string, RootRuntime>` keyed by workspace folder URI
- expose `addRoot(folder)`, `removeRoot(folder)`, `getRuntime(uri)`, and `disposeAll()`
- own root lifecycle transitions so `extension.ts` does not hold ad-hoc global state

### Step 4.2 — Implement the Trust Gate

If `vscode.workspace.isTrusted` is false:

- do not create DBs or semantic indexes
- do not register watchers
- do not allow exports or chat context injection
- render sidebar and graph panel in `Trust-Locked`

When trust is granted, bootstrap all eligible roots.

Register `onDidChangeTrust` synchronously before any async work begins. The required pattern is: register handler, inspect current trust state, then start async bootstrap if already trusted.

### Step 4.3 — Implement the Activation Sequence

For each trusted root:

1. create or reuse the root runtime shell
2. open DB and manifests
3. register root-owned disposables and workspace-folder lifecycle hooks
4. compile watcher scopes from exclusions before allocating any OS watchers
5. compare schema version, `index_state`, file hashes, and directory Merkle roots
6. detect dirty buffers on the host side and prepare parse dispatch
7. detect git-head shifts
8. enqueue full rebuild or delta reconcile as required

Runtime activation must not edit the user's `.gitignore`. Ignore hygiene remains a repository-maintenance or documentation concern, not an automatic activation side effect.

While a full rebuild is active, the runtime marks `rebuildInProgress = true`. Watcher batches collected during rebuild are held in a pending set and diffed after rebuild completion so files already covered by the rebuild are not redundantly re-indexed.

### Step 4.4 — Handle Workspace Folder Add/Remove Lifecycle

Register `workspace.onDidChangeWorkspaceFolders` in `src/extension.ts`.

Required behavior:

- bootstrap runtimes for newly added trusted roots
- call `runtime.dispose()` for removed roots before dropping references
- terminate root-owned workers, queues, watchers, and subscriptions during disposal
- release DB handles so removed roots do not retain file locks

### Step 4.5 — Create `GitActivityMonitor`

This module must:

- detect bulk Git activity or HEAD changes
- pause watcher-driven deltas during the transition
- schedule a single reconciliation after the change set settles

### Step 4.6 — Implement the New `FileWatcher`

Requirements:

- do not register a global `**/*` watcher
- instantiate `vscode.RelativePattern` watchers only for allowed source scopes
- exclude ignored directories before watcher registration, not after events fire
- default debounce `800ms`
- coalesce changed and deleted files
- never write to storage directly
- feed reconcile requests into the root runtime

Tests for this step must assert that `vscode.workspace.createFileSystemWatcher` is called only with `RelativePattern` objects, never with bare glob strings.

### Step 4.7 — Expose Initialization State to the UI

The sidebar and graph panel must be able to read:

- `trust-locked`
- `not-initialized`
- `initializing`
- `ready`

The first-run experience is tied to these states: a welcome card and initialization CTA for `not-initialized`, progress plus cancel action for `initializing`, and the full product surface only in `ready`.

UI state is scoped to the active root. The active editor URI is the primary source of truth; if no editor is active, the sidebar may fall back to the current graph selection or explicit sidebar root selection. It must not show `Ready` for one root while the active surface belongs to another root that is still `Not Initialized` or `Initializing`.

### ✅ Checkpoint 4

- [ ] Untrusted workspaces stay locked
- [ ] Multi-root workspaces create isolated runtimes
- [ ] Removed workspace roots dispose cleanly without leaked DB handles or workers
- [ ] Watchers are allocated only from `RelativePattern`-scoped source areas
- [ ] File watcher tests reject bare `**/*` registrations
- [ ] Git branch switches do not create watcher storms
- [ ] Delta reconcile is coalesced and serialized
- [ ] UI can query the full four-state initialization machine

---

## Phase 5: Relevance Walking, Token Budgeting, and Prompt Safety

**Goal:** Implement retrieval that is model-aware, graph-ranked, low-latency, and injection-resistant.

### Step 5.0 — Implement `escapeHtml.ts`

Create `src/utils/escapeHtml.ts` before `ContextBuilder`.

It must:

- escape `<`, `>`, `&`, `"`, and `'`
- entity-encode any repository text that collides with or prefixes the randomized XML boundary pattern
- generate boundary tags with `crypto.getRandomValues(new Uint8Array(4))` and encode them as `8` hex characters; `Math.random()` is out of spec
- include fixtures covering exact boundary-tag collisions, prefix collisions, and nested XML-looking content

### Step 5.1 — Build `RelevanceWalker`

Create `src/graph/traversal/RelevanceWalker.ts`.

It must:

- accept semantic and lexical seeds
- run a personalized random walk / PPR pass
- apply explicit edge weights from the PRD instead of treating all edges uniformly
- down-rank generic hubs unless reinforced by the query
- return ordered nodes and edges for context building

`GraphTraversal` may remain as a primitive, but `CopilotParticipant` and export flows must call `RelevanceWalker` rather than BFS directly.

### Step 5.2 — Create `TokenBudgetService`

Create `src/services/tokenBudgetService.ts`.

Rules:

- accept the exact resolved `LanguageModelChat` for the current request
- use a fast local estimator to pre-pack candidate blocks synchronously
- use `vscode.lm.countTokens()` only as a verifier for each candidate block
- reserve a configurable percentage for system/output tokens
- apply a minimum reserve floor so the effective reserve becomes `max(percent reserve, minimum reserve)`
- if model counting is unavailable, fall back to structure-only context rather than a whitespace heuristic

Representative API:

```typescript
export interface TokenBudgetDecision {
  allowed: boolean;
  remaining: number;
  reserve: number;
  estimated: number;
  verified?: number;
}

export class TokenBudgetService {
  estimate(text: string): number;
  verify(model: vscode.LanguageModelChat, text: string): Promise<number>;
  canAdd(model: vscode.LanguageModelChat, currentText: string, nextBlock: string): Promise<TokenBudgetDecision>;
}
```

The service must not execute a `countTokens()` IPC call for every individual chunk or edge.

The service must also avoid a hidden per-item loop. `canAdd()` is called only when a candidate block for a relevance tier is complete, never after each individual node or chunk append.

### Step 5.3 — Rewrite `ContextBuilder`

Create `src/graph/traversal/ContextBuilder.ts` that:

- emits TOON output
- preferably uses `@vscode/prompt-tsx` when that path can preserve the same boundary and provenance guarantees
- returns a model-bound retrieval payload, not a user-visible chat answer
- preserves the required section order
- uses XML boundary wrapping for repository content
- uses `8`-hex boundary tags derived from `crypto.getRandomValues(new Uint8Array(4))` and escapes repository-provided XML tags before insertion
- greedily assembles candidate blocks with the local estimator
- verifies each candidate block once with `countTokens()` against the resolved model
- emits the exact `Context Used` footer format from the PRD, including verified prompt-token reporting

### Step 5.3a — Run the `@vscode/prompt-tsx` Spike

Before standardizing on `@vscode/prompt-tsx`, run a spike that proves it can preserve the same XML boundary isolation, provenance labeling, and token-accounting guarantees required by the PRD.

Acceptance rule:

- keep `ContextBuilder` on the direct string/XML path unless the spike demonstrates parity for boundary safety, deterministic provenance sections, and model-bound token verification

### Step 5.4 — Add Progress Hooks

All chat retrieval paths must emit progress messages during:

- semantic search
- graph ranking
- context compression

### Step 5.5 — Benchmark Retrieval Latency

Add a benchmark harness that measures the PPR ranking path against the 10,000-node target envelope.

Required outcome:

- the first retrieval progress update remains under the PRD target
- PPR ranking does not regress into frontier-ordered traversal behavior under load

### ✅ Checkpoint 5

- [ ] Retrieval ranking is graph-ranked, not frontier-ordered
- [ ] Chat payload enforcement uses model-scoped `countTokens()` verification
- [ ] No per-chunk `countTokens()` IPC loop exists in the packing path
- [ ] No hidden per-item `canAdd()` loop exists inside `ContextBuilder`
- [ ] Repository content is isolated by escaped XML boundaries
- [ ] Footer format matches the PRD exactly
- [ ] Progress hooks are visible during chat retrieval
- [ ] PPR benchmark coverage exists for the target graph-size envelope

---

## Phase 6: Semantic Worker and JIT Knowledge

**Goal:** Add background semantic indexing without blocking the extension host, and implement on-demand knowledge caching.

### Step 6.0 — Create `SemanticIndexStore`

Create `src/graph/semantic/SemanticIndexStore.ts` before the semantic worker lands.

It must own:

- sidecar manifest persistence
- checksum metadata
- document-to-artifact mappings
- compaction-threshold state and rebuild bookkeeping

`SemanticIndexWorker.ts` consumes this store; it does not absorb the store's persistence responsibilities inline.

### Step 6.1 — Build `SemanticIndexWorker`

Create `src/graph/semantic/SemanticIndexWorker.ts` and a worker bootstrap.

One semantic worker is created per `RootRuntime`. It is owned and disposed by that root alongside the parse worker, and its queues, cooldown state, manifests, and sidecar paths are isolated by root.

Responsibilities:

- receive vectors from the host-side `EmbeddingService`
- build and query HNSW sidecars
- persist document metadata in `embedding_document_metadata`
- persist sidecar state through `SemanticIndexStore`
- maintain versioned sidecar manifests and checksum metadata
- expose rebuild and compaction hooks when sidecars go stale or corrupt
- trigger compaction when document count reaches `HNSW_COMPACTION_DOC_THRESHOLD` or stale-ratio reaches `HNSW_COMPACTION_STALENESS_RATIO`
- expose async query APIs to the extension host

### Step 6.2 — Create `EmbeddingService`

`EmbeddingService` is the host-side coordinator. It must:

- call `vscode.lm.computeTextEmbedding()` on the extension host
- run `embeddingAvailabilityProbe()` on first activation and surface the result in the sidebar state
- keep a failure counter
- apply `maxRetries = 3`
- apply `cooldownMs = 300000`
- use an atomic state machine with `idle`, `active`, and `cooldown`
- degrade cleanly to graph-only retrieval when semantic search is unavailable

### Step 6.3 — Enforce Lazy / Idle Embedding Work

Embeddings are not a mandatory part of initial activation. They are created lazily or during idle windows after the base graph exists.

This is also where bounded soft prefetch belongs: allow idle-time synthesis only for active-file or active-module knowledge, never whole-repo summarization.

### Step 6.4 — Implement JIT Knowledge Caching

Create `src/services/knowledgeService.ts`.

Rules:

- generate summaries only when asked by the user or required by a live query
- cap synthesis concurrency with `KNOWLEDGE_MAX_CONCURRENT_SYNTHESIZES`, defaulting to `2` per root rather than a single root-wide lock
- cache the result in `knowledge_chunks` and `module_summaries`
- mark node summaries stale when source hashes change
- persist `module_summaries.source_merkle_root` and mark module summaries stale by comparing it to the cached directory Merkle hash, not by rescanning all files in the directory at query time
- call `writerQueue.waitForQuiescent()` before Merkle reads so knowledge refresh never reads half-applied state
- never run autonomous whole-repo summarization after indexing

### Step 6.5 — Register Explicit Knowledge Commands

Add commands for:

- generate current node knowledge
- refresh current node knowledge
- generate current module knowledge

### ✅ Checkpoint 6

- [ ] Semantic indexing runs outside the extension host hot path
- [ ] Embedding availability is probed and surfaced to the user
- [ ] Cooldown and retry behavior matches the PRD
- [ ] Lexical-only retrieval remains fully functional when semantic search is unavailable
- [ ] Knowledge generation is JIT only
- [ ] Soft prefetch stays bounded to active-file or active-module scope
- [ ] HNSW sidecars are versioned, checksum-validated, and rebuildable
- [ ] Staleness tracking works for changed nodes and modules without $O(N)$ directory rescans

---

## Phase 7: Copilot Chat Participant

**Goal:** Register `@code-ingest` and route all participant commands through the new retrieval stack with exact model resolution, actual LLM inference, and streamed answer delivery.

### Step 7.0 — Create `languageModelResolver.ts`

Create `src/services/languageModelResolver.ts`.

It must:

- resolve the exact `LanguageModelChat` requested by the chat invocation
- centralize model-family selection and fallback rejection behavior
- return the same resolved model instance used for both token verification and `sendRequest(...)`

### Step 7.1 — Update `package.json`

Contribute the `code-ingest` chat participant and slash commands from the PRD.

When the Language Model Tool API is available, also register the same capabilities as explicit `vscode.lm.tools` so agent mode can invoke them without reintroducing implicit context injection.

### Step 7.2 — Create `copilotParticipant.ts`

Implement this step in the following order:

1. run pre-flight checks for trust, graph readiness, DB readability, and model availability
2. resolve the active root and active file
3. resolve the exact chat model from `request.model`
4. call `vscode.lm.selectChatModels({ vendor: 'copilot', family: request.model.family })`
5. bind that exact `LanguageModelChat` instance to token verification and prompt dispatch
6. emit progress hooks
7. perform semantic + lexical seed lookup
8. invoke `RelevanceWalker`
9. request JIT knowledge when required, including `/explain` and `/audit`-specific behavior from the PRD
10. build the final TOON retrieval payload through `ContextBuilder`
11. construct `vscode.LanguageModelChatMessage[]` that contain the developer's real chat query plus the retrieval payload in the chosen role layout
12. call `LanguageModelChat.sendRequest(messages, {}, token)` on the resolved model
13. stream the model's answer chunks back through `ChatResponseStream.markdown()`
14. append the `Context Used` footer only after model generation completes

Pass the cancellation token through retrieval, semantic worker calls, and `sendRequest(...)`. Never silently token-count against a fallback model that is different from the one receiving the request payload. The participant must also never dump the raw TOON payload back to the user as its main response body.

### Step 7.3 — Enforce Explicit Context Injection Only

Do not inject graph context into generic Copilot messages. `@code-ingest` remains the explicit activation surface, and any `vscode.lm.tools` registration must still require an explicit tool invocation.

### Step 7.4 — Ensure Root Awareness

Never assume `workspaceFolders?.[0]`. All file, chat, and export actions must resolve the correct root from the relevant URI.

Required resolution order for chat flows:

1. explicit file argument or command URI
2. active editor URI
3. current graph selection or sidebar-selected root
4. the single open workspace root, if exactly one exists
5. otherwise stop with a user-visible root-ambiguity response instead of guessing

### ✅ Checkpoint 7

- [ ] `@code-ingest` appears in Copilot Chat
- [ ] `/context`, `/impact`, `/search`, `/audit`, and `/export current-context` route correctly
- [ ] The exact request model is resolved before token verification and prompt dispatch
- [ ] The participant executes `LanguageModelChat.sendRequest(...)` with `LanguageModelChatMessage[]` built from the user query plus TOON context
- [ ] The model answer is streamed through `ChatResponseStream.markdown()` before the footer is appended
- [ ] Participant output includes progress hooks and provenance footer
- [ ] Semantic unavailability falls back cleanly without crashing the participant

---

## Phase 8: Canvas and Worker Graph View

**Goal:** Implement a graph panel that scales beyond DOM-heavy rendering and remains responsive during large transfers. This phase remains secondary to retrieval correctness and may slip if Phases 5-7 need stabilization.

### Step 8.1 — Create the Graph Webview Shell

Add:

- `resources/webview/graph/graphView.html`
- `resources/webview/graph/graphView.js`
- `resources/webview/graph/graph.worker.js`
- `resources/webview/graph/graphStyles.css`

Apply the PRD CSP in this step rather than treating it as later hardening.

### Step 8.2 — Define the Binary Transfer Protocol

Create `graphBinaryProtocol.ts` or `graphBinaryProtocol.js` to encode and decode:

- node batches
- edge batches
- metadata dictionaries
- follow-up chunk loads

Use transferable `ArrayBuffer` / `Uint8Array` payloads. Do not send giant object arrays.

The protocol must be versioned. Define a small fixed header that carries at minimum:

- protocol magic bytes
- protocol version
- payload kind
- payload length

Unknown protocol versions must be rejected on decode and force a clean reload rather than best-effort interpretation.

Track `transferInProgress` in the webview layer. Never call `vscode.setState()` while a transfer is mid-flight. If the panel is hidden during transfer, abort cleanly and restore from the last complete state snapshot.

### Step 8.3 — Implement the Main-Thread Canvas Controller

`graphView.js` is responsible for:

- canvas painting
- hit testing
- toolbar controls
- selection state
- keyboard navigation
- empty-state rendering
- `vscode.setState()` / `getState()`

Persisted graph-view state must also carry a schema version. If the saved state version is unknown or incompatible, discard it and restore from a clean default instead of attempting partial migration during normal load.

### Step 8.4 — Implement the Worker Layout Engine

`graph.worker.js` is responsible for:

- layout and physics
- semantic zoom thresholds
- batch position updates
- graph-state restoration support

### Step 8.5 — Add Theme Sync and Accessibility Mirror

Required behavior:

- read VS Code CSS variables dynamically
- re-render on theme mutation
- maintain an off-screen accessible description of current focus/selection

### Step 8.6 — Implement Full Interaction Contract

Must support:

- single-click node selection
- double-click file open
- edge popover
- right-click menu with explain, dependency, dependents, ask-AI, open-file, copy-path, export-context, generate-knowledge, and refresh-knowledge actions
- ctrl/cmd multi-select
- `Ctrl+Shift+E` export selection
- graph search
- filter panel
- state restore on tab switch

### ✅ Checkpoint 8

- [ ] Graph payloads are chunked and binary-transferred
- [ ] Canvas UI stays responsive during large graph loads
- [ ] Worker handles layout without blocking the webview main thread
- [ ] Theme changes repaint correctly
- [ ] Accessibility mirror updates with focus and selection

---

## Phase 9: Sidebar, Settings, and Root-Aware Commands

**Goal:** Build the canonical user control surface and wire it to the new architecture.

### Step 9.1 — Implement the Sidebar State Shell

Render these states explicitly:

- `Trust-Locked`
- `Not Initialized`
- `Initializing`
- `Ready`

The `Not Initialized` state shows a first-run welcome card and a single initialization CTA. The `Initializing` state shows progress plus cancellation and hides Ready-only actions.

The sidebar state is bound to the active root using the same resolution order as other UI surfaces: active editor URI first, then current graph selection or explicit sidebar root selection, then single-root fallback only when unambiguous.

### Step 9.2 — Build the Ready-State Sections

- system status
- active file context
- export panel
- retrieval controls and context-window indicator
- exclusion patterns
- knowledge cache status and embedding availability
- diagnostics actions and open graph view

### Step 9.2a — Extend `messageEnvelope.ts`

Extend `src/providers/messageEnvelope.ts` before live sidebar and graph wiring begins.

It must define typed, versioned envelopes for:

- sidebar state
- token-budget updates
- graph binary-transfer coordination
- trust-state changes

Every envelope must include a version field so host and webview layers can reject unsupported message revisions safely.

### Step 9.2b — Wire the Ready-State Token Indicator

The Ready-state context-window indicator must be live, not static.

It must:

- request token estimates from `TokenBudgetService.estimate(...)`
- receive updates through the typed message-envelope path
- reflect the active model budget assumptions used by retrieval packing
- use the non-chat model selection order defined for preflight estimates: last successfully resolved chat model, then configured Copilot family, otherwise `token estimate unavailable`

### Step 9.3 — Add the New Settings Surface

Expose the new settings from the PRD, including:

- `codeIngest.graph.initialBatchNodes`
- `codeIngest.graph.transportChunkSizeKB`
- `codeIngest.copilot.reserveTokensPercent`
- `codeIngest.copilot.reserveTokensMin`
- `codeIngest.knowledge.mode`
- `codeIngest.knowledge.softPrefetchMode`
- `codeIngest.knowledge.maxConcurrentSyntheses`
- `codeIngest.pii.mode`
- `codeIngest.pii.strictForExport`
- `codeIngest.allowRawExport`

### Step 9.4 — Register Root-Aware Commands

Ensure all commands resolve the correct runtime from:

- explicit command URI
- active editor URI
- current graph selection

### Step 9.5 — Consolidate the Command and Export Surface

Required work:

- standardize on `codeIngest.*` command IDs only
- remove dual-registration through `COMMAND_ALIASES`
- document deprecated kebab-case IDs in release notes rather than keeping them active
- route any retained legacy `generateDigest` entrypoint through `ExportController` Raw mode with the same preview and policy checks used elsewhere

### Step 9.6 — Reconcile Legacy Digest Coverage Before Phase 10

Resolve `describe.skip('DigestGenerator legacy suite')` before export-governance work depends on that path.

Acceptable outcomes:

- merge its coverage into the modern unit tests, or
- delete the skipped suite with an explicit migration note

### ✅ Checkpoint 9

- [ ] Sidebar shows all four states correctly
- [ ] Settings are written through `vscode.workspace.getConfiguration('codeIngest')`
- [ ] Root-aware command resolution never falls back blindly to `workspaceFolders?.[0]`
- [ ] Command registration is standardized on `codeIngest.*` without active dual aliases
- [ ] Legacy raw-export entrypoints route through `ExportController`
- [ ] Raw export UI reflects policy state

---

## Phase 10: Preview-First Export Governance

**Goal:** Keep export useful while making Raw mode policy-safe and explicit.

### Step 10.1 — Implement `ExportController`

Three modes:

- `Raw`
- `Clean`
- `Graph`

Rules:

- `preview()` runs before `export()`
- Raw mode delegates to `DigestGenerator` only through `ExportController`
- Clean and Graph modes delegate to `ContextBuilder`

### Step 10.2 — Add the Mandatory Raw Policy Gate

Before any Raw export:

1. resolve `codeIngest.allowRawExport`
2. if false, block immediately
3. if true, show preview
4. after preview confirmation, show the raw warning modal
5. only then export

### Step 10.3 — Add Selection-Based Export

The graph panel and sidebar must both be able to export:

- current file scope
- current graph selection
- current ranked context

### Step 10.4 — Make Preview Metrics Honest

Preview should surface:

- estimated size in bytes
- file count
- redaction count
- token count when model counting is available, using the same non-chat model selection order as the sidebar indicator: last successfully resolved chat model, then configured Copilot family
- `token count unavailable` when model counting cannot run

### ✅ Checkpoint 10

- [ ] No export runs without a preview
- [ ] Raw export is blocked by policy when disabled
- [ ] Raw export compatibility entrypoints use the same controller path
- [ ] Selection export flows through the same controller path
- [ ] Preview numbers come from the real export path, not a fake side estimate

---

## Phase 11: Security and Compliance Hardening

**Goal:** Turn the architecture into a safe extension boundary, not just a functional one.

### Step 11.1 — Finalize `PIIService`

`PIIService` core ingestion behavior is already implemented in Phase 3. Phase 11 finishes policy hardening:

Implement or finalize policy modes:

- `strict`
- `mask`
- `allow`

Apply `strict` automatically for training or governed export paths.

### Step 11.2 — Strip Outbound Telemetry

Search and replace any outbound transport remaining in telemetry code.

Required work:

- remove network transport from `telemetryService.ts`
- remove any consent/privacy transport helpers that only exist for outbound telemetry
- replace the service with Output Channel logging plus structured local diagnostics
- add a redacted debug-bundle export path
- write a zero-network assertion test that mocks `fetch` and verifies it is never called

### Step 11.3 — Add Runtime Message Validation

Every webview → host message must be checked at runtime before side effects occur.

### Step 11.4 — Enforce Workspace-Local Paths

All file open/export/reveal operations must validate that incoming paths resolve inside a trusted workspace root.

Use a shared validation helper equivalent to:

```typescript
async function assertWorkspacePath(rawPath: string, root: string): Promise<string> {
  const canonicalRoot = await fs.promises.realpath(root);
  const candidate = path.resolve(root, rawPath);
  const canonicalCandidate = await fs.promises.realpath(candidate);
  const relative = path.relative(canonicalRoot, canonicalCandidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Path escapes trusted workspace root');
  }
  return canonicalCandidate;
}
```

Test with traversal, UNC, absolute-drive, URI-encoded escape inputs, symlink escapes, and Windows path-normalization cases.

### Step 11.5 — Add Prompt Injection Tests

Create fixtures with hostile comments and verify the XML boundary system prevents repository text from escaping the untrusted payload region.

Include fixtures for:

- exact randomized boundary-tag collisions
- boundary-prefix collisions
- nested XML-looking repository content

### ✅ Checkpoint 11

- [ ] PII is handled before storage
- [ ] No outbound telemetry transport remains
- [ ] Structured local logs and debug bundles are available
- [ ] Runtime message validation is enforced for privileged actions
- [ ] Workspace-local path checks are in place
- [ ] Prompt injection fixtures stay isolated by escaped XML boundaries

---

## Phase 12: Testing, Packaging, and Release

**Goal:** Ship a bounded, cross-platform VSIX with the new architecture fully validated.

### Step 12.1 — Unit Tests

Required targets:

- `GraphDatabase`
- `SingleWriterQueue`
- `TreeSitterExtractor`
- `RelevanceWalker`
- `ContextBuilder`
- `TokenBudgetService`
- `EmbeddingService`
- `rootRuntimeRegistry`
- `PIIService`

Storage receives the heaviest coverage in this phase. Prioritize VFS, queue, and corruption-recovery tests before widening the surface.

### Step 12.2 — Integration Tests

Required flows:

- trusted/untrusted bootstrap
- not-initialized → initializing → ready state progression
- multi-root resolution
- dirty-buffer indexing
- dirty-buffer parse queued, `mtime` advances before flush, stale in-memory snapshot is discarded, and parsing is re-queued from disk
- dirty-buffer equality case where `currentDiskMtimeMs === diskMtimeMsAtResolve` keeps the buffered snapshot
- host-to-worker dirty-buffer marshal
- workspace-folder add/remove disposal lifecycle
- watcher scope allocation without global `**/*`
- git branch switch reconcile
- 50 concurrent file changes while a write transaction is active
- embedding availability probe and lexical-only retrieval fallback
- exact chat model resolution from `ChatRequest.model`
- model answer execution through `LanguageModelChat.sendRequest(...)`
- streamed answer chunks arrive before the `Context Used` footer is appended
- `/audit` and `/explain` stale/fresh/missing knowledge behavior
- synthesis started mid-write waits for `writerQueue.waitForQuiescent()` before reading Merkle state
- cancellation propagation through retrieval and model send
- legacy raw-export compatibility path obeys the same policy gate
- participant progress hooks
- raw export policy denial
- active editor switches across roots update the sidebar state machine without showing the wrong root status

### Step 12.3 — Webview Tests

- binary decode
- worker state restore
- abort-on-hide during binary transfer
- graph/sidebar selection sync
- node context-menu actions
- keyboard navigation
- theme change repaint
- accessible mirror updates

### Step 12.4 — Package the VSIX

The final package must include:

- local worker bundles
- WASM SQLite runtime assets
- curated Tree-sitter grammars with the minimal baseline set required for v1
- no native `.node` binaries

### Step 12.5 — Final Release Gate

Verify:

- build succeeds
- tests pass
- VSIX size stays within budget
- minimum VS Code version activates cleanly
- semantic sidecars rebuild cleanly after checksum/version failure

### ✅ Checkpoint 12

- [ ] Unit, integration, and webview tests all pass
- [ ] No native binaries are bundled
- [ ] VSIX size is within budget
- [ ] The release matches the PRD definition of done

---

## Appendix A: Key Modules

| Module | Responsibility | Phase |
|---|---|---|
| `src/graph/database/GraphDatabase.ts` | WASM SQLite wrapper | 2 |
| `src/graph/database/VscodeAsyncVfs.ts` | Asyncify VFS bridge for Node `fs` random-access pager I/O | 2 |
| `src/graph/database/SingleWriterQueue.ts` | Serialized transactional writes | 2 |
| `src/utils/escapeHtml.ts` | Boundary-safe repository content escaping | 5 |
| `src/graph/indexer/TreeSitterExtractor.ts` | AST parsing | 3 |
| `src/graph/indexer/GrammarAssetResolver.ts` | Packaged grammar path resolution | 1, 3 |
| `src/graph/indexer/DirtyBufferResolver.ts` | Dirty editor precedence | 3 |
| `src/graph/indexer/GraphIndexer.ts` | Scan/parse/chunk/store pipeline | 3 |
| `src/graph/indexer/GitActivityMonitor.ts` | Git-aware pause and reconcile | 4 |
| `src/services/rootRuntimeRegistry.ts` | Workspace-folder lifecycle and runtime disposal | 4 |
| `src/services/tokenBudgetService.ts` | Model-aware token enforcement | 5 |
| `src/graph/traversal/RelevanceWalker.ts` | PPR-style ranking | 5 |
| `src/graph/traversal/ContextBuilder.ts` | TOON payload + XML boundaries | 5 |
| `src/graph/semantic/SemanticIndexWorker.ts` | Worker-backed HNSW semantic index | 6 |
| `src/graph/semantic/SemanticIndexStore.ts` | Sidecar manifests, checksum tracking, and compaction-threshold state | 6 |
| `src/services/embeddingService.ts` | Semantic orchestration and cooldowns | 6 |
| `src/services/knowledgeService.ts` | JIT knowledge cache | 6 |
| `src/services/languageModelResolver.ts` | Exact Copilot model resolution | 7 |
| `src/services/copilotParticipant.ts` | Chat participant | 7 |
| `src/providers/graphViewPanel.ts` | Graph panel host bridge | 8 |
| `resources/webview/graph/graph.worker.js` | Layout worker | 8 |
| `src/providers/sidebarProvider.ts` | Sidebar controller | 9 |
| `src/services/exportController.ts` | Preview-first export orchestration plus legacy raw-path governance | 10 |
| `src/services/security/piiService.ts` | Early PII and secret handling | 3, 11 |

## Appendix B: Gap Traceability Summary

This plan addresses the major issues raised in `next-phase.md` as follows:

Runtime note: v1 standardizes on `wa-sqlite` because the Asyncify bridge is currently the most practical way to preserve Node `fs` random-access pager I/O inside the extension. If runtime divergence or maintenance cost becomes unacceptable, the preferred v2 migration target is `@sqlite.org/sqlite-wasm`.

| Gap Area | Resolution Phase |
|---|---|
| Native SQLite fragility | 1, 2, 12 |
| Async WASM VFS deadlock risk | 1, 2, 12 |
| Asyncify write amplification and batching | 2, 12 |
| `vscode.workspace.fs` SQLite VFS illusion | 2, 12 |
| Main-thread semantic work | 6, 8 |
| Slow vector retrieval | 6 |
| Semantic sidecar corruption and rebuild lifecycle | 6, 12 |
| DOM-heavy graph rendering | 8 |
| Tokenization drift | 5 |
| Async `countTokens()` loop latency | 5, 7 |
| Super-node poisoning | 5 |
| Missing edge-weight contract | 5 |
| LSP dependency | 3 |
| Dirty-buffer worker boundary violation | 3, 4 |
| Grammar bundle path resolution | 1, 3, 12 |
| Grammar bundle size pressure | 1, 12 |
| Runtime-only redaction | 3, 11 |
| Ingestion OOM risk | 3, 4 |
| Module staleness scan bottleneck | 2, 6 |
| Workspace lifecycle leaks | 4, 12 |
| Git branch-switch corruption | 4 |
| Global watcher allocation failure | 4, 12 |
| Background knowledge overreach | 6 |
| Knowledge synthesis root-wide blocking | 6 |
| Copilot model selection gap | 5, 7 |
| Copilot chat streaming disconnect | 7, 12 |
| Embedding API availability and sidebar signaling | 6, 9 |
| Export DLP risk | 9, 10, 11 |
| Legacy raw export bypass | 9, 10, 12 |
| Missing progress hooks | 5, 7 |
| IPC memory pressure | 8 |
| Prompt injection boundary failure | 5, 11 |
| Single-writer verification | 2, 4 |
| Context footer ambiguity | 5, 7 |
| Initialization-first UX gaps | 4, 9 |
| Local diagnostics without telemetry | 9, 11 |
| Trust-gate coverage | 4, 9, 11 |

---

This implementation plan is intentionally narrower and stricter than the earlier draft. The product now favors cross-platform reliability, bounded runtime behavior, and explicit governance over convenience shortcuts that would fail under real VS Code conditions.