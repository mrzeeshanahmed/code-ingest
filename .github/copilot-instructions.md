# copilot-instructions.md

> **Purpose**: This file is the authoritative instruction set for GitHub Copilot (and other code generation agents) to implement, extend, test, and maintain **Code-Ingest** across all phases of development. Treat this as the single source of truth for code style, architectural constraints, required behaviors, test coverage expectations, security rules, and PR/commit semantics. Always include these instructions (or confirm they are satisfied) when generating or modifying code with Copilot.

---

## Table of contents

1. Overview & how to use these instructions
2. Project-wide conventions
3. Required artifacts and directory layout
4. Per-file and per-service instruction templates (skeletons & examples)
5. Prompts for common tasks (explicit, copy-paste-ready)
6. Testing requirements & test templates
7. CI, build, and release guidance
8. Security, redaction, and privacy rules
9. Performance and scalability constraints
10. Error handling, diagnostics & telemetry
11. PR + commit message templates and checklist
12. QA signoff checklist
13. Appendix: Helpful snippets and patterns

---

# 1. Overview & how to use these instructions

* When asking Copilot to generate code, **always** include a link/reference to this file in the prompt (or paste the exact small section that is relevant). Copilot should treat the instructions here as mandatory rules to follow.
* These instructions are prescriptive. If Copilot-generated code conflicts with any explicit rule below, prefer the rules. When generating multi-file work, include unit tests and a short integration test demonstrating the feature.
* If the task is large, Copilot must produce a working, compileable skeleton and mark remaining todos clearly in code with `// TODO:` comments referencing this file and the precise failing test name.

# 2. Project-wide conventions

**Languages & targets**

* TypeScript (Node >= 16 / ES2020). Files under `src/` are `*.ts`. Webview sources are `resources/webview` and can be JS/TS depending on build flow.

**Formatting & linting**

* Prettier defaults, 2-space indent, single semicolon style. ESLint rules: prefer `no-explicit-any`, prefer typed return values on public functions.

**Type system**

* Strict TypeScript (`strict: true`), avoid `any` unless absolutely necessary with a comment explaining why. Use `unknown` instead of `any` for external inputs.

**Error handling & promises**

* Avoid swallowing errors. Use typed `Result<T, E>`-like objects for multi-step flows where partial failures can occur. Always attach contextual metadata to errors via a unified helper `wrapError(err, context)`.

**Testing**

* Use Jest for unit tests. Use @vscode/test-electron for E2E (optional in CI). Each new module gets at least one unit test and one integration test if it participates in pipeline flows.

**Commit messages**

* Conventional commits format: `feat(scope): short summary` / `fix(scope): short summary` / `chore(ci): ...`.

# 3. Required artifacts and directory layout

High-level layout (mandatory):

```
/ (repo root)
  package.json
  tsconfig.json
  webpack.config.js
  scripts/
  src/
    extension.ts
    commands/
    providers/
    services/
    utils/
    webview/
    test/
  resources/
    webview/
  test/
  .github/
    workflows/
    PULL_REQUEST_TEMPLATE.md
  docs/
  copilot-instructions.md
```

**Key files** (must exist as described):

* `src/services/outputWriter.ts` — write outputs (editor/file/clipboard) with cancelable write operations.
* `src/services/remoteRepoService.ts` — partial clone, sparse-checkout, `keepTmpDir` semantics.
* `src/providers/treeDataProvider.ts` — file tree provider with cancellation, progress events.
* `resources/webview/index.html` + `main.js` + `handlers/*` — structured webview with command registry and `window.__INITIAL_STATE__` restore.
* `scripts/generateWebviewCommandMap.js` — generator to sync webview commands and host commands.
* `src/utils/redactSecrets.ts` — redaction utilities and tests.

# 4. Per-file and per-service instruction templates (skeletons & examples)

For each major service below, when generating code the output MUST follow these rules: create the TypeScript file, export typed API described, create a matching `.test.ts` file with at least 3 unit tests (happy path, edge case, error path), and add an integration test where relevant.

### `src/services/outputWriter.ts`

**Exports**:

```ts
export type OutputTarget = 'editor' | 'file' | 'clipboard';
export interface WriteOptions { target: OutputTarget; path?: string; cancelToken?: CancelToken; format?: 'markdown'|'json'|'text'; }
export function writeOutput(content: string, opts: WriteOptions): Promise<{uri?: string}>;
```

**Semantics**:

* Must support progressive flushing for large content to editor (if > 1MB, stream in 100KB chunks).
* Must accept a `CancelToken` that cancels in-flight writes.
* For `file` target, create parent directories as needed and return `uri`.
* Unit tests: small text, large text streaming, cancellation mid-write.

**Copilot prompt (example)**:

> "Create `src/services/outputWriter.ts` exports as specified above. Implement streaming write to a VS Code TextDocument for target 'editor' using the VS Code workspace edit API, support cancellation, and add tests: `outputWriter.unit.test.ts` with 3 tests."

---

### `src/services/remoteRepoService.ts`

**Exports**:

```ts
export interface CloneOptions { ref?: string; sparsePaths?: string[]; keepTmpDir?: boolean; retries?: number; }
export function partialClone(url: string, opts?: CloneOptions): Promise<{ tmpDir:string, sha: string }>;
export function cleanupTmpDir(tmpDir: string): Promise<void>;
```

**Semantics**:

* Use `spawn` for `git` commands and `spawn` must be wrapped to sanitize any tokens in errors.
* If `git` is missing, return an explicit, testable error `GitNotAvailableError`.
* Implement sparse-checkout behavior when `sparsePaths` provided.
* Unit tests: simulate success, missing git, sparse-checkout failure.

**Prompt example**:

> "Generate `remoteRepoService.ts` implementing partial clone with retries and sparse-checkout. Create unit tests and throw clear `GitNotAvailableError` when git isn't present."

---

### `src/providers/treeDataProvider.ts`

**Behavior**:

* Provide incremental scanning (emit progress per N files).
* Support cancellation token and `ensureScan()` method returning a shape `{ nodes, warnings }`.
* Use `fileScanner` service for traversal and `gitignoreService` for filter decisions.

**Tests**:

* Simulated workspace with nested directories, hidden files, symlink handling.

**Prompt example**:

> "Implement `treeDataProvider.ts` that uses `fileScanner` and `gitignoreService`. Provide `onDidChangeTreeData` events and ensure cancellation works. Add unit tests."

---

### Webview assets in `resources/webview/`

**Must have**:

* `index.html` with strict CSP and placeholder `<!-- INITIAL_STATE -->` for injection.
* `main.js` that reads `window.__INITIAL_STATE__`, instantiates a small store, registers UI handlers, and communicates with the host using validated envelopes `{type, token, payload}`.
* `handlers/` folder for all message handlers; each handler validates payload shape.

**Required webview handlers (complete list)**
Create individual handlers for each message type. Each handler must be a small module that exports a single `handle(payload, context)` async function and a `validate(payload)` sync function that returns `{ ok: boolean, reason?: string }`.

Minimum handler set and expected payload shapes (use these exact names):

* `ingestPreviewHandler`

  * payload: `{ previewId: string, nodes: Array<{path: string, snippet?: string, truncated?: boolean}>, metadata?: Record<string, any> }`
  * responsibility: render preview items into the DOM, highlight redaction placeholders, and emit `previewRendered` analytics event.

* `progressHandler`

  * payload: `{ progressId: string, processed: number, total?: number, message?: string }`
  * responsibility: update UI progress bars and show incremental messages.

* `remoteRepoLoadedHandler`

  * payload: `{ repoUrl: string, tmpDir?: string, sha: string, warnings?: string[] }`
  * responsibility: display repo meta-info and enable "generate" if ready.

* `restoredStateHandler`

  * payload: `{ state: object }` (opaque but validated by schema)
  * responsibility: merge restored state into the store and replay selection/expand state.

* `stateHandler`

  * payload: `{ viewState: object }`
  * responsibility: accept partial UI state updates (e.g., theme, layout) and persist to localStorage.

* `treeDataHandler`

  * payload: `{ tree: Array<FileNode>, scanId: string }`
  * responsibility: render file tree; preserve checkboxes and attached metadata.

* `ingestErrorHandler`

  * payload: `{ errorId: string, message: string, code?: string, details?: string }`
  * responsibility: show errors to the user in an accessible manner and provide a "copy scrubbed error" button.

* `previewDeltaHandler`

  * payload: `{ deltaId: string, changes: Array<{path: string, changeType: 'add'|'update'|'remove'}> }`
  * responsibility: apply incremental UI updates without full re-render.

* `generationResultHandler`

  * payload: `{ resultId: string, outputUri?: string, stats?: object }`
  * responsibility: show final result links and fetch when user opens the output.

* `configHandler`

  * payload: `{ config: object }`
  * responsibility: show config modal and validate fields locally before sending updates to host.

**Handler development rules**

* Each handler file must export two symbols: `validate(payload): { ok: boolean; reason?: string }` and `handle(payload, context): Promise<void>`.
* `validate` must be a *synchronous*, fast, defensive validator — never rely on remote calls. Prefer manual checks (types and presence) to avoid bundling a heavy schema library.
* `context` object passed to `handle` will contain `{ postMessage, store, log }` where `postMessage` is a wrapper that posts back to the host with a token, `store` is the webview-local store API, and `log` is the webview logger.
* Each handler must call `validate` at the start of `handle` and bail out if not valid, logging the reason.
* Each handler must never `await` indefinitely: if a long running task is needed, show a busy UI and return immediately after scheduling work.

**Testing rules for handlers**

* For each handler add a Jest test file under `resources/webview/handlers/__tests__` that checks:

  * valid payload executes `handle` without throwing and results in expected store modifications (use a mocked `context`).
  * invalid payload is rejected by `validate` and `handle` returns early.
  * any calls to `postMessage` are sanitized and do not include raw file contents.

**Example prompt to generate a handler (copy-paste ready)**

```
Follow instructions in copilot-instructions.md exactly.
Create `resources/webview/handlers/ingestPreviewHandler.js` that exports:
- `validate(payload)` which ensures `payload.previewId` is a non-empty string and `payload.nodes` is an array of objects with `path` string.
- `async handle(payload, context)` that:
  - calls `validate(payload)` and returns early if invalid,
  - updates the `store` with `store.setPreview(payload)`,
  - calls `context.log('previewRendered', { previewId: payload.previewId, nodeCount: payload.nodes.length })`.
Also create `__tests__/ingestPreviewHandler.test.js` that covers valid/invalid payloads and mocks `context.postMessage`.
```

**Example handler skeleton (JS)**

```js
// resources/webview/handlers/ingestPreviewHandler.js
export function validate(payload) {
  if (!payload || typeof payload.previewId !== 'string' || !payload.previewId) return { ok: false, reason: 'previewId' };
  if (!Array.isArray(payload.nodes)) return { ok: false, reason: 'nodes' };
  return { ok: true };
}

export async function handle(payload, context) {
  const v = validate(payload);
  if (!v.ok) return context.log('handler.validate.failed', v.reason);
  context.store.setPreview({ id: payload.previewId, nodes: payload.nodes });
  context.log('previewRendered', { previewId: payload.previewId, nodeCount: payload.nodes.length });
}
```

**Security notes for webview**

* Do not `eval` or use `new Function`.
* All user-provided strings that are inserted into the DOM must be sanitized with `textContent` or `innerText` (never `innerHTML`) unless strictly validated as safe HTML. Prefer building DOM nodes programmatically.
* When sending messages back to the host, always use a host-supplied `token` and a normalized envelope: `{ type, token, payload }`.

# 5. Prompts for common tasks (copy-paste-ready)

Use these exact prompt templates when invoking Copilot for these tasks. Replace placeholders in `{{}}` with actual values.

**A. Add new service file**

```
Create a new TypeScript service at `{{path}}` with the following exported API:
{{code-block}}
Implement behavior described: {{behavior description}}.
Add unit tests in `{{path}}.test.ts` with at least 3 cases: success, edge, error.
Follow project conventions: strict types, no `any`, use `wrapError(err, context)` on thrown errors.
```

(remaining sections continue...)

# 6. Testing requirements & test templates

(unchanged)

Prompts for common tasks (copy-paste ready)

Use these exact prompt templates when invoking Copilot for these tasks. Replace placeholders in `{{}}` with actual values.

**A. Add new service file**

```
Create a new TypeScript service at `{{path}}` with the following exported API:
{{code-block}}
Implement behavior described: {{behavior description}}.
Add unit tests in `{{path}}.test.ts` with at least 3 cases: success, edge, error.
Follow project conventions: strict types, no `any`, use `wrapError(err, context)` on thrown errors.
```

**B. Implement a command**

```
Create or update `src/commands/{{commandFile}}.ts` to register a VS Code command `{{commandId}}`. The command must:
- validate inputs (use `validateConfig` if config involved),
- run the service `{{servicePath}}` with cancellation handling,
- send progress updates to the webview via `panel.postMessage({type:'progress', payload})`.
Add tests for command registration and functional behavior.
```

**C. Add unit tests for module**

```
Write Jest unit tests for `src/{{module}}.ts`. Cover these scenarios: happy path, missing input, error propagation. Mock external dependencies using jest mock. Use small synthetic fixtures in `test/fixtures/`.
```

**D. Refactor function**

```
Refactor `{{file}}:{{functionName}}` to be pure and return `Promise<Result<T, E>>` instead of throwing. Keep external API compatible by providing a thin adapter `{{functionName}}Safe` that calls the new function and throws if result is error. Add tests verifying both behaviours.
```

# 6. Testing requirements & test templates

**Unit tests**

* Each module: at least 3 unit tests (success, edge-case, failure).
* Mock external modules when deterministic behaviour is needed.

**Integration tests**

* Pipeline tests: scanning -> filtering -> digesting -> output writer. Should run in-memory with temp directories using `tmp`/`fs-extra`.

**E2E**

* Optional `@vscode/test-electron` runs to validate UI flows. Add a toggle in CI to enable these runs.

**Test template (Jest)**

```ts
import { myFn } from '../src/myModule';

describe('myModule', () => {
  test('happy path', async () => {
    expect(await myFn(...)).toEqual(...);
  });
  test('edge case', async () => { /* ... */ });
  test('error path', async () => { /* ... */ });
});
```

# 7. CI, build, and release guidance

* `npm run build:webview` – bundles webview into `resources/webview/dist`.
* `npm run build` – runs extension build, runs unit tests, and ensures `copyWebviewResources` executed.
* CI job steps:

  1. install deps
  2. run lint
  3. run unit tests
  4. run integration tests
  5. run bundle-size check
  6. optionally run e2e on demand

# 8. Security, redaction, and privacy rules

**Redaction**

* Default behavior: do not show secrets. All outputs must run through `redactSecrets` unless a one-time, in-memory UI override is active. The override must NOT persist to settings.
* `redactSecrets` must be configurable with user-provided regexes; but Copilot-generated code must ensure safe defaults (e.g., API keys, tokens, RSA private keys, AWS keys patterns).

**Message validation**

* Host must validate webview messages with a panel-scoped token and schema check. Use `zod` or manual checks; prefer simple manual check for small shapes (no heavy dependencies).

**No PII in telemetry**

* Telemetry must be aggregated counts and timings only. Never send file contents, workspace names, or full paths.

# 9. Performance and scalability constraints

* `fileScanner` must support a concurrency pool with default `maxConcurrency=8`. Use `asyncPool` pattern.
* Scans must be cancellable within 100ms after cancel request.
* Large workspaces: default `maxFiles=5000`. If scanner reaches 5000, emit a warning and proceed with deterministic sampling strategy (topologically by modified time or path). Document this behaviour in code comments.

# 10. Error handling, diagnostics & telemetry

* Use `errorReporter.report(err, context)` to capture internal errors (in-memory buffer + optional disk logging behind a flag).
* `flushErrorReports` command: open VS Code output channel and print buffered errors with scrubbed details.
* Telemetry (opt-in): record `generationTimeMs`, `filesProcessed`, `tokensEstimated`. Store metrics in a local file under extension storage for diagnostics.

# 11. PR + commit message templates and checklist

**Commit message**

```
<type>(<scope>): <short summary>

Longer description (optional). Reference issue #<id> when applicable.
```

Types: `feat`, `fix`, `perf`, `refactor`, `test`, `chore`, `docs`.

**PULL_REQUEST_TEMPLATE.md** must include:

* Summary of changes
* A checklist (Unit tests added/updated, Integration tests added, CI green)
* Screenshots / logs (if UI)
* Any migration steps

**PR review checklist for Copilot-generated code**

* All new public exports have TypeScript doc comments
* No `any` types without justification
* Tests exist and pass
* Edge cases documented with `// TODO:` if incomplete
* No secrets or tokens in code or error messages

# 12. QA signoff checklist

Before merging, ensure:

* All unit and integration tests pass locally and in CI.
* Build and webview bundling succeed with no warnings.
* No linter errors.
* New code covered by tests: at least 80% coverage for new modules.
* PR description explains behavioral changes and migration steps.

# 13. Appendix: Helpful snippets and patterns

**Cancellation token pattern (example)**

```ts
interface CancelToken { isCancelled(): boolean; onCancel(cb: ()=>void): void; }

function someAsync(cancelToken?: CancelToken) {
  if (cancelToken?.isCancelled()) throw new Error('Cancelled');
  // periodically check cancelToken.isCancelled() and abort
}
```

**Safe spawn wrapper**

```ts
async function safeSpawn(cmd: string, args: string[], opts = {}){
  try { /* spawn and return stdout */ }
  catch(err){ throw wrapError(err, {cmd, args: args.map(scrub) }); }
}
```

**Redaction helper example**

```ts
export function redactSecrets(input: string, patterns: RegExp[]) {
  for (const p of patterns) input = input.replace(p, '<REDACTED>');
  return input;
}
```

---

## Next steps for Copilot

1. When generating or modifying any file, start the prompt with: `Follow instructions in copilot-instructions.md exactly.`
2. For multi-file changes, include tests and a short integration example demonstrating the end-to-end behavior.
3. Always leave `// TODO: copilot-instructions` comments for incomplete work and reference the exact section that needs human review.

---

*This file is the authoritative guideline for Copilot to create consistent, safe, and testable code. If you (developer or reviewer) want a custom sub-section or further expansion (e.g., an exhaustive list of regexes used for redaction), request it and a new section will be added.*

---

## Exact Redaction Regexes

> **Purpose**: Provide a safe, well-tested set of default regex patterns Copilot should apply when generating or processing outputs. These are conservative: they may redact some non-sensitive text in borderline cases, but prefer safety. Always include these defaults before user-provided patterns. When adding new patterns, include unit tests demonstrating matches and non-matches.

### Default regex list (ordered, anchored where appropriate)

1. **AWS Access Key ID**

   * Pattern: `/\b(AKIA|ASIA|AGPA|AIDA|AROA)[A-Z0-9]{16}\b/g`
   * Example match: `AKIAIOSFODNN7EXAMPLE`
   * Notes: AWS Access Key IDs are 20-character uppercase/alphanumeric with known prefixes.

2. **AWS Secret Access Key (base64-like)**

   * Pattern: `/((?<![A-Za-z0-9])[A-Za-z0-9\/+=]{40,50}(?![A-Za-z0-9\/+=]))/g`
   * Example match: `wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY`
   * Notes: This is a heuristic; combine with context (adjacent `aws` or `secret`) when possible.

3. **Hex-encoded API keys / tokens (common lengths)**

   * Pattern: `/\b0x?[A-Fa-f0-9]{32,128}\b/g`
   * Example match: `0x9f86d081884c7d659a2feaa0c55ad015`

4. **OAuth / Generic Bearer Tokens (JWT style)**

   * Pattern: `/\beyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\b/g`
   * Example match: `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.Kl0...`
   * Notes: JWT detection is heuristic; verify that the string splits into three dot-separated base64url parts.

5. **Private RSA / PEM Blocks**

   * Pattern: `/-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |)PRIVATE KEY-----/g`
   * Example match: the entire PEM block for private keys.
   * Notes: Always redact entire block.

6. **SSH Private Keys (id_rsa-like)**

   * Pattern: `/-----BEGIN OPENSSH PRIVATE KEY-----[\s\S]*?-----END OPENSSH PRIVATE KEY-----/g`

7. **Password assignment heuristics**

   * Pattern: `/\b(password|passwd|pwd)\s*[:=]\s*([\'\"])?[^\'\"\s]{6,200}\2/ig`
   * Example match: `password = "hunter2"`
   * Notes: Consider context and avoid redacting sentences like "the password policy..." unless immediately followed by an assignment.

8. **AWS-style session tokens / long base64 tokens**

   * Pattern: `/\b[A-Za-z0-9\-_=]{128,}\b/g`
   * Notes: Very high-length tokens; conservative threshold to reduce false positives.

9. **Google API Keys**

   * Pattern: `/\bAIza[0-9A-Za-z\-_]{35}\b/g`
   * Example match: `AIzaSyA...`

10. **Slack tokens (legacy)**

    * Pattern: `/\bxox[baprs]-[0-9A-Za-z-]{10,}/g`
    * Example: `xoxb-1234-...`

11. **Generic Basic Auth / Base64 Auth headers**

    * Pattern: `/\bBasic\s+[A-Za-z0-9+\/=]{24,}\b/ig`
    * Notes: If header detected, redact entire header value.

12. **Credit card numbers (Luhn-safe detection)**

    * Pattern: `/\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|6(?:011|5[0-9]{2})[0-9]{12})\b/g`
    * Notes: Optionally run Luhn check to reduce false positives.

13. **Email addresses (configurable)**

    * Pattern: `/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g`
    * Notes: Redact only when user config enables PII redaction; default is to NOT redact emails unless `redactPii` is enabled.

14. **Phone numbers (E.164-ish)**

    * Pattern: `/\+?\d[\d\s\-()]{6,}\d/g`
    * Notes: Highly contextual; default off unless `redactPii` enabled.

15. **UUIDs (when adjacent to 'token' or 'secret')**

    * Pattern: `/\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g`

16. **Generic 32+/40+/64+ char tokens**

    * Pattern: `/\b[A-Za-z0-9_\-]{32,}\b/g`
    * Notes: Use as a heuristic combined with context (variable names, HTTP headers).

### Rules for applying regexes

* **Order matters**: apply more specific patterns first (PEM blocks, JWT, API-key patterns) then generic heuristics.
* **Contextual validation**: when possible, check for surrounding keywords (`key`, `secret`, `token`, `password`, `api`, `aws`, `ssh`) within 40 characters to reduce false positives.
* **Redaction result**: replace matched substrings with `<REDACTED:{TYPE}>` where `{TYPE}` is a short label (e.g., `AWS_KEY`, `PEM`, `JWT`) to help debugging while avoiding revealing original content.
* **Testing**: every change to the regex list must include unit tests with positive and negative examples.

### How to add custom user patterns

* Persist user patterns in `configurationService` under `codeIngest.redaction.customPatterns` as an array of strings (escaped regex). Validate and compile at runtime; if compilation fails, ignore the pattern and log a warning in diagnostics.
* Provide a UI component in the webview for users to preview matches for a single file before saving a new pattern.

---

## Expanded Webview Handler Prompts

> **Purpose**: Provide explicit, copy-paste-ready prompts for Copilot to generate each webview handler file. For each handler we include: expected incoming message shape, validation logic, side-effects (DOM updates / store updates), and unit tests to generate.

> **Instructions for Copilot**: For each handler below, generate a JS/TS module in `resources/webview/handlers/` exporting a single function `handle(message, store, dom, postMessage)` where:

* `message` is the validated parsed incoming envelope from host `{ type:string, payload:any }` (host will already verify token and envelope shape). The handler should still defensively check payload fields and types.
* `store` is the webview store object with `setState` and `getState` methods.
* `dom` is an object of helpful DOM selectors (e.g., `{ previewContainer, progressBar, fileList }`) — the handler should only update via these selectors and not query random elements.
* `postMessage` is the function `payload => window.vscode.postMessage(payload)` for sending messages back to host.

Include unit tests for each handler in `resources/webview/handlers/__tests__` that assert DOM updates and store state changes given a sample payload.

### Handler: `ingestPreviewHandler` (ingest preview)

**Incoming envelope**: `{ type: 'ingestPreview', payload: { previewHtml?: string, previewText?: string, summary?: string, files: Array<{path:string, snippet?:string}> } }

**Validation**:

* Ensure `payload.files` is an array and each item has `path` string.
* If `previewHtml` present, sanitize minimal allowed tags (no scripts). Prefer `previewText` if `sanitizeHtml(previewHtml)` reduces to empty.

**Side effects**:

* Update `store.setState({ preview: { html, text, summary } })`.
* Render file list quick-links in `dom.fileList` with click handlers that post `openFileSnippet` messages back to host with `{path}`.

**Unit tests**:

* Provide test with `previewText` only.
* Provide test with `previewHtml` containing a `<script>` tag; assert script removed.

### Handler: `progressHandler`

**Incoming**: `{ type: 'progress', payload: { phase: string, percent?: number, message?: string } }

**Validation**:

* `phase` must be one of `['scan','filter','tokenize','ingest','write']`.
* `percent`, if present, is 0-100.

**Side effects**:

* Update store `store.setState({ progress: { phase, percent, message } })`.
* Update `dom.progressBar.style.width = percent + '%'` when percent provided.
* If `phase === 'ingest' && percent === 100`, display a completion toast and enable the 'Open Result' button.

**Unit tests**:

* Test progress updates render bar width.
* Test unknown phase => log warning but no crash.

### Handler: `remoteRepoLoadedHandler`

**Incoming**: `{ type:'remoteRepoLoaded', payload: { repoUrl: string, tmpDir: string, sha: string, subpath?: string } }

**Validation**:

* `repoUrl` and `sha` must be non-empty strings.
* `tmpDir` must be a string but should not be used in UI verbatim (scrubbed) — only show repoUrl & short sha.

**Side effects**:

* Update store `store.setState({ remoteRepo: { repoUrl, sha, subpath } })`.
* Add a banner in the UI: `Viewing remote repo: ${repoUrl} @ ${shortSha}` with an action button `Open in Explorer` that posts `openTmpDir` back to host when clicked.

**Tests**:

* Ensure banner shows on payload and button posts expected message.

### Handler: `restoredStateHandler`

**Incoming**: `{ type:'restoredState', payload: { selection?: string[], expandState?: object, uiSettings?: object } }

**Validation**:

* All fields optional. Validate arrays/objects shapes.

**Side effects**:

* Merge into store: `store.setState({ selection, expandState, uiSettings })`.
* For selection array, highlight selected file rows.

**Tests**:

* Restore selection and assert row classes updated.

### Handler: `stateHandler` (generic state sync)

**Incoming**: `{ type:'state', payload: { key: string, value: any } }

**Validation**: `key` allowed set: `['preset','redactionOverride','maxFiles','showHidden']`

**Side effects**:

* `store.setState({ [key]: value })` and persist to `localStorage` for permitted keys (not for `redactionOverride` which must be in-memory only).

**Tests**:

* Ensure invalid keys are ignored and a warning is logged.

### Handler: `configHandler`

**Incoming**: `{ type:'config', payload: { settings: object } }`

**Validation**: `settings` must be object; sanitize keys to allowed config keys.

**Side effects**:

* Render compact summary of current settings in `dom.configSummary`.

**Tests**:

* Pass sample settings and assert DOM summary contains expected keys.

### Handler: `generationResultHandler`

**Incoming**: `{ type:'generationResult', payload: { uri?: string, content?: string, format: 'markdown'|'json'|'text', errors?: any[] } }

**Validation**:

* If `uri` provided, prefer showing a link `Open result` which posts `openUri` message to host.
* If `content` > 20000 chars, prefer showing a truncated preview with `Show full` button that requests `fetchFullResult` from host.

**Side effects**:

* Update store with `lastGeneration: { uri, format }` and render the preview in `dom.previewContainer`.

**Tests**:

* Test with `content` small and large.

### Handler: `ingestErrorHandler`

**Incoming**: `{ type:'ingestError', payload: { message: string, code?: string, details?: string } }

**Validation**:

* Sanitize `details` through `redactSecrets` before rendering.

**Side effects**:

* Show an error banner with sanitized message and a `Report` button that posts `reportError` to host with scrubbed details.
* Append sanitized error to `store.state.errors`.

**Tests**:

* Error with a sample secret must be sanitized in UI and in stored state.

### Handler: `previewDeltaHandler` (incremental preview updates)

**Incoming**: `{ type:'previewDelta', payload: { patches: Array<{op:'append'|'replace', selector:string, content:string}> } }

**Validation**:

* `patches` is an array of small ops. Reject if total length > 200KB to avoid DOM jank.

**Side effects**:

* Apply patches to DOM in a batched `requestAnimationFrame` loop. Update `store.preview.patchVersion`.

**Tests**:

* Apply two patches and assert final DOM content.

---

### Common testing utilities for handlers

* Provide a `__tests__/domFixture.js` helper that creates a minimal DOM with expected selectors and returns `{dom, getPostedMessages}` where `getPostedMessages` captures `postMessage` calls.
* Each handler test should use `jest.spyOn(window, 'postMessage')` or the capture helper.

---

**Final note**: When generating handler modules, Copilot must include TypeScript/JSDoc comments describing the expected envelope shapes and include defensive runtime validation. Avoid introducing heavy dependencies in webview code; prefer small, dependency-free validation.
