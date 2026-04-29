# Code-Ingest — Product Requirements Document (PRD)

**Version:** 1.2.4
**Last Updated:** April 2026
**Status:** Active Development

***

## 1. Product Overview

Code-Ingest is a local-first, GraphRAG-powered, Copilot-integrated architectural memory and guided development system. It builds a multi-layered representation of the current workspace and feeds it into GitHub Copilot Chat as structured, bounded, auditable context. The product is designed around real VS Code constraints: trusted-workspace gating, offline-safe local storage, bounded extension-host work, and graph-aware retrieval that remains usable on large repositories.

### Value Proposition

> **Standard `@workspace`:** Copilot sees only the files VS Code decides are relevant in the moment.
> **`@code-ingest`:** Copilot sees a ranked, graph-aware, semantically-seeded slice of the repository, with explicit context provenance and hard safety boundaries.

***

## 2. Target Users

- Individual developers working locally in VS Code
- Teams doing onboarding, impact analysis, audits, and architectural reviews
- Developers who use Copilot Chat and want structurally-aware answers with transparent retrieval

## 3. Non-Goals (Explicit Exclusions)

- **No remote ingestion.** No GitHub API calls, no URL-based repo cloning.
- **No Python backend.** The `code-ingest-master` Python server is fully discarded.
- **No native SQLite dependency in v1.** The product does not depend on `better-sqlite3`, `sqlite3`, or any platform-specific `.node` binding.
- **No always-on background summarization.** Knowledge synthesis is JIT and user- or query-triggered, not bulk autonomous post-index generation.
- **No outbound telemetry.** All outbound HTTP calls are removed from the extension codebase.
- **No blind token heuristics.** The system never uses `words * 1.3` or similar whitespace heuristics for Copilot payload enforcement.

## 4. Success Metrics

| Metric | Target |
|---|---|
| Cold-start index time (1,000-file TS project) | < 45 seconds |
| Delta reconcile after a normal save | < 2 seconds |
| Chat retrieval transparency latency | First progress update < 250ms |
| Context compression ratio | 35-50% reduction via TOON |
| Extension activation overhead | < 200ms before deferred work |
| Maximum VSIX size | < 15 MB |

***

## 5. Codebase Integration Plan

### 5.1 Source Repositories

The extension is built by modifying and extending the `code-ingest-demo-master` codebase. The `code-digest-main` codebase remains reference material for selective utility and UX patterns. The `code-ingest-master` Python backend is fully discarded.

### 5.2 Module Disposition Table

| Source Module | Disposition | Target Path | Notes |
|---|---|---|---|
| `code-ingest-demo-master/src/extension.ts` | Modify | `src/extension.ts` | Add trust-gated bootstrap, per-root runtime registry, workspace-folder lifecycle disposal, worker bootstrap, and chat participant wiring |
| `code-ingest-demo-master/src/commands/commandMap.ts` | Extend | `src/commands/commandMap.ts` | Add graph, export, trust, and knowledge command IDs; normalize on `codeIngest.*` command IDs and do not dual-register deprecated kebab-case aliases |
| `code-ingest-demo-master/src/commands/generateDigest.ts` | Keep | `src/commands/generateDigest.ts` | Retain legacy digest generation only as a compatibility wrapper that must route through `ExportController` Raw preview/policy flow |
| `code-ingest-demo-master/src/providers/codeIngestPanel.ts` | Adapt pattern | `src/providers/graphViewPanel.ts` | Reuse panel lifecycle pattern, not renderer architecture |
| `code-ingest-demo-master/src/providers/webviewHelpers.ts` | Keep as-is | `src/providers/webviewHelpers.ts` | Proven URI transform and CSP helper logic |
| `code-ingest-demo-master/src/providers/messageEnvelope.ts` | Extend | `src/providers/messageEnvelope.ts` | Add typed graph, sidebar, binary-transfer, and trust-state envelopes |
| `code-ingest-demo-master/src/controllers/sidebarController.ts` | Adapt | `src/controllers/sidebarController.ts` | Extend to root-aware sidebar orchestration |
| `code-ingest-demo-master/src/services/fileScanner.ts` | Keep | `src/services/fileScanner.ts` | Graph indexing MUST reuse this scanner |
| `code-ingest-demo-master/src/services/filterService.ts` | Keep and extend composition | `src/services/filterService.ts` | Combine `.gitignore`, `.codeingestignore`, `files.exclude`, `search.exclude`, and user patterns |
| `code-ingest-demo-master/src/services/gitignoreService.ts` | Extend | `src/services/gitignoreService.ts` | Add `.codeingestignore` resolution |
| `code-ingest-demo-master/src/services/cacheService.ts` | Adapt | `src/services/cacheService.ts` | Support rebuild-vs-reuse decisions for DB and semantic index sidecars |
| `code-ingest-demo-master/src/services/configurationService.ts` | Keep for digest only | `src/services/configurationService.ts` | `codeIngest.*` settings MUST use `vscode.workspace.getConfiguration('codeIngest')`, not this service |
| `code-ingest-demo-master/src/services/tokenAnalyzer.ts` | Rewrite | `src/services/tokenAnalyzer.ts` | Delegate to batched, model-aware token budgeting; remove `tiktoken` coupling |
| `code-ingest-demo-master/src/utils/redactSecrets.ts` | Keep as fallback library | `src/utils/redactSecrets.ts` | Used by the early PII pipeline and export sanitization fallback |
| `code-ingest-demo-master/src/utils/asyncPool.ts` | Keep as-is | `src/utils/asyncPool.ts` | Bound read/parse concurrency only; never concurrent writes |
| `code-ingest-demo-master/src/utils/errorHandler.ts` | Keep as-is | `src/utils/errorHandler.ts` | Async error normalization |
| `code-ingest-demo-master/src/config/constants.ts` | Extend | `src/config/constants.ts` | Add defaults for rendering budgets, chunk sizes, cooldowns, binary transport, `VFS_DRAIN_TIMEOUT_MS`, `KNOWLEDGE_MAX_CONCURRENT_SYNTHESIZES`, and HNSW compaction thresholds |
| `code-ingest-demo-master/src/services/telemetry/` | Strip outbound transport | `src/services/telemetry/` | Replace all network transport with local Output Channel logging |
| `code-ingest-demo-master/src/services/githubService.ts` | Remove | — | Remote ingestion excluded |
| `code-ingest-demo-master/src/services/remoteRepoService.ts` | Remove | — | Remote ingestion excluded |
| `code-ingest-demo-master/src/services/security/` | Remove old runtime security modules | — | Only the new `PIIService` remains under `src/services/security/` |
| `code-ingest-demo-master/src/types/tiktoken.d.ts` | Remove | — | No `tiktoken` dependency or heuristic adapter remains in v1 |
| `code-digest-main/src/utils/binary.ts` | Port to TS | `src/utils/binaryDetector.ts` | Binary file detection |
| `code-digest-main/src/utils/tokens.ts` | Reference only | — | Do not port its heuristic token estimator into v1 |
| `code-digest-main/src/panels/SidebarProvider.ts` | Reference | `src/providers/sidebarProvider.ts` | Sidebar view pattern only |
| `code-ingest-master/backend/app/chunker.py` | Reference only | — | Superseded by AST-enforced Tree-sitter chunking |
| `scripts/copyWebviewResources.js` | Extend | `scripts/copyWebviewResources.js` | Copy graph, settings, sidebar, worker, binary-protocol, and packaged grammar assets |

### 5.3 New Modules (Net-New Code)

| New Module | Responsibility |
|---|---|
| `src/graph/database/GraphDatabase.ts` | WASM SQLite bootstrap, Asyncify runtime integration over a Node `fs` random-access VFS, schema migration, and transactional CRUD; this is a complete rewrite target and must not reuse the native `better-sqlite3` implementation |
| `src/graph/database/VscodeAsyncVfs.ts` | Asyncify-compatible `wa-sqlite` VFS bridge that uses Node `fs.open`, `fs.read`, and `fs.write` for SQLite pager I/O and bypasses `vscode.workspace.fs` for the `.db` file |
| `src/graph/database/schema.ts` | Normative DDL for graph, chunk, knowledge, and semantic artifact metadata |
| `src/graph/database/SingleWriterQueue.ts` | Dedicated writer loop that flushes batched mutations inside one SQLite transaction |
| `src/graph/indexer/TreeSitterExtractor.ts` | Worker-safe AST parsing for supported languages via `web-tree-sitter`, using marshaled host buffers and resolved grammar URIs |
| `src/graph/indexer/GrammarAssetResolver.ts` | Resolves packaged grammar URIs from extension assets for worker-safe Tree-sitter loading |
| `src/graph/indexer/DirtyBufferResolver.ts` | Prefer open dirty editors over disk content during parse and retrieval |
| `src/graph/indexer/GitActivityMonitor.ts` | Detect branch switches / HEAD changes and pause incremental watchers during bulk git activity |
| `src/graph/indexer/GraphIndexer.ts` | Orchestrate scan → dirty-buffer resolve → worker parse dispatch → chunk → edge resolution → Merkle hash updates → write queue |
| `src/graph/indexer/FileWatcher.ts` | Debounced, coalescing `RelativePattern`-scoped watcher set that never writes directly |
| `src/graph/indexer/FileChunker.ts` | AST-enforced chunk generation with lineage metadata |
| `src/graph/semantic/SemanticIndexWorker.ts` | Background worker for embedding generation, HNSW maintenance, and semantic queries |
| `src/graph/semantic/SemanticIndexStore.ts` | Persist HNSW sidecar metadata, document mappings, checksum manifests, and compaction-threshold state |
| `src/graph/traversal/RelevanceWalker.ts` | Personalized PageRank / random-walk-with-restart relevance expansion |
| `src/graph/traversal/ContextBuilder.ts` | Internal TOON serializer with XML boundary escaping and token enforcement for model-bound retrieval payloads; prefer `@vscode/prompt-tsx` only if a boundary-isolation spike proves it preserves the same contract |
| `src/services/tokenBudgetService.ts` | Local batch estimation plus model-scoped `vscode.lm.countTokens()` verification and reserve enforcement |
| `src/services/embeddingService.ts` | Queue semantic work, manage cooldowns, and talk to the semantic worker |
| `src/services/knowledgeService.ts` | JIT summary generation, caching, stale marking, and refresh |
| `src/services/rootRuntimeRegistry.ts` | Adds/removes per-root runtimes on workspace-folder changes and disposes resources cleanly |
| `src/services/languageModelResolver.ts` | Resolves the exact chat model from `ChatRequest` for token counting, `sendRequest`, and streamed answer dispatch |
| `src/providers/graphViewPanel.ts` | Host-side graph panel controller for chunked binary transport and privileged actions |
| `resources/webview/graph/graphView.js` | Canvas UI bootstrap, theme sync, keyboard handling, state restore, and message glue |
| `resources/webview/graph/graph.worker.js` | Physics/layout worker, semantic zoom support, and binary payload decode |
| `src/providers/sidebarProvider.ts` | Root-aware sidebar state machine and export orchestration |
| `src/providers/settingsProvider.ts` | Settings panel webview |
| `src/services/exportController.ts` | Preview-first export orchestration with policy-enforced raw export gate |
| `src/services/security/piiService.ts` | Early secret/PII detection, masking, tagging, and retrieval policy enforcement |
| `src/utils/escapeHtml.ts` | Shared webview-safe string escaping helper |

***

## 6. Architecture Overview

### 6.1 High-Level Data Flow

```
Trusted workspace root opens
      │
      ▼
Root bootstrap (extension.ts)
      │
      ├─► Wasm GraphDatabase
      │        ├── graph.db                (Asyncify WASM SQLite over Node fs random-access VFS)
      │        └── semantic-index/         (HNSW sidecars + manifests)
      │
      ├─► GraphIndexer
      │        ├── FileScanner + FilterService
      │        ├── DirtyBufferResolver     (extension-host only)
      │        ├── Host-to-Worker Buffer Marshal
      │        ├── GrammarAssetResolver
      │        ├── TreeSitterExtractor     (worker-thread / WASM)
      │        ├── EdgeResolver
      │        ├── PIIService              (pre-storage sanitization)
      │        ├── FileChunker             (AST-complete chunks)
      │        ├── Directory Merkle Cascade
      │        └── SingleWriterQueue       (transactional writes only)
      │
      ├─► EmbeddingService + SemanticIndexWorker
      │        ├── host-side `vscode.lm.computeTextEmbedding()`
      │        ├── vector handoff to worker
      │        ├── HNSW index build/query
      │        └── idle / lazy embedding work
      │
      ├─► FileWatcher + GitActivityMonitor
      │        ├── RelativePattern-isolated watcher scopes
      │        ├── debounce + coalesce changes
      │        ├── pause during branch switch / mass rewrite
      │        └── enqueue reconciliation requests
      │
      ├─► Copilot Chat Participant (@code-ingest)
      │        ├── progress() updates
      │        ├── resolve exact LanguageModelChat
      │        ├── semantic seed search
      │        ├── RelevanceWalker (PPR / RWR)
      │        ├── local batch estimate + model-scoped token verify
      │        ├── ContextBuilder (TOON + XML boundaries)
      │        ├── construct LanguageModelChatMessage[]
      │        ├── LanguageModelChat.sendRequest(...)
      │        ├── stream answer via ChatResponseStream.markdown()
      │        └── append Context footer after generation
      │
      ├─► Graph View WebviewPanel
      │        ├── Canvas renderer on main webview thread
      │        ├── layout / physics in graph.worker.js
      │        ├── binary chunked IPC from host
      │        ├── state restore via setState/getState
      │        └── accessible off-screen mirror region
      │
      └─► ExportController
               ├── preview()
               ├── policy gate for Raw
               ├── Clean / Graph via ContextBuilder
               └── DigestGenerator only for permitted Raw mode
```

### 6.2 Unified Local Multi-Layer System

The system is composed of four persistent logical layers plus one sidecar retrieval layer:

- **Structural:** files, symbols, and relationships
- **Chunk:** AST-complete code and comment retrieval units
- **Lexical:** extracted terms and anchors for exact-match recall
- **Knowledge:** cached human-readable summaries and invariants
- **Semantic Sidecar:** HNSW indexes and manifests that accelerate vector retrieval outside SQLite

### 6.3 Storage Layout and Schema (Normative)

Each trusted workspace root stores its data in:

- `.vscode/code-ingest/graph.db`
- `.vscode/code-ingest/semantic-index/`

The SQLite file is managed by a WASM runtime and a Node-backed random-access VFS. It is the source of truth for graph topology, chunks, metadata, and cache state. The HNSW sidecar is the source of truth for fast vector retrieval.

The reference v1 storage runtime is an Asyncify-enabled `wa-sqlite` build. However, the SQLite pager for `.vscode/code-ingest/graph.db` MUST NOT use `vscode.workspace.fs` for page reads or writes because `workspace.fs` lacks offset-based partial-write semantics. A design that buffers the entire database and rewrites it on every transaction is out of spec.

The VFS layer MUST use Node's built-in `fs` module, via descriptor-based random-access operations such as `fs.open`, `fs.read`, and `fs.write` (or equivalent APIs with the same offset guarantees), so SQLite pager I/O can update only the required byte ranges. Asyncify remains required for the chosen `wa-sqlite` runtime integration, but `vscode.workspace.fs` is reserved for non-pager extension artifacts rather than SQLite page I/O.

The VFS implementation contract is strict: initialize the WASM module through a singleton promise, register `VscodeAsyncVfs` before any DB open, implement descriptor-backed `xOpen`, `xRead`, `xWrite`, `xTruncate`, `xSync`, `xFileSize`, `xDelete`, and `xAccess`, maintain an integer-handle-to-`FileHandle` map, and return SQLite error codes rather than raw Node errors. The DB wrapper is not a refactor of any existing native implementation.

#### Deterministic ID Contracts

- **Node ID:** `sha256(${workspaceRoot}::${relativePath}::${symbolName})`
- **Edge ID:** `sha256(${sourceId}::${targetId}::${type})`
- **Chunk ID:** `sha256(${fileNodeId}::${startLine}::${endLine})`

The `::` delimiter is mandatory across all implementations. No alternate delimiter is permitted. For file-level nodes, `symbolName` MUST be the empty string so the trailing delimiter is preserved: `sha256(${workspaceRoot}::${relativePath}::)`.

#### Core Tables

**`nodes`**

| Column | Type | Constraint | Description |
|---|---|---|---|
| `id` | TEXT | PRIMARY KEY | Deterministic node hash |
| `type` | TEXT | NOT NULL | `file`, `function`, `class`, `interface`, `method`, `knowledge`, `module_summary` |
| `label` | TEXT | NOT NULL | Display label |
| `file_path` | TEXT | NOT NULL | Absolute file path |
| `relative_path` | TEXT | NOT NULL | Workspace-relative path |
| `start_line` | INTEGER | | Start line |
| `end_line` | INTEGER | | End line |
| `language` | TEXT | | Language identifier |
| `last_indexed` | INTEGER | NOT NULL | Unix timestamp in ms |
| `hash` | TEXT | NOT NULL | Content hash used for staleness detection |
| `metadata` | TEXT | | JSON blob |

**`edges`**

| Column | Type | Constraint | Description |
|---|---|---|---|
| `id` | TEXT | PRIMARY KEY | Deterministic edge hash |
| `source_id` | TEXT | NOT NULL, FK → `nodes(id)` ON DELETE CASCADE | Source node |
| `target_id` | TEXT | NOT NULL, FK → `nodes(id)` ON DELETE CASCADE | Target node |
| `type` | TEXT | NOT NULL | `import`, `call`, `inheritance`, `implements`, `contains`, `knowledge_of` |
| `weight` | REAL | DEFAULT 1.0 | Edge strength |
| `metadata` | TEXT | | JSON blob with reason, confidence, and excerpt metadata |

#### Chunk Tables

Both chunk tables MUST include explicit cascading foreign keys and are invalid without them.

**`code_chunks`**

| Column | Type | Constraint | Description |
|---|---|---|---|
| `id` | TEXT | PRIMARY KEY | Deterministic chunk hash |
| `file_node_id` | TEXT | NOT NULL, FK → `nodes(id)` ON DELETE CASCADE | Owning file or symbol node |
| `start_line` | INTEGER | NOT NULL | Start line |
| `end_line` | INTEGER | NOT NULL | End line |
| `content` | TEXT | NOT NULL | Original chunk text |
| `lineage` | TEXT | | Module/class/function ancestry used for semantic enrichment |
| `pii_detected` | INTEGER | DEFAULT 0 | PII flag |
| `pii_redacted_content` | TEXT | | Sanitized content |

**`comment_chunks`**

| Column | Type | Constraint | Description |
|---|---|---|---|
| `id` | TEXT | PRIMARY KEY | Deterministic chunk hash |
| `file_node_id` | TEXT | NOT NULL, FK → `nodes(id)` ON DELETE CASCADE | Owning node |
| `start_line` | INTEGER | NOT NULL | Start line |
| `end_line` | INTEGER | NOT NULL | End line |
| `content` | TEXT | NOT NULL | Comment/documentation chunk |
| `lineage` | TEXT | | Structural ancestry |
| `pii_detected` | INTEGER | DEFAULT 0 | PII flag |
| `pii_tags` | TEXT | | JSON array of detected tags |

#### Knowledge and Lexical Tables

- `knowledge_chunks(id, node_id, summary, invariants, pii_detected, pii_redacted_summary, created_at, stale)`
- `knowledge_links(knowledge_id, source_chunk_id)`
- `terms(id, term, frequency)`
- `term_links(term_id, node_id)`
- `module_summaries(id, module_path, summary, file_count, source_merkle_root, created_at, stale)`

**`directory_state`**

| Column | Type | Constraint | Description |
|---|---|---|---|
| `relative_path` | TEXT | PRIMARY KEY | Workspace-relative directory path |
| `parent_relative_path` | TEXT | | Parent directory path |
| `merkle_hash` | TEXT | NOT NULL | Derived hash from sorted child file and child directory hashes |
| `child_count` | INTEGER | NOT NULL | Direct child entry count |
| `updated_at` | INTEGER | NOT NULL | Last recalculation timestamp |

Directory staleness is determined with Merkle-style hashing. Whenever a file hash is inserted, changed, or deleted, the indexer MUST recalculate its parent directory hash and cascade that update upward until the root stabilizes. `module_summaries.source_merkle_root` is compared against `directory_state.merkle_hash` to determine module-summary staleness in $O(1)$ time during retrieval.

#### State and Semantic Artifact Tables

**`index_state`**

| Column | Type | Constraint | Description |
|---|---|---|---|
| `workspace_hash` | TEXT | PRIMARY KEY | Root hash |
| `last_full_index` | INTEGER | | Last successful full index |
| `node_count` | INTEGER | | Node count |
| `edge_count` | INTEGER | | Edge count |
| `schema_version` | INTEGER | NOT NULL | Schema migration marker |
| `git_head` | TEXT | | Last observed HEAD commit |

**`embedding_document_metadata`**

| Column | Type | Constraint | Description |
|---|---|---|---|
| `id` | TEXT | PRIMARY KEY | Stable embedding document ID |
| `kind` | TEXT | NOT NULL | `code`, `comment`, `knowledge`, `module_summary` |
| `source_table` | TEXT | NOT NULL | Origin table |
| `source_id` | TEXT | NOT NULL | Origin row ID |
| `content_hash` | TEXT | NOT NULL | Hash of embedded content |
| `artifact_key` | TEXT | NOT NULL | Sidecar artifact reference |
| `last_embedded` | INTEGER | | Timestamp |

This metadata table never stores embedding vectors. Vectors live exclusively in versioned HNSW sidecar files under `semantic-index/`.

**`artifact_state`**

| Column | Type | Constraint | Description |
|---|---|---|---|
| `artifact_key` | TEXT | PRIMARY KEY | Sidecar key |
| `kind` | TEXT | NOT NULL | `semantic-hnsw`, `layout-cache`, `knowledge-cache` |
| `backend` | TEXT | NOT NULL | `hnswlib-wasm` or equivalent |
| `artifact_path` | TEXT | NOT NULL | Relative artifact path |
| `doc_count` | INTEGER | | Indexed documents |
| `updated_at` | INTEGER | | Last update time |

Semantic sidecars are versioned artifacts. Startup MUST validate sidecar version and checksum before use, quarantine unreadable or mismatched artifacts, and trigger a rebuild rather than serving partially-corrupt semantic results. Periodic compaction/rebuild is required because HNSW append behavior degrades over time.

### 6.4 Persistence, Dirty Buffers, and Git Awareness

The system stores only the current repository state. There is no versioned historical graph in v1.

#### Mandatory Activation Sequence

1. Register trust and workspace-folder lifecycle listeners synchronously before any async bootstrap begins.
2. Check `vscode.workspace.isTrusted`; if false, stop at trust-locked UI state.
3. Create or reuse one dispose-capable `RootRuntime` per trusted workspace root.
4. Open the Asyncify-backed SQLite database through the Node `fs` random-access VFS and open sidecar manifests for each trusted workspace root.
5. Compile watcher scopes from exclusions and start only `RelativePattern`-isolated watchers for allowed source areas.
6. If `schema_version` changed, run a full rebuild.
7. Compare current files against `index_state`, `mtimeMs`, stored file hashes, and cached directory Merkle hashes.
8. If a file is open and dirty, resolve the editor buffer on the extension host, compute its hash there, and marshal the parse payload to the worker.
9. If the Git monitor detects a branch switch, pull, or mass rewrite, pause incremental watchers and run bulk reconciliation after the change set settles.
10. All writes flow through one per-root single-writer queue. Read/parse work may be concurrent; SQLite writes may not be.

#### Dirty Buffer and Worker Boundary

`DirtyBufferResolver` runs on the extension host because the `vscode` namespace is not available inside background workers. The parse worker MUST never call `vscode.workspace.textDocuments`, `document.getText()`, or any other `vscode` API directly.

The required parse-dispatch contract is:

`GraphIndexer (host)` → `DirtyBufferResolver (host)` → marshal `{ filePath, relativePath, languageId, content, contentSource, grammarUri }` → `TreeSitterExtractor worker`

The marshaled payload may be sent as a string or transferable byte buffer, but the dirty-buffer decision itself must stay on the host side. Dirty-buffer snapshots MUST carry a snapshot hash and timestamp; if disk `mtimeMs` advances before commit, the dirty-buffer write is discarded and the file is re-queued from disk.

#### Workspace Lifecycle and Disposal

Per-root runtimes are long-lived resources and MUST implement an explicit disposal contract. When a workspace folder is removed, the runtime registry must immediately:

- close the root DB handle
- flush and stop the single-writer queue
- terminate semantic and parse workers owned by that root
- dispose file watchers and event subscriptions
- release cached manifests and in-memory graph state

Removed workspace roots must not leave behind locked DB files, orphaned workers, or active watchers.

#### Queue Guarantees

- Full rebuilds, delta updates, and watcher batches are serialized.
- The queue batches writes in short windows with explicit thresholds: a time window of roughly `5-20ms` and a maximum operations-per-flush cap.
- While a write is active, later requests are coalesced by `filePath` and prioritized as `HIGH` (active file), `MEDIUM` (recent changes), and `LOW` (background rebuild).
- The queue applies bounded backpressure and cancellation. Superseded low-priority deltas may be merged, but active-file work must not be starved.
- Flushes occur inside one SQLite transaction per batch.
- No queue path may commit `last_full_index` for partial work.
- `GraphDatabase` public writes are exclusive to `SingleWriterQueue.executeWriteBatch(...)`; other callers get read-only APIs.
- The queue MUST await Asyncify VFS drain after each write batch before accepting the next write batch.
- VFS drain waits are bounded by `VFS_DRAIN_TIMEOUT_MS` with a default of `5000`; if the timeout wins, the root runtime emits an Output Channel warning and enters a degraded-but-not-disposed state.
- During a full rebuild, watcher deltas are held in a pending set until rebuild completion and diffed before enqueue.
- Directory Merkle updates for changed files are committed in the same serialized mutation flow as node and chunk updates.
- Read paths that inspect Merkle state during knowledge refresh must coordinate with the writer queue and must not observe half-applied write batches.
- `SingleWriterQueue` MUST expose `waitForQuiescent(): Promise<void>` or an equivalent read-side quiescence API so `KnowledgeService` can wait for an idle write generation before reading Merkle state.
- SQLite page writes must remain offset-based; the writer queue must not perform whole-file database rewrites for ordinary transactions.

### 6.5 Semantic Retrieval and Token Budgeting

#### Embedding Strategy

- Primary embedding source: `vscode.lm.computeTextEmbedding()` on the extension host
- `SemanticIndexWorker` never calls `vscode` APIs directly; `EmbeddingService` computes vectors on the host and sends them to the worker over a message channel
- `EmbeddingService` runs an `embeddingAvailabilityProbe()` during first activation and surfaces the result in the sidebar and diagnostics bundle
- Embeddings are computed lazily and maintained in a background worker
- The worker persists fast-search structures in HNSW sidecars, not SQLite vector tables
- Lexical + structural retrieval is a first-class path when embeddings are unavailable, cooling down, or policy-restricted

#### Active Model Resolution

There is no implicit global active model contract for chat payload sizing. For each `@code-ingest` request, the participant MUST resolve the exact `LanguageModelChat` instance from the incoming `vscode.ChatRequest` before token counting or prompt submission.

The normative flow is:

1. inspect `request.model`
2. query `vscode.lm.selectChatModels({ vendor: 'copilot', family: request.model.family })`
3. bind the chosen `LanguageModelChat` instance to the current request
4. use that same model instance for token counting and final send

Silently token-counting against an unrelated default model is out of spec.

#### Rate Limiting and Availability

- `codeIngest.embedding.maxRetries`: default `3`
- `codeIngest.embedding.cooldownMs`: default `300000`
- Embedding availability uses an atomic state machine: `idle`, `active`, `cooldown`
- After three consecutive failures, semantic retrieval is disabled until cooldown expires or a later call succeeds

#### Token Budgeting

- Chat payload limits are enforced with `vscode.lm.countTokens()` against the resolved request model
- The system reserves a configurable output/system margin before sending context
- The effective reserve is dynamic: `max(codeIngest.copilot.reserveTokensPercent, reserve floor)` where the floor is derived from `codeIngest.copilot.reserveTokensMin` and may be raised for long-form or high-risk requests
- If the payload is too large, distant or low-relevance nodes are summarized before raw content is dropped
- `ContextBuilder` must not await `countTokens()` inside a per-chunk or per-edge loop
- The required strategy is batched token verification: greedily assemble a candidate block with a fast local estimator (for example, character count divided by 4), then perform one model-scoped `countTokens()` call to verify the whole candidate block
- Candidate blocks are assembled per relevance tier; `TokenBudgetService.canAdd()` is called only when a block is complete, never after each individual node or chunk append
- If the candidate block is too large, trim locally and re-verify; repeated IPC calls per individual chunk are forbidden
- `words * 1.3` or any whitespace-based heuristic is forbidden for chat payload enforcement

#### Retrieval Ranking

The ranking pipeline is:

1. semantic seed hits (when available)
2. lexical hits
3. Personalized PageRank / random walk with restart over the graph
4. locality, symbol type, and confidence adjustments

This replaces naive BFS expansion as the primary ranking algorithm. Simple depth caps still exist for UI display and export scoping, but retrieval relevance is graph-ranked, not frontier-ordered.

***

## 7. Feature Specifications

### 7.1 Trust-Gated Bootstrap and Auto-Indexing

Graph features only activate in trusted workspaces. Until trust is granted, the extension must block:

- graph DB creation
- semantic index creation
- file watching
- graph exports
- knowledge synthesis
- `@code-ingest` context injection
- graph-view privileged actions

Auto-indexing runs per trusted workspace root and reuses `FileScanner` plus `FilterService`. Graph settings MUST come from `vscode.workspace.getConfiguration('codeIngest')`, never from the base `ConfigurationService`.

#### Exclusion Precedence

1. hardcoded defaults: `node_modules`, `.git`, `dist`, `build`, `out`, `.venv`, `coverage`, generated cache folders
2. `.gitignore`
3. `.codeingestignore`
4. VS Code `files.exclude`
5. VS Code `search.exclude`
6. user `codeIngest.indexing.excludePatterns`

#### Resource Guards

- file size cap: default `5 MB`
- workspace cap: default `10,000 files`
- read/parse concurrency is bounded
- content is streamed or chunked; the indexer does not buffer the entire repository in memory

### 7.2 File Watching and Change Coalescing

The watcher system must not register a global `vscode.workspace.createFileSystemWatcher('**/*')`. Watchers are created only after exclusions are resolved, and only for allowed source scopes.

- watcher instantiation uses `vscode.RelativePattern` objects scoped to valid source directories or file groups
- ignored directories such as `node_modules`, `.git`, `dist`, `build`, and generated cache folders are excluded before OS watcher registration
- multiple scoped watchers may exist per root; they are coordinated behind one root runtime
- default debounce: `800 ms`
- changes and deletes are batched
- later batches are merged if a write is already active
- git activity can temporarily pause watcher processing
- mass changes trigger reconciliation instead of a storm of per-file rewrites

### 7.3 Tree-Sitter Extraction and AST Chunking

v1 uses `web-tree-sitter` as the normative extraction engine.

- dirty-buffer inspection is a host-only responsibility; parse workers receive marshaled content rather than querying the editor themselves
- parse workers never access the `vscode` namespace directly
- grammar assets are resolved from packaged extension paths such as `vscode.Uri.joinPath(context.extensionUri, 'out', 'grammars', '<grammar>.wasm').fsPath`, or an equivalent worker-safe resource mapping; relative runtime paths like `./tree-sitter-typescript.wasm` are out of spec
- supported languages are parsed with bundled WASM grammars
- symbol extraction, containment, and chunk boundaries come from ASTs
- no language server is required for indexing
- if a grammar is unavailable, the file degrades to a file-level node and comment/code chunk extraction may fall back to line-safe parsing

Chunking is AST-enforced where possible. A chunk must never cut a method, function, or class body in half when an AST is available.

### 7.4 Node Model

Node types:

- `file`
- `function`
- `class`
- `interface`
- `method`
- `knowledge`
- `module_summary`

Knowledge and module-summary nodes are first-class and remain filterable in the UI. They are connected back to source code with `knowledge_of` edges.

### 7.5 Edge Model

Edge types:

- `import`
- `call`
- `inheritance`
- `implements`
- `contains`
- `knowledge_of`

Default weights are part of the retrieval contract and feed `RelevanceWalker` unless an extractor supplies a stronger domain-specific value:

| Edge Type | Default Weight |
|---|---:|
| `call` | `1.0` |
| `inheritance` | `0.9` |
| `implements` | `0.8` |
| `import` | `0.7` |
| `contains` | `0.5` |
| `knowledge_of` | `1.2` |

Each edge may include `metadata.reason`, `metadata.confidence`, and `metadata.sourceExcerpt` so the UI can explain why an edge exists. Weightless edges are out of spec because they collapse PPR into an almost-uniform walk.

Circular dependencies are stored as normal edges plus derived cycle metadata. The badge position is the **top-right corner of the node**.

### 7.6 Relevance Walker and Traversal Semantics

`RelevanceWalker` replaces BFS as the default retrieval strategy for chat and semantic export.

- seed set: semantic hits, lexical hits, active node, and explicit user target
- algorithm: Personalized PageRank / random walk with restart
- super-node penalty: high-degree utility hubs are down-weighted unless reinforced by lexical/semantic evidence
- `GraphTraversal` may remain as a low-level edge traversal primitive, but chat, export, and Copilot flows MUST call `RelevanceWalker` rather than BFS directly
- display depth: still exposed in the UI for user comprehension and scoping

### 7.7 Context Builder for Copilot

`ContextBuilder` produces an internal TOON payload with strict separation between trusted instructions and untrusted repository content. That payload is input to model inference, not the primary user-visible response.

Preferred implementation path: use `@vscode/prompt-tsx` only if a spike proves its component model can preserve the same XML-boundary isolation, provenance footer, and role layout guarantees. The acceptance criterion is strict: one repository content block wrapped through the TSX path must pass the `escapeHtml` boundary-collision fixtures unchanged. If the spike fails, a manual serializer is mandatory.

#### Mandatory Rules

1. **Streaming order:** knowledge chunks, comment chunks, code chunks, graph edges
2. **Progress hooks:** retrieval emits `ChatResponseStream.progress()` updates such as `Searching semantic index...`, `Ranking graph neighborhood...`, `Compressing context...`
3. **Prompt isolation:** every repository chunk is wrapped in randomized XML tags such as `<rcc_a1b2c3d4>` and the source content is entity-encoded so repository text cannot close or spoof those tags; boundary tags use `8` hex characters generated with `crypto.getRandomValues(new Uint8Array(4))` and are regenerated each chat turn. `Math.random()` is out of spec.
4. **Exact model resolution:** payload admission resolves the exact request model from `ChatRequest.model` and `vscode.lm.selectChatModels()` before counting or send
5. **Batched token verification:** candidate blocks are assembled with a fast local estimator and verified with model-scoped `vscode.lm.countTokens()`; per-chunk `countTokens()` loops are forbidden, and `TokenBudgetService.canAdd()` is called only after a relevance-tier block is complete
6. **Inference execution:** the final TOON payload is wrapped into `vscode.LanguageModelChatMessage[]` and passed to `LanguageModelChat.sendRequest(...)`; raw TOON must not be emitted as the primary chat answer
7. **Footer transparency:** every response includes the exact footer shape below, appended after model generation completes

#### Context Footer Format

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

### 7.8 Canvas/Web Worker Graph Visualization

The graph view opens as a `WebviewPanel` and uses a Canvas renderer on the main thread plus a dedicated `graph.worker.js` for layout and physics.

#### Rendering Architecture

- host → webview transfer uses chunked binary payloads, not giant JSON object graphs
- webview main thread paints Canvas and handles interaction
- worker thread computes layout, force steps, and batch updates
- semantic zoom / level-of-detail reduces label and edge rendering when zoomed out
- theme colors are read from VS Code CSS variables at runtime and re-read on theme mutation

#### Initial Load Contract

- first paint sends the active file ego-graph plus core neighbors, capped by `codeIngest.graph.initialBatchNodes` with a default of `250`
- additional graph batches stream in chunks
- the panel must never block on a full-graph structured-clone transfer

#### State and Accessibility

- `vscode.setState()` / `getState()` persist zoom, pan, selection, filters, and stable node positions
- an off-screen accessible mirror or aria-live region reflects currently focused/selected nodes and their relationships

#### Interaction Contract

- single click: select node and open detail panel
- double click: open file at the relevant line
- edge click: open edge-detail popover
- right click: context menu with `Explain this file`, `Show dependencies`, `Find dependents`, `Ask Code-Ingest AI`, `Open file`, `Copy relative path`, `Export this context`, `Generate knowledge`, and `Refresh knowledge`
- ctrl/cmd click: multi-select
- `Ctrl+Shift+E`: export selection

#### Empty States

The graph panel must explicitly render:

- trust-locked
- not initialized
- indexing in progress
- filter-empty
- no supported files
- DB/index error

### 7.9 Sidebar Panel

The sidebar remains the canonical UI and operates in four states:

- `Trust-Locked`
- `Not Initialized`
- `Initializing`
- `Ready`

#### Ready-State Sections

1. system status
2. active file context
3. export panel
4. retrieval controls and context-window indicator
5. exclusion patterns
6. knowledge cache status and embedding availability
7. diagnostics actions and open graph view

Because knowledge is JIT in v1, the knowledge section surfaces cache freshness and explicit generate/refresh actions only for the current node, module, or selection. It does not offer autonomous whole-repo synthesis.

#### Sidebar and Graph Selection Sync

- when the graph view has one or more selected nodes, the sidebar Export panel promotes `Export X selected nodes` as the primary action
- when the graph view is closed or nothing is selected, the sidebar falls back to the active editor context
- the sidebar export panel includes a PII policy selector, format selector, size estimate in bytes, token estimate, and a mandatory `Preview` action
- changes to PII policy or export scope propagate immediately between the host, sidebar, and graph toolbar
- the Ready state mirrors current context-window usage before the user triggers chat or export
- the context-window indicator is live and is driven by `TokenBudgetService.estimate(...)` updates delivered through the sidebar message envelope contract

### 7.10 GitHub Copilot Chat Participant

#### Identity

- **ID:** `code-ingest`
- **Invocation:** `@code-ingest`

#### Slash Commands

| Command | Description | Behavior |
|---|---|---|
| `/context [file?]` | Inject ranked repository context | Uses active file when no argument is supplied |
| `/focus <file>` | Re-center graph on a file | Opens graph panel and focuses the target |
| `/impact` | Impact analysis | Ranks likely dependents and affected contracts |
| `/explain` | Explain current graph slice | Uses current node/selection and fresh knowledge when available; stale summaries are annotated and refreshed on demand |
| `/depth <n>` | Override display depth | Temporary override for one query |
| `/search <query>` | Semantic + lexical search | Uses worker-backed semantic index when available |
| `/audit` | Architecture audit | Compares graph reality, cached knowledge, and current prompt target, then lists discrepancies |
| `/export current-context` | Export current slice | Routes through preview-first export flow |

When the Language Model Tool API is available, these capabilities SHOULD also be registered as explicit `vscode.lm.tools`. Tool registration is additive and does not authorize implicit graph-context injection into unrelated chat prompts.

#### Pre-Flight Checks

- if the workspace is untrusted, the participant returns a trust-gate response instead of throwing
- if the graph is not initialized, the participant returns an initialization prompt and links back to the sidebar CTA
- if the DB or sidecars are unreadable, the participant returns an error plus a `Show Logs` path
- if no matching `LanguageModelChat` is available, the participant returns a user-visible model-resolution failure

#### Query Handling Flow

1. run pre-flight checks for trust, graph readiness, DB readability, and model availability
2. resolve active root, active file, trust state, and the exact request model
3. emit progress hook
4. gather semantic and lexical seeds
5. run `RelevanceWalker`, honoring cancellation between ranking iterations
6. optionally fetch or refresh JIT knowledge for the focused node/module, validating module summaries against the cached directory Merkle root
7. build TOON candidate blocks with XML boundaries and local token estimation
8. verify and compress with model-scoped `countTokens()`
9. construct `vscode.LanguageModelChatMessage[]` that combine the developer's chat query and the TOON retrieval payload in the chosen role arrangement
10. call `LanguageModelChat.sendRequest(messages, {}, token)` on the resolved model
11. stream the model-generated answer chunks through `ChatResponseStream.markdown()`
12. append the provenance footer after the model response completes

#### Cancellation Contract

- pass the `CancellationToken` into `LanguageModelChat.sendRequest(...)`
- `RelevanceWalker` checks cancellation between scoring iterations
- semantic worker requests accept cancellation metadata and abort pending queries when possible
- if cancellation occurs before send, the participant responds with `Retrieval cancelled.`

The participant is a RAG orchestrator, not an extraction utility. It must never return the raw TOON payload as the main response body.

### 7.11 Settings Panel

All `codeIngest.*` settings are stored in workspace settings via `vscode.workspace.getConfiguration('codeIngest')`.

#### Core Settings

**Storage & indexing**

- `codeIngest.indexing.maxFileSizeKB`: default `5120`
- `codeIngest.indexing.maxFiles`: default `10000`
- `codeIngest.indexing.watcherDebounceMs`: default `800`
- `codeIngest.indexing.excludePatterns`: string[]
- `codeIngest.indexing.pauseDuringGitOperations`: default `true`

**Retrieval**

- `codeIngest.graph.hopDepth`: default `3`
- `codeIngest.graph.defaultNodeMode`: `'file' | 'function'`
- `codeIngest.graph.initialBatchNodes`: default `250`
- `codeIngest.graph.transportChunkSizeKB`: default `256`
- `codeIngest.graph.enableSemanticZoom`: default `true`

**Copilot integration**

- `codeIngest.copilot.includeSourceContent`: default `true`
- `codeIngest.copilot.reserveTokensPercent`: default `30`
- `codeIngest.copilot.reserveTokensMin`: default `1024`
- `codeIngest.copilot.semanticResultCount`: default `5`
- `codeIngest.copilot.redactSecrets`: default `true`

**Embedding**

- `codeIngest.embedding.maxRetries`: default `3`
- `codeIngest.embedding.cooldownMs`: default `300000`

**Knowledge**

- `codeIngest.knowledge.mode`: `'jit'` (default)
- `codeIngest.knowledge.cooldownMs`: default `2000`
- `codeIngest.knowledge.softPrefetchMode`: `'off' | 'active-file' | 'active-module'` (default `'active-file'`)
- `codeIngest.knowledge.maxConcurrentSyntheses`: default `2`
- `codeIngest.knowledge.modelChoice`: string or `auto`

**Export governance**

- `codeIngest.allowRawExport`: default `false`

**Security settings**

- `codeIngest.pii.mode`: `'strict' | 'mask' | 'allow'` (default `'mask'`)
- `codeIngest.pii.strictForExport`: default `true`

**Display**

- `codeIngest.display.focusModeOpacity`: default `0.15`
- `codeIngest.display.autoFocusOnEditorChange`: default `true`

### 7.12 Commands Palette

| Command ID | Description |
|---|---|
| `codeIngest.initializeCodebase` | Build or rebuild the graph for the resolved root |
| `codeIngest.rebuildGraph` | Force full reconciliation |
| `codeIngest.openGraphView` | Open the graph panel |
| `codeIngest.focusCurrentFile` | Focus the graph on the active editor |
| `codeIngest.openSettings` | Open Code-Ingest settings |
| `codeIngest.sendToChat` | Send current file or selection to Copilot |
| `codeIngest.showLogs` | Show the Output Channel |
| `codeIngest.exportGraphPng` | Export the visible graph canvas |
| `codeIngest.exportRaw` | Export raw digest when policy allows |
| `codeIngest.exportClean` | Export sanitized workspace context |
| `codeIngest.exportGraph` | Export targeted graph context |
| `codeIngest.synthesizeKnowledge` | Generate or refresh knowledge for the active node or selection |

Legacy `code-ingest.*` IDs may be documented in release notes for migration, but v1 must not dual-register them as active command aliases.

### 7.13 Unified Export System

The export engine is preview-first and policy-aware.

#### Modes

| Mode | Backend | Use Case |
|---|---|---|
| Raw | `ExportController` → `DigestGenerator` | Internal backup only, policy-gated |
| Clean | `ContextBuilder` + sanitized workspace scope | Sharing or AI ingestion |
| Graph | `RelevanceWalker` + `ContextBuilder` | Targeted architecture export |

#### Mandatory Raw Export Gate

Raw export is blocked unless `codeIngest.allowRawExport === true` after settings and policy resolution. If raw export is disabled by policy, the UI must not fall back to warning-only behavior.

Flow:

1. build preview
2. user confirms preview
3. if mode is Raw, enforce policy gate
4. if permitted, show raw warning modal
5. execute export

Any retained legacy `generateDigest` command is a compatibility shim only and MUST call the same `ExportController` Raw path. Raw export policy may not be bypassed by an older command entrypoint.

### 7.14 JIT Knowledge Synthesis

Knowledge generation is explicit and demand-driven in v1.

#### Triggers

- user opens a node detail panel with no cached summary
- user explicitly clicks Generate or Refresh
- chat flow requests explanation/audit context and the target summary is missing or stale

#### Rules

- no autonomous whole-repo summarization after indexing
- JIT remains the default, but bounded soft prefetch may synthesize active-file or active-module summaries during idle windows after the base graph is ready
- cache summaries in SQLite
- mark cached node summaries stale when source hashes change and mark module summaries stale when `module_summaries.source_merkle_root` no longer matches `directory_state.merkle_hash`
- knowledge synthesis is concurrency-limited per node or module, with a shipped default of `KNOWLEDGE_MAX_CONCURRENT_SYNTHESIZES = 2` so one busy file cannot block the entire root
- `KnowledgeService` waits for `SingleWriterQueue.waitForQuiescent()` before reading `directory_state.merkle_hash` for staleness checks

### 7.15 Database and Index Lifecycle Management

The extension checks the WASM SQLite file size and semantic sidecar size after indexing. When thresholds are exceeded, the user is prompted to clean stale knowledge caches or rebuild semantic sidecars. Structural graph data is not silently discarded.

Semantic sidecar lifecycle requirements:

- HNSW files are versioned and paired with checksum manifests
- sidecars are periodically compacted or rebuilt instead of growing without bound
- rebuilds are triggered when `HNSW_COMPACTION_DOC_THRESHOLD = 5000` new or replaced documents accumulate or when `HNSW_COMPACTION_STALENESS_RATIO = 0.3` is exceeded
- corruption or checksum mismatch triggers quarantine plus explicit rebuild
- rebuild prompts must be user-visible and explain whether only semantic artifacts or the full graph are affected

### 7.16 Diagnostics and Supportability

The product ships without outbound telemetry, but it must remain debuggable locally.

- structured local logs are written to the Output Channel and persisted in a bounded local diagnostics directory
- users can export a redacted debug bundle that includes configuration, queue state, semantic sidecar manifest state, embedding availability, and recent errors
- debug bundles must not contain raw repository content unless the current PII/export policy explicitly allows it

### 7.17 Initialization State Machine and First-Run Experience

The sidebar follows a strict initialization-first state machine:

- `Trust-Locked`: workspace trust is missing; only trust guidance is shown
- `Not Initialized`: no usable graph exists; the sidebar shows a welcome card with `Initialize Codebase` as the primary CTA and hides the rest of the product surface
- `Initializing`: the first full index is running; progress, cancellation, and current phase are shown while feature sections remain hidden
- `Ready`: full sidebar, graph view, retrieval, export, and diagnostics surfaces are available

State transitions:

- `Not Initialized` → `Initializing`: user starts initialization
- `Initializing` → `Ready`: first successful full index completes
- `Initializing` → `Not Initialized`: user cancels or initialization fails before a valid graph is committed
- any state → `Trust-Locked`: workspace trust is revoked
- `Trust-Locked` → `Not Initialized` or `Ready`: trust is restored and the graph is absent or valid, respectively

First-run experience requirements:

- detect first successful initialization with `globalState.get('code-ingest.hasInitialized')`
- on first activation, show a purpose statement, three feature highlights, and a single initialization CTA
- after the first successful index, set `code-ingest.hasInitialized = true`
- the welcome card does not reappear on later activations
- extension updates may show an inline `What's New` notification that auto-dismisses

***

## 8. Security and Privacy

### 8.1 Data Locality

All graph data, semantic artifacts, and cached knowledge remain under `.vscode/code-ingest/` inside the trusted workspace root. The extension makes no outbound network requests except local VS Code-to-Copilot API calls.

### 8.2 PII and Secret Handling

PII and secret handling is shifted left:

`File/Dirty Buffer → PIIService → Sanitized Chunks → Storage → Retrieval → Export`

Repository content is sanitized before storage, not only before prompt injection. Retrieval may apply an additional policy-specific recheck, but pre-storage sanitization is mandatory. Policy modes are `strict`, `mask`, and `allow`, with `strict` forced automatically for governed export paths when `codeIngest.pii.strictForExport` is enabled.

### 8.3 Prompt Injection Isolation

Repository code and comments are untrusted input. The context builder must:

- wrap each injected chunk in randomized XML boundaries with `8` hex characters per turn
- entity-encode any matching or prefix-colliding boundary text already present in repository content, including `rcc_[0-9a-f]{8}`-style prefixes
- keep system instructions outside repository-tagged regions

### 8.4 Workspace Trust and Host Privileges

Webviews never perform privileged actions directly. File open, export, clipboard, reveal-in-explorer, and indexing operations are host-only and require validated messages plus workspace-local path checks.

Workspace-local path validation is mandatory:

- normalize incoming paths with `path.resolve(root, rawPath)`
- reject traversal outside the trusted root, including UNC paths, absolute drive escapes, and URI-encoded traversal attempts
- reject privileged operations when the resolved path does not stay under the active trusted root

### 8.5 Graph Webview CSP

The graph webview must ship with an explicit Content Security Policy equivalent to:

```text
default-src 'none';
script-src 'nonce-${nonce}';
style-src 'unsafe-inline';
img-src data:;
worker-src blob:;
connect-src 'none';
```

`unsafe-eval` is forbidden.

### 8.6 Telemetry

All telemetry is local-only Output Channel logging. Any existing `fetch`, `axios`, or raw HTTP transport in the base codebase must be replaced. Structured local diagnostics and exported debug bundles are allowed; outbound collection is not.

### 8.7 Enterprise Export Governance

`codeIngest.allowRawExport` is a mandatory enforcement setting. It must honor workspace configuration and policy-managed overrides. If policy denies raw export, the Raw action is disabled and command handlers reject execution.

***

## 9. Technical Specifications

### 9.1 Storage Runtime

v1 uses an Asyncify-enabled `wa-sqlite` runtime with a Node `fs` random-access file layer for the SQLite database. The storage bridge must map SQLite pager operations through an Asyncify-capable VFS that uses descriptor-based Node I/O rather than `vscode.workspace.fs`, because SQLite requires offset-based partial reads and writes. Native `.node` SQLite bindings are not part of the product architecture, and designs that rewrite the full database file on each transaction are out of spec.

The existing native `GraphDatabase` implementation is a discard-and-replace target. The VFS must be registered before DB open, the WASM runtime must initialize once through a shared promise, and the writer path must use WAL when supported by the runtime or an equivalent chunked-commit strategy when WAL is unavailable.

### 9.2 Webview Rendering Runtime

The graph webview uses Canvas plus a dedicated worker. Large graph payloads are chunked and transferred in binary form. Structured-clone transfer of giant JSON element arrays is not permitted.

### 9.3 Supported APIs and Minimum VS Code Version

- minimum VS Code: `^1.90.0`
- stable Chat Participant API required
- `vscode.lm.computeTextEmbedding()` and `vscode.lm.countTokens()` used when available
- `vscode.ChatRequest.model` and `vscode.lm.selectChatModels()` used to resolve the exact request model before token counting and dispatch
- `LanguageModelChat.sendRequest(...)`, `vscode.LanguageModelChatMessage`, and `ChatResponseStream.markdown()` used to execute and stream the final model response

### 9.4 Key Runtime Dependencies

| Package | Purpose |
|---|---|
| `wa-sqlite` | Asyncify-enabled WASM SQLite runtime |
| `web-tree-sitter` | AST parsing |
| `hnswlib-wasm` or equivalent | Fast semantic nearest-neighbor retrieval |
| `@vscode/prompt-tsx` | Preferred structured prompt composition for model-bound TOON payloads |
| `ignore` | `.gitignore` / `.codeingestignore` support |
| `minimatch` | Glob matching |

### 9.5 Packaging and VSIX Constraints

- no native platform binaries
- bundled WASM grammars are curated to stay under the VSIX budget, with TypeScript/JavaScript grammars included first and additional grammars loaded lazily or shipped as optional follow-on assets
- the bundler must emit grammar `.wasm` files and runtime manifests as static assets under a stable packaged path such as `out/grammars/`
- worker and extension-host grammar loads must resolve from packaged URIs derived from `context.extensionUri`, not fragile relative source paths
- webview worker assets ship locally
- optional local model packs are deferred and not bundled into the base VSIX in v1

***

## 10. File System Layout

```
code-ingest/
├── assets/
│   ├── icon.svg
│   └── icon.png
├── resources/
│   └── webview/
│       ├── graph/
│       │   ├── graphView.html
│       │   ├── graphView.js
│       │   ├── graph.worker.js
│       │   ├── graphBinaryProtocol.js
│       │   └── graphStyles.css
│       ├── settings/
│       ├── sidebar/
│       └── vendor/
├── scripts/
│   ├── copyWebviewResources.js
│   └── buildWasmAssets.js
├── src/
│   ├── commands/
│   ├── config/
│   ├── controllers/
│   ├── graph/
│   │   ├── database/
│   │   ├── indexer/
│   │   ├── semantic/
│   │   ├── traversal/
│   │   └── models/
│   ├── providers/
│   ├── services/
│   │   └── security/
│   ├── utils/
│   └── extension.ts
└── .vscode/code-ingest/
    ├── graph.db
    └── semantic-index/
```

***

## 11. `package.json` Contribution Points

### 11.1 Chat Participant

The extension contributes `@code-ingest` with the commands in §7.10 and surfaces descriptions that emphasize structural retrieval, semantic ranking, and explicit provenance. When the Language Model Tool API is available, the same retrieval actions may also be contributed as explicit `vscode.lm.tools` without changing the explicit-invocation requirement.

### 11.2 Views

The extension contributes:

- an Activity Bar container for the sidebar
- a sidebar webview view
- a graph `WebviewPanel`

### 11.3 Menus

Editor context menus expose focus, send-to-chat, and export actions only when the workspace is trusted.

***

## 12. Testing Strategy

### 12.1 Unit Tests

| Module | Tests Required |
|---|---|
| `GraphDatabase.ts` | schema init, FK enforcement, migration behavior, Node `fs` random-access pager persistence, VFS registration, and no full-file rewrite regression |
| `SingleWriterQueue.ts` | coalescing by file path, priority tiers, backpressure, transaction flush, VFS-drain handoff, drain-timeout degradation, `waitForQuiescent()`, and write serialization |
| `TreeSitterExtractor.ts` | supported-language parse, grammar-missing fallback, AST chunk boundaries, grammar URI resolution, worker boundary enforcement, and worker-crash recovery |
| `RelevanceWalker.ts` | seed handling, edge-weight application, super-node penalty, deterministic ranking, and cancellation-safe iteration |
| `ContextBuilder.ts` | XML escaping, boundary-collision handling, footer generation, token enforcement, section ordering, and block-level verification only |
| `TokenBudgetService.ts` | batched local estimation, model-scoped `countTokens()` verification, dynamic reserve handling, and no-heuristic fallback behavior |
| `EmbeddingService.ts` | availability probe, cooldown state machine, retries, graph-only fallback, and host-to-worker vector handoff |
| `rootRuntimeRegistry.ts` | workspace-folder add/remove handling and root disposal |
| `PIIService.ts` | pre-storage masking and policy enforcement |

### 12.2 Integration Tests

- trusted vs untrusted workspace bootstrap
- initialization state transitions: trust-locked, not initialized, initializing, ready
- multi-root runtime resolution
- dirty-buffer indexing over disk content
- host-to-worker dirty-buffer marshal without worker-side `vscode` access
- dirty-buffer queued result is discarded and re-queued from disk if `mtimeMs` advances before flush
- workspace folder add/remove disposal lifecycle
- watcher instantiation excludes ignored directories at registration time
- watcher registration never uses bare `**/*` globs
- git branch-switch pause and reconcile
- 50 concurrent file changes while a write transaction is active
- knowledge synthesis started during a write batch waits for queue quiescence before reading Merkle state
- embedding-unavailable probe plus lexical-only retrieval path
- exact chat model resolution from `ChatRequest.model`
- model answer execution through `LanguageModelChat.sendRequest(...)`
- streamed answer chunks reach `ChatResponseStream.markdown()` before the footer is appended
- participant cancellation propagation through retrieval and send
- `/audit` and `/explain` behavior for fresh, stale, and missing knowledge
- raw export compatibility commands route through the same policy gate
- raw export policy denial
- chat progress hook emission

### 12.3 Webview Tests

- binary payload decode
- canvas selection, keyboard navigation, and state restore
- abort-on-hide behavior during binary transfer
- graph/sidebar selection sync and context-menu actions
- theme change repaint
- aria mirror updates

***

## 13. Build and Release Pipeline

### 13.1 Developer Commands

- `npm run build`
- `npm run build:webview`
- `npm run build:wasm`
- `npm run lint`
- `npm run type-check`
- `npm run test:unit`
- `npm run test:integration`
- `npm run test:webview`
- `npm run package`

### 13.2 CI Requirements

- Node 18.x and 20.x test matrix
- VS Code minimum and latest test runs
- WASM asset build validation
- packaged grammar path resolution validation
- PPR latency benchmark against the 10,000-node target envelope
- bundle size check
- zero-network telemetry assertion

### 13.3 VSIX Packaging

The VSIX includes local webview assets, workers, WASM runtime assets, and curated Tree-sitter grammars. No native `.node` binaries are bundled.

***

## 14. Resolved Decisions and Deferred Work

### 14.1 Resolved for v1

1. storage runtime uses WASM SQLite, not native bindings
2. extraction uses Tree-sitter, not LSP as the normative path
3. retrieval uses semantic seeds plus PPR-style ranking, not naive BFS ordering
4. graph rendering uses Canvas plus worker-based layout, not DOM-heavy SVG/Cytoscape rendering as the normative architecture
5. knowledge synthesis is JIT and demand-driven, not autonomous post-index generation
6. Raw export is policy-gated through `codeIngest.allowRawExport`
7. command IDs are standardized on `codeIngest.*`
8. lexical-plus-structural retrieval remains a first-class path when embeddings are unavailable

### 14.2 Deferred Beyond v1

- optional local model packs for fully offline embeddings
- migrate from `wa-sqlite` to `@sqlite.org/sqlite-wasm` if the current Asyncify integration diverges or loses maintenance stability
- cross-root graph federation
- graph diff view across commits
- richer static analysis such as data-flow edges
- enterprise-managed model pack provisioning UX

***

## 15. Definition of Done

The extension is production-ready when:

**Core indexing and storage**

- [ ] trusted roots create and reuse a WASM SQLite graph DB plus semantic sidecars
- [ ] SQLite pager I/O for `graph.db` uses Node `fs` random-access reads and writes instead of `vscode.workspace.fs`
- [ ] single-writer queue serializes all DB mutations
- [ ] queue batching, backpressure, and priority tiers prevent watcher storms from growing without bound
- [ ] dirty buffers are preferred over disk during index and retrieval
- [ ] dirty-buffer content is marshaled from host to parse worker without worker-side `vscode` API access
- [ ] module-summary staleness is resolved from cached directory Merkle roots in $O(1)$ time
- [ ] semantic sidecars are versioned, checksum-validated, and rebuildable without corrupting structural data
- [ ] git branch switches pause incremental processing and reconcile cleanly
- [ ] removed workspace folders dispose runtimes, workers, queues, and watchers cleanly

**Retrieval and chat**

- [ ] `@code-ingest` responds with progress updates during retrieval
- [ ] semantic retrieval uses the worker-backed index when available and degrades gracefully when unavailable
- [ ] lexical-plus-structural retrieval is fully supported when embeddings are unavailable or cooling down
- [ ] the exact request model is resolved before token counting and prompt dispatch
- [ ] payload enforcement uses batched verification with model-scoped `vscode.lm.countTokens()`
- [ ] the participant sends `LanguageModelChatMessage[]` through `LanguageModelChat.sendRequest(...)` and streams the model answer before appending the footer
- [ ] XML boundaries prevent repository prompt injection from escaping its context region
- [ ] every response includes the `Context Used` footer in the required format

**Visualization**

- [ ] graph view uses Canvas plus worker layout without freezing the webview on large payloads
- [ ] binary IPC is used for chunked graph transfer
- [ ] state restore preserves zoom/pan/selection on tab switch
- [ ] graph context menus, sidebar sync, and token-usage indicators remain consistent in Ready state
- [ ] keyboard navigation and accessibility mirror remain functional

**Security and governance**

- [ ] graph features remain blocked in untrusted workspaces
- [ ] watcher registration avoids global `**/*` scopes and excludes ignored directories before OS-level watch allocation
- [ ] raw export is disabled when `codeIngest.allowRawExport` resolves to false
- [ ] raw export compatibility entrypoints use the same policy-gated controller path
- [ ] telemetry makes no outbound network calls
- [ ] local diagnostics logs and debug bundles are available without leaking raw code by default
- [ ] dynamic webview content is escaped and runtime messages are validated

**Release**

- [ ] unit, integration, and webview tests pass
- [ ] VSIX remains within the size budget
- [ ] extension activates cleanly on the minimum supported VS Code version

***

## 16. Final Positioning

This system is not a simple code search add-on and not a passive graph viewer. It is a deterministic, local-first repository intelligence layer for VS Code that ranks, compresses, and explains the codebase under real editor constraints.

**What this enables:**

- graph-aware Copilot answers with provenance
- faster impact analysis and onboarding
- safer context export with enterprise controls
- large-repo navigation without extension-host or webview collapse