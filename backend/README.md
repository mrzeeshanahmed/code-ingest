# Code Ingest Backend

This backend provides the local Retrieval-Augmented Generation (RAG) server that the VS Code extension launches. It exposes simple health and query endpoints so the extension can ingest repository context and respond to user prompts locally.

## 1. Prepare a Python Environment

### macOS / Linux (bash / zsh)
```bash
python3 -m venv .venv
source .venv/bin/activate
```

### Windows PowerShell
```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
```

## 2. Install Dependencies
Install everything listed in `backend/requirements.txt`:

```bash
pip install -r backend/requirements.txt
```

> The same command works in PowerShell when the virtual environment is active.

## 3. Run the Backend Manually
From the repository root (where `backend/` lives):

```bash
python backend/run.py
```

The server binds to `127.0.0.1` and picks the port from `CODE_INGEST_PORT` (or an OS-assigned port when the variable is unset/invalid). Watch the console for `Uvicorn running on http://127.0.0.1:<PORT>` and `BACKEND_STARTUP …`.

## 4. Smoke Tests
Assuming the server printed `http://127.0.0.1:43880`:

### Health check
```bash
curl http://127.0.0.1:43880/health
```
Expected response:
```json
{"status":"ok"}
```

### Query endpoint
```bash
curl -X POST http://127.0.0.1:43880/query \
     -H "Content-Type: application/json" \
     -d '{"repo_id":"abc","query":"hello"}'
```
Expected response:
```json
{"echo":"hello","repo_id":"abc","msg":"backend received it"}
```
The backend console should log both `RECEIVED_QUERY …` and `QUERY_BODY …` lines for each POST.

## 5. Troubleshooting
- **Python not found:** Ensure Python 3.8+ is installed and on your PATH. Re-open VS Code or your terminal after installation.
- **Port already in use:** Set `CODE_INGEST_PORT` to another value (or leave unset to let uvicorn choose). Example:
  ```powershell
  $env:CODE_INGEST_PORT = 43885
  python backend/run.py
  ```
- **Dependency errors:** Re-run `pip install -r backend/requirements.txt` inside the virtual environment. Confirm you activated `.venv` before installing.
- **No logs in VS Code:** Use the command palette entry `Code Ingest: Show Logs` to open the "Code-Ingest: Local RAG" Output Channel.
