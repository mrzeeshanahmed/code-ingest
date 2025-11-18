# Milestone 0 Verification Plan

## 1. Summary of Milestone 0
- Extension activation launches the FastAPI backend (`backend/run.py`) via the VS Code extension host.
- Backend prints its uvicorn bind URL to stdout, which the extension parses and stores for later API calls.
- Backend endpoints:
  - `GET /health` → `{ "status": "ok" }`.
  - `POST /query` → `{ "echo": <request payload>, "repo_id": <string>, "msg": "backend received it" }` and logs `RECEIVED_QUERY`.
- Backend stdout/stderr is mirrored to the `Code-Ingest: Local RAG` VS Code `OutputChannel`.
- Extension registers commands `code-ingest.pingBackend` and `code-ingest.testQuery` through the VS Code command registry.
- Extension deactivation tears down the child backend process without leaving uvicorn/python processes.

## 2. Test Matrix

### M0-STARTUP-1 — Backend starts and URL is detected from stdout
- **Preconditions:** Clean workspace, dependencies installed (`npm install`, backend `pip install -r backend/requirements.txt`).
- **Steps:**
  1. Launch VS Code extension tests (or debug session) so the extension activates.
  2. Hook backend stdout via spawned-process listener in the extension harness.
  3. Wait for uvicorn banner and URL line (e.g., `INFO:     Started server process [PID]` plus `Uvicorn running on http://127.0.0.1:PORT`).
- **Expected result:** URL string captured and stored in extension state; backend process PID recorded.
- **Failure mode:** No URL printed, malformed URL, backend never spawns, or extension fails to parse.
- **Automation detection:** Integration harness asserts that the URL regex matches stdout, failing the test if not emitted within timeout.

### M0-API-1 — `/health` returns correct JSON
- **Preconditions:** Backend running with URL known.
- **Steps:**
  1. Python integration test issues `requests.get(f"{url}/health")`.
  2. Assert HTTP 200 and JSON body equality.
- **Expected result:** Response exactly `{"status":"ok"}`.
- **Failure mode:** Non-200 status, JSON mismatch, timeout.
- **Automation detection:** Test compares parsed JSON to expected dict and fails with diff when mismatch/timeout occurs.

### M0-API-2 — `/query` echoes input and logs `RECEIVED_QUERY`
- **Preconditions:** Backend running; log capture subscribed.
- **Steps:**
  1. Python test sends `POST /query` with payload `{"echo":"hello","repo_id":"demo"}`.
  2. Monitor backend stdout for `RECEIVED_QUERY` line referencing the payload.
- **Expected result:** HTTP 200 with body `{"echo":"hello","repo_id":"demo","msg":"backend received it"}` and matching log line.
- **Failure mode:** Missing fields, wrong message, log absent, or HTTP failure.
- **Automation detection:** Test asserts response structure and scans captured logs for regex `RECEIVED_QUERY.*hello` before timing out.

### M0-EXT-CMD-1 — `code-ingest.pingBackend`
- **Preconditions:** Extension compiled; VS Code Test API harness ready.
- **Steps:**
  1. Use `@vscode/test-api` to load the extension in an integration suite.
  2. Execute command `vscode.commands.executeCommand("code-ingest.pingBackend")`.
  3. Wait for promise resolution and inspect side effects (e.g., notification/log message).
- **Expected result:** Command succeeds, reaching backend `/health` and surfacing success signal (status message or info log).
- **Failure mode:** Command rejected, timeout, backend not contacted.
- **Automation detection:** Test asserts that the command resolves and that mocked output channel or telemetry records the expected acknowledgement string.

### M0-EXT-CMD-2 — `code-ingest.testQuery`
- **Preconditions:** Same as M0-EXT-CMD-1, plus backend reachable.
- **Steps:**
  1. Execute `code-ingest.testQuery` via VS Code Test API.
  2. Command should call backend `/query` with canned payload.
  3. Capture returned JSON and UI/output message.
- **Expected result:** Command completes without exception and surfaces backend echo response.
- **Failure mode:** Command throws, backend rejects request, output missing.
- **Automation detection:** Test mocks message sink / output channel and asserts that the backend response text is logged within timeout.

### M0-LOGS-1 — OutputChannel contains backend logs
- **Preconditions:** Extension activated with backend logging enabled.
- **Steps:**
  1. Trigger backend activity (e.g., ping/testQuery).
  2. Use VS Code Test API to access the registered `OutputChannel`.
  3. Inspect buffer for uvicorn banner and `RECEIVED_QUERY` entries.
- **Expected result:** `Code-Ingest: Local RAG` channel mirrors backend stdout in chronological order.
- **Failure mode:** Channel missing, empty, or lacks backend lines.
- **Automation detection:** Test asserts that `OutputChannel` exists and that its `content` includes regex patterns for uvicorn + query log.

### M0-SHUTDOWN-1 — Backend stops on deactivate
- **Preconditions:** Backend running under extension control.
- **Steps:**
  1. Programmatically trigger extension deactivation via VS Code Test API.
  2. Observe backend process handle.
- **Expected result:** Backend process exits within grace period; no listener sockets remain bound.
- **Failure mode:** Process stays alive, socket still listening, promise not resolved.
- **Automation detection:** Lifecycle script waits on child process exit with timeout and fails if PID persists or port remains open.

### M0-NO-ORPHANS-1 — No uvicorn or `backend/run.py` processes remain
- **Preconditions:** Immediately after M0-SHUTDOWN-1.
- **Steps:**
  1. Run OS process checker script (`psutil` on Windows) filtering for `uvicorn`, `python backend/run.py`, `python.exe -m uvicorn`.
  2. Ensure zero matches.
- **Expected result:** No leftover processes from Code-Ingest backend.
- **Failure mode:** At least one matching process still running.
- **Automation detection:** Script exits non-zero and prints offending PIDs when matches exist; acceptance runner aggregates result.

## 3. Test Artifacts Produced Later
- Python integration tests covering `/health` and `/query` (likely under `backend/tests/`) using `pytest` + `requests`.
- Python lifecycle verifier that spawns backend, observes stdout, and confirms clean shutdown (used by M0-STARTUP-1 and M0-SHUTDOWN-1).
- Node-based VS Code extension tests (using `@vscode/test-api`) executing `code-ingest.pingBackend` and `code-ingest.testQuery`, asserting OutputChannel contents.
- Cross-platform process checker script (PowerShell + Python fallback) validating no orphaned uvicorn processes post-tests.
- Acceptance runner (e.g., npm script) orchestrating the above artifacts sequentially and collecting artifacts/logs for CI.

## 4. Manual Validation Steps
1. **Activate backend virtualenv:**
   - Windows PowerShell: `python -m venv .venv && .\.venv\Scripts\Activate.ps1`
   - macOS/Linux: `python3 -m venv .venv && source .venv/bin/activate`
2. **Install backend deps & run manually:**
   - `pip install -r backend/requirements.txt`
   - `python backend/run.py`
3. **Probe APIs manually:**
   - `curl http://127.0.0.1:8000/health`
   - `curl -X POST http://127.0.0.1:8000/query -H "Content-Type: application/json" -d '{"echo":"hi","repo_id":"manual"}'`
4. **Debug extension:** Launch VS Code `Run → Start Debugging` with `Extension` config; confirm backend starts and logs appear.
5. **Run commands:** In VS Code Command Palette, execute `Code-Ingest: Ping Backend` and `Code-Ingest: Test Query`; confirm notifications/logs.
6. **Inspect OutputChannel:** Open `View → Output`, choose `Code-Ingest: Local RAG`, verify uvicorn banner and query logs.
7. **Verify backend termination:** After stopping debug session, run `tasklist | findstr /I uvicorn` (Windows) or `ps aux | grep uvicorn` (macOS/Linux) to confirm no backend processes remain.
