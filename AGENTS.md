# AGENTS.md — Code-Ingest

PRD (`prd.md`) and implementation plan (`phased-plan.md`) are the normative architecture source of truth. All implementation must align with their v1 constraints.

## Exact Commands
- **Build:** `npm run build` (webpack production + copy webview assets)
- **Dev build with watch:** `npm run build:dev && npm run build:watch`
- **Lint:** `npm run lint`
- **Type check:** `npm run type-check`
- **Unit tests:** `npm run test:unit` (requires `--experimental-vm-modules`, runs in-band)
- **Webview tests:** `npm run test:webview` (separate Jest config)
- **Integration tests:** `npm run test:integration`
- **Full test suite:** `npm run test` (unit + webview)
- **CI pipeline:** `npm run ci` (type-check + test + build)
- **Package VSIX:** `npm run package` (outputs to `dist/code-ingest.vsix`, no native `.node` binaries allowed)
- **Single test:** Append Jest args after `--`, e.g. `npm run test:unit -- --testPathPattern=src/test/vnext/unit/example.test.ts`
- **Command order:** Full build runs `webpack → copyWebviewAssets`; CI runs `type-check → test → build`

## Architecture Overview

### High-Level Data Flow
```
Trusted workspace root opens
  → Root bootstrap (extension.ts)
    → Wasm GraphDatabase (graph.db via Asyncify WASM SQLite over Node fs random-access VFS)
    → GraphIndexer (FileScanner → DirtyBufferResolver → Tree-sitter worker → PIIService → FileChunker → SingleWriterQueue)
    → EmbeddingService + SemanticIndexWorker (host-side computeTextEmbedding → worker HNSW sidecars)
    → FileWatcher + GitActivityMonitor (RelativePattern-scoped, debounced, git-aware pause)
    → Copilot Chat Participant (@code-ingest: semantic seed → RelevanceWalker → ContextBuilder → sendRequest → stream answer)
    → Graph View WebviewPanel (Canvas + graph.worker.js, chunked binary IPC)
    → ExportController (preview-first, policy-gated Raw/Clean/Graph modes)
```

### Storage Layout
```
.vscode/code-ingest/          ← Add to .gitignore
  graph.db                    ← WASM SQLite (Node fs VFS, never vscode.workspace.fs)
  semantic-index/             ← HNSW sidecars + manifests
```

### Four Persistent Layers + Sidecar
- **Structural:** files, symbols, relationships (nodes + edges in SQLite)
- **Chunk:** AST-complete code and comment retrieval units
- **Lexical:** extracted terms and anchors for exact-match recall
- **Knowledge:** cached human-readable summaries and invariants
- **Semantic Sidecar:** HNSW indexes (vectors never stored in SQLite)

## Schema & Data Contracts

### Deterministic ID Contracts (mandatory `::` delimiter)
```
Node ID:   sha256(`${workspaceRoot}::${relativePath}::${symbolName}`)
Edge ID:   sha256(`${sourceId}::${targetId}::${type}`)
Chunk ID:  sha256(`${fileNodeId}::${startLine}::${endLine}`)
```
For file-level nodes, `symbolName` MUST be `''` (empty, not undefined/null) so trailing `::` is preserved.

### Core Tables (with cascading foreign keys)
- **`nodes`** — `id`, `type`, `label`, `file_path`, `relative_path`, `start_line`, `end_line`, `language`, `last_indexed`, `hash`, `metadata`
- **`edges`** — `id`, `source_id` FK→nodes, `target_id` FK→nodes, `type`, `weight` (REAL, default 1.0), `metadata`
- **`code_chunks`** — `id`, `file_node_id` FK→nodes, `start_line`, `end_line`, `content`, `lineage`, `pii_detected`, `pii_redacted_content`
- **`comment_chunks`** — `id`, `file_node_id` FK→nodes, `start_line`, `end_line`, `content`, `lineage`, `pii_detected`, `pii_tags`
- **`knowledge_chunks`** — `id`, `node_id`, `summary`, `invariants`, `pii_detected`, `pii_redacted_summary`, `created_at`, `stale`
- **`knowledge_links`** — `knowledge_id`, `source_chunk_id`
- **`terms`** — `id`, `term`, `frequency`
- **`term_links`** — `term_id`, `node_id`
- **`module_summaries`** — `id`, `module_path`, `summary`, `file_count`, `source_merkle_root`, `created_at`, `stale`
- **`directory_state`** — `relative_path`, `parent_relative_path`, `merkle_hash`, `child_count`, `updated_at`
- **`index_state`** — `workspace_hash`, `last_full_index`, `node_count`, `edge_count`, `schema_version`, `git_head`
- **`embedding_document_metadata`** — `id`, `kind`, `source_table`, `source_id`, `content_hash`, `artifact_key`, `last_embedded` (vectors live in HNSW sidecars only)
- **`artifact_state`** — `artifact_key`, `kind`, `backend`, `artifact_path`, `doc_count`, `updated_at`

### Node Types: `file`, `function`, `class`, `interface`, `method`, `knowledge`, `module_summary`

### Edge Types & Default Weights
| Edge Type | Default Weight |
|---|---|
| `call` | 1.0 |
| `inheritance` | 0.9 |
| `implements` | 0.8 |
| `import` | 0.7 |
| `contains` | 0.5 |
| `knowledge_of` | 1.2 |

Weightless edges are out of spec — they collapse PPR into almost-uniform walks.

### Directory Merkle State
Each directory has a `merkle_hash` derived from sorted child file hashes + child directory hashes. On any file add/change/delete, recalculate parent and cascade upward to root. `module_summaries.source_merkle_root` compared against `directory_state.merkle_hash` determines module-summary staleness in O(1).

## Architecture Gotchas & Constraints
- **Entry point:** `src/extension.ts` → compiled to `out/extension.js` (VS Code `main` field)
- **Trust gate:** All graph features require `vscode.workspace.isTrusted`; untrusted workspaces lock all functionality (no DB creation, no file watching, no exports, no chat context injection)
- **Storage:** Per-root WASM SQLite `graph.db` + HNSW sidecars in `.vscode/code-ingest/` (add to `.gitignore`)
- **No native SQLite:** Deprecate `better-sqlite3`, use `wa-sqlite` WASM with Node `fs` VFS (never `vscode.workspace.fs` for pager I/O — it lacks offset-based partial-write semantics)
- **VFS contract:** `VscodeAsyncVfs` must implement `xOpen`, `xRead`, `xWrite`, `xTruncate`, `xSync`, `xFileSize`, `xDelete`, `xAccess` over Node `fs` descriptor I/O, return SQLite error codes (not raw Node errors), maintain `Map<number, FileHandle>`, register before any DB open. No full-file DB rewrites for ordinary transactions.
- **Write discipline:** All SQLite writes go through `SingleWriterQueue` (`src/graph/database/SingleWriterQueue.ts`), no concurrent writes
- **Queue guarantees:** Writes batched in 5-20ms windows, coalesced by `filePath`, prioritized as HIGH/MEDIUM/LOW. Flushes inside one SQLite transaction. Must await VFS drain (`VFS_DRAIN_TIMEOUT_MS = 5000`) before next batch; timeout degrades runtime without disposal. `waitForQuiescent()` resolves only when no active flush AND no pending coalesced batch.
- **Rebuild-delta coordination:** During full rebuild (`rebuildInProgress = true`), watcher deltas are held in pending set and diffed after rebuild completion.
- **Dirty buffer contract:** `DirtyBufferResolver` (extension host only, never in workers). If file is open+dirty, use `document.getText()`; before flush, re-check `mtimeMs` — discard only when `currentDiskMtimeMs > diskMtimeMsAtResolve` (equality keeps buffered snapshot).
- **Worker boundary:** Tree-sitter/semantic workers never call `vscode` APIs; dirty buffer resolution runs on extension host only
- **ID contracts:** Mandatory `::` delimiter for all node/edge/chunk SHA256 IDs
- **Settings:** All `codeIngest.*` settings via `vscode.workspace.getConfiguration('codeIngest')`, not legacy `ConfigurationService`
- **Command IDs:** Standardize on `codeIngest.*`, never dual-register legacy `code-ingest.*` aliases
- **Token budgeting:** Use `vscode.lm.countTokens()` for verification (no whitespace heuristics), batched checks per relevance tier only. Never per-chunk `countTokens()` loops. Reserve = `max(codeIngest.copilot.reserveTokensPercent, codeIngest.copilot.reserveTokensMin)`.
- **Non-chat estimates:** Model resolution order: last successfully resolved chat model → configured Copilot family → `estimate unavailable` (never silently claims parity with an unresolved model).
- **Context safety:** XML boundaries use 8-hex tags from `crypto.getRandomValues(new Uint8Array(4))` (no `Math.random()`), entity-encode repository content to prevent boundary collision. Exact footer format:
  ```
  ---
  **Context Used:**
  - Files: auth.ts, db.ts (2)
  - Graph nodes: 14
  - Retrieval depth: 3
  - Semantic matches: included
  - Prompt tokens: 1840 verified
  - PII policy: strict
  ```
- **Embeddings:** Host-side `vscode.lm.computeTextEmbedding()` only; workers receive vectors, 3 retries/300s cooldown. Atomic state machine: `idle` → `active` → `cooldown`. Lexical+structural retrieval is first-class when embeddings unavailable.
- **Export gate:** Raw export blocked unless `codeIngest.allowRawExport: true`, must route through `ExportController` preview flow. Three modes: Raw (`DigestGenerator` only via controller), Clean (`ContextBuilder` + sanitized scope), Graph (`RelevanceWalker` + `ContextBuilder`).
- **Multi-root:** Per-root `RootRuntime` via `rootRuntimeRegistry.ts`, dispose all resources on workspace folder removal (close DB, flush writer, terminate workers, dispose watchers)
- **File watchers:** Only `RelativePattern`-scoped, no global `**/*` watchers, 800ms default debounce. Exclusions compiled from: hardcoded defaults → `.gitignore` → `.codeingestignore` → `files.exclude` → `search.exclude` → `codeIngest.indexing.excludePatterns`.
- **Knowledge:** JIT only, no autonomous whole-repo summarization, max 2 concurrent syntheses per root (`KNOWLEDGE_MAX_CONCURRENT_SYNTHESIZES = 2`). Soft prefetch bounded to `active-file` or `active-module` scope only during idle windows. Staleness tracked via content hashes (nodes) and Merkle root comparison (modules).
- **Telemetry:** No outbound HTTP; replace with Output Channel logging + redacted debug bundle export
- **Webview transfer:** Chunked binary `ArrayBuffer` for graph payloads (no JSON), versioned protocol with magic bytes + version + kind + length header
- **Webview CSP:** `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data:; worker-src blob:; connect-src 'none';` — `unsafe-eval` forbidden
- **Graph view state:** `vscode.setState()` / `getState()` with versioned schema; discard unknown versions cleanly. Never call `setState()` during active binary transfer. Persist zoom, pan, selection, filters, and stable node positions.
- **Chat participant:** `@code-ingest` with slash commands — `/context`, `/focus`, `/impact`, `/explain`, `/depth`, `/search`, `/audit`, `/export current-context`. Participant is a RAG orchestrator, never returns raw TOON as main response. Stream answer via `ChatResponseStream.markdown()`, append footer after generation completes.
- **Model resolution:** For each request, resolve exact `LanguageModelChat` from `request.model` + `vscode.lm.selectChatModels({ vendor: 'copilot', family: request.model.family })`. Same instance for token counting AND `sendRequest()`.
- **Cancellation contract:** Pass `CancellationToken` into `sendRequest()`, `RelevanceWalker` checks between iterations, semantic workers accept cancellation metadata.
- **Root resolution order:** explicit file argument / command URI → active editor URI → current graph/sidebar selection → single root if only one exists → user-visible ambiguity response (never guess).
- **Workspace path validation:** Canonicalize with `fs.realpath`, compare containment with `path.relative`, reject traversal (UNC, absolute drives, URI-encoded escapes, symlinks, Windows normalization).
- **Semantic sidecar lifecycle:** Versioned, checksum-validated. Compaction triggered at `HNSW_COMPACTION_DOC_THRESHOLD = 5000` new docs or `HNSW_COMPACTION_STALENESS_RATIO = 0.3`. Corruption/checksum mismatch → quarantine + rebuild.
- **Initialization state machine:** `Trust-Locked` → `Not Initialized` (welcome card + CTA) → `Initializing` (progress + cancel) → `Ready` (full product surface). State scoped to active root; must not show Ready for one root while active surface belongs to an uninitialized root.

## Key Dependencies
| Package | Purpose |
|---|---|
| `wa-sqlite` | Asyncify-enabled WASM SQLite runtime |
| `web-tree-sitter` | AST parsing engine |
| `hnswlib-wasm` | Fast semantic nearest-neighbor retrieval |
| `@vscode/prompt-tsx` | Preferred structured prompt composition (spike-gated — must match direct serializer boundary safety) |
| `ignore` | `.gitignore` / `.codeingestignore` support |
| `minimatch` | Glob pattern matching |

**Minimum VS Code:** `^1.90.0`
**Max VSIX size:** < 15 MB

## Implementation Rules
- Complete phases 0–12 in order; finish all checkpoints before starting next phase
- New modules go in `src/graph/` (database, indexer, semantic, traversal), `src/services/security/`
- Webview assets live in `resources/webview/`, copied to `out/` via `npm run build:webview`
- Tree-sitter grammars resolve from `out/grammars/` via extension URI, not relative paths
- Shared constants (`VFS_DRAIN_TIMEOUT_MS`, `KNOWLEDGE_MAX_CONCURRENT_SYNTHESIZES`, `HNSW_COMPACTION_DOC_THRESHOLD`, `HNSW_COMPACTION_STALENESS_RATIO`) in `src/config/constants.ts`
- All host-webview messages use versioned envelopes with `version` field (extend `src/providers/messageEnvelope.ts`)
- Do not modify files excluded in `tsconfig.json` (deprecated/removed modules: old security services, remote repo services, etc.)
- Remove `native/**/*.node` from `package.json` `files` field before release (no native binaries per PRD)
- Existing native `GraphDatabase.ts` is a complete discard-and-replace target; reimplement over `wa-sqlite` + `VscodeAsyncVfs`
- PII must be handled pre-storage (not pre-prompt only): `content → PIIService → sanitized chunks → storage`

### Phase Reference (Key New Modules)
| Phase | Scope | Key New Modules |
|---|---|---|
| 0 | Workspace verification | Align on v1 architecture |
| 1 | Dependency reset, scaffold | `GrammarAssetResolver`, extend `constants.ts`, `.gitignore` |
| 2 | WASM SQLite storage | `schema.ts`, `GraphDatabase`, `VscodeAsyncVfs`, `SingleWriterQueue`, directory Merkle state |
| 3 | Tree-sitter ingestion | `PIIService`, `TreeSitterExtractor`, `DirtyBufferResolver`, `FileChunker`, `GraphIndexer` |
| 4 | Trust gate, reconciliation | `rootRuntimeRegistry`, `GitActivityMonitor`, `FileWatcher`, `extension.ts` bootstrap |
| 5 | Relevance, tokens, safety | `escapeHtml`, `RelevanceWalker`, `TokenBudgetService`, `ContextBuilder` |
| 6 | Semantic worker, knowledge | `SemanticIndexStore`, `SemanticIndexWorker`, `EmbeddingService`, `KnowledgeService` |
| 7 | Copilot chat participant | `languageModelResolver`, `copilotParticipant`, `package.json` contributions |
| 8 | Canvas graph view | `graphView.html/js/css`, `graph.worker.js`, binary protocol, theme sync, accessibility mirror |
| 9 | Sidebar, settings, commands | `sidebarProvider`, `settingsProvider`, root-aware command resolution, `messageEnvelope` extension |
| 10 | Export governance | `ExportController` (Raw/Clean/Graph), mandatory raw policy gate, selection export |
| 11 | Security hardening | `PIIService` policy finalization, telemetry stripping, runtime message validation, workspace path checks, prompt injection tests |
| 12 | Testing, packaging, release | Unit/integration/webview tests, VSIX packaging, CI matrix (Node 18/20, VS Code min/latest) |

## Test Requirements
- Jest requires `--experimental-vm-modules` and `--runInBand` flags
- Unit tests: `src/test/vnext/`
- Webview tests: `resources/webview/test/vnext/` (separate Jest config)
- Integration tests: `src/test/vnext/integration/`
- Integration tests run via `@vscode/test-electron`, require VS Code instance
- Validate no global file watchers, workspace path escapes, and XML boundary injection in tests
- Key integration test coverage: trusted/untrusted bootstrap, state transitions, multi-root disposal, dirty-buffer indexing, watcher scope allocation, git branch reconcile, embedding fallback, model resolution, cancellation propagation, raw export policy denial
