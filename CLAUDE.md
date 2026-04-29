# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository status and intent

This repository currently contains a working VS Code extension implementation and a forward architecture spec that is **not yet fully implemented**.

- **Current implementation surface** (what code actually does today) is centered on:
  - `src/extension.ts`
  - `src/services/*` (digest/export/config/scanning/filtering)
  - `src/graph/*` (SQLite-backed graph, indexing, traversal)
  - `src/providers/*` and `resources/webview/*` (dashboard/sidebar/settings/graph webviews)
- **Target architecture** is specified in:
  - `prd.md`
  - `phased-plan.md`

When making changes, ground decisions in current code behavior first, then align toward PRD/phased-plan direction without assuming future modules already exist.

---

## Common commands

Run from repository root.

### Install

```bash
npm install
```

### Build

```bash
npm run build
```

- Compiles extension host with webpack and copies webview assets into `out/resources/webview`.

Development builds:

```bash
npm run build:dev
npm run build:watch
npm run build:webview
```

### Lint and type-check

```bash
npm run lint
npm run type-check
```

### Tests

All tests configured by package scripts:

```bash
npm test
npm run test:unit
npm run test:webview
npm run test:integration
```

Observed current behavior:

- `test:unit` uses `--testPathPattern=src/test/vnext` and currently runs the vnext suites.
- `test:webview` uses `resources/webview/jest.config.js` and `--testPathPattern=test/vnext`.
- `test:integration` points at `src/test/vnext/integration` (currently no discovered tests).

### Run a single test file

Because `test:unit` and `test:webview` include a path pattern in the script, passing a specific file still runs the matching pattern set. For true one-file runs, invoke jest directly.

Unit (single file):

```bash
node --experimental-vm-modules ./node_modules/jest/bin/jest.js --runInBand src/test/vnext/graphDatabase.unit.test.ts
```

Webview (single file):

```bash
node --experimental-vm-modules ./node_modules/jest/bin/jest.js -c resources/webview/jest.config.js --runInBand resources/webview/test/vnext/sidebar.test.js
```

### CI and packaging

```bash
npm run ci
npm run package
```

- `ci` runs type-check + tests + build.
- `package` creates VSIX at `dist/code-ingest.vsix`.

---

## High-level architecture (current code)

### 1) Extension activation and orchestration

**Entry point:** `src/extension.ts`

The extension currently boots as a **single-root runtime** (uses `workspaceFolders?.[0]`), initializes graph services, registers chat participant + commands + providers, performs full/delta indexing, then starts file watching.

Primary activation flow:

1. Create output/error channels.
2. Ensure `.gitignore` contains `.vscode/code-ingest/` entries.
3. Build services (`GitignoreService`, `FilterService`, `FileScanner`, `GraphDatabase`, `GraphIndexer`, `EmbeddingService`, `ContextBuilder`, `CopilotParticipant`).
4. Register providers (`SidebarProvider`, `GraphViewPanel`, `SettingsProvider`) and commands.
5. Rebuild/reindex based on schema/index state + changed files.
6. Start `FileWatcher` and config/editor listeners.

### 2) Graph storage and query layer

**Core files:**

- `src/graph/database/GraphDatabase.ts`
- `src/graph/database/schema.ts`

Current storage is SQLite through `better-sqlite3` with optional `sqlite-vec` support and fallback embedding JSON table.

Key characteristics:

- DB path: `.vscode/code-ingest/graph.db` per workspace root.
- Tables for nodes, edges, index state, code/comment chunks, and embeddings.
- Foreign keys + WAL enabled in schema setup.
- Supports:
  - graph upsert/replace operations,
  - chunk persistence,
  - snapshot/neighbor queries,
  - embedding KNN (sqlite-vec when available, fallback brute-force otherwise).

### 3) Indexing pipeline

**Core file:** `src/graph/indexer/GraphIndexer.ts`

Current indexing pipeline is:

1. Scan workspace files (`FileScanner`).
2. Apply include/exclude/gitignore filtering (`FilterService`).
3. For each file:
   - read bytes,
   - detect binary/size cap,
   - extract symbols via `LspExtractor`,
   - create graph nodes,
   - chunk content (`FileChunker`),
   - run PII redaction (`PIIService`) on chunks.
4. Resolve edges (`EdgeResolver`).
5. Persist nodes/edges/chunks to `GraphDatabase`.

Important: despite PRD direction to Tree-sitter + worker pipeline, current code still uses `LspExtractor` and direct in-process indexing.

### 4) Traversal, context construction, and chat integration

**Core files:**

- `src/graph/traversal/GraphTraversal.ts`
- `src/graph/traversal/ContextBuilder.ts`
- `src/services/copilotParticipant.ts`
- `src/services/embeddingService.ts`

Current behavior:

- Traversal uses BFS (`GraphTraversal.bfs`) with circular-edge detection.
- `ContextBuilder` composes structured graph context + optional file content under token budget estimation.
- `CopilotParticipant` handles slash-style commands (`/context`, `/focus`, `/impact`, `/explain`, `/depth`, `/search`) and emits markdown responses.
- Embeddings are lazily primed on first semantic use; if embedding API/sqlite-vec unavailable, service falls back to label-based search.

### 5) UI surfaces and host-webview messaging

**Host providers:**

- `src/providers/sidebarProvider.ts`
- `src/providers/graphViewPanel.ts`
- `src/providers/settingsProvider.ts`
- `src/providers/codeIngestPanel.ts` (legacy dashboard panel infra)

**Webview assets:** `resources/webview/*` copied into `out/resources/webview/*` by `scripts/copyWebviewResources.js`.

Messaging and safety patterns:

- `setWebviewHtml` in `src/providers/webviewHelpers.ts` applies CSP, rewrites local resource URIs, validates required assets, injects initial state, and falls back to safe error HTML when assets are missing.
- `src/providers/messageEnvelope.ts` provides typed envelope validation and session token checks for host/webview messaging paths.

### 6) Digest/export pipeline (legacy + graph-aware modes)

**Core files:**

- `src/services/digestGenerator.ts`
- `src/services/exportController.ts`
- `src/commands/digestCommand.ts`
- `src/commands/exportCommands.ts`

`DigestGenerator` is a large, pipeline-oriented service:

- scan/filter/process files,
- estimate/analyze tokens,
- truncate for budgets,
- optional redaction,
- produce structured digest data for formatters.

`ExportController` adds mode routing:

- `Raw`: digest formatter path,
- `Clean`: graph context over all file nodes,
- `Graph`: graph-subset context path.

---

## Important implementation realities and constraints

### Single-root assumptions are still common

Many services resolve root via `workspaceFolders?.[0]` (activation, commands, settings updates, chat node resolution, graph focus). PRD/phased-plan target multi-root root-runtime architecture is not yet realized.

### Commands are mixed `code-ingest.*` and `codeIngest.*`

- `package.json` contributes `code-ingest.*` commands.
- `graphCommands.ts` registers aliases to `codeIngest.*`.
- `commandMap.ts` and webview command flow use `codeIngest.*` identifiers.

When changing commands, keep compatibility unless explicitly migrating all references.

### Watcher implementation differs from PRD target

`FileWatcher` currently uses global watcher pattern `"**/*"` and filters after events. PRD/phased plan call for scoped `RelativePattern` watchers and pre-registration exclusion strategy.

### Build pipeline depends on copied webview assets

If webview fails or fallback UI appears, rebuild assets:

```bash
npm run build:webview
```

`webviewHelpers.ts` explicitly detects missing assets and renders fallback HTML.

### Copilot/Webview test comments reference missing copilot-instructions

Many webview files contain comment headers “Follow instructions in copilot-instructions.md exactly.” No `.github/copilot-instructions.md` exists in this repo. Treat this as historical annotation, not a live instruction source.

---

## Key directories to know quickly

- `src/extension.ts` — activation and top-level wiring
- `src/config/` — constants and graph settings resolution
- `src/graph/` — database, indexing, traversal, graph models
- `src/services/` — digest/export/filtering/embedding/copilot/telemetry
- `src/providers/` — webview providers and messaging helpers
- `resources/webview/` — frontend scripts, handlers, sidebar/settings/graph pages
- `src/test/vnext/` — active vnext unit/integration-style tests
- `scripts/` — build helpers and packaging checks

---

## PRD and phased plan usage guidance

Use `prd.md` and `phased-plan.md` as the authoritative target-state architecture docs. When implementing toward those docs:

1. Verify whether a target module already exists in `src/`.
2. If absent, treat the plan item as net-new work (not a refactor of non-existent files).
3. Preserve current runtime stability first; avoid partial migrations that leave command or provider wiring inconsistent.
4. Keep tests aligned with whichever architecture path the change touches (current behavior vs new phase migration).
