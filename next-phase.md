# Next Phase: UX Improvements & Initialization Hardening

## ✅ RESOLVED ISSUES (2026-05-12)

### 1. Initialization Pop-up Moved to Sidebar
**Problem:** The extension showed a modal `showInformationMessage` dialog on every IDE load when the codebase hadn't been initialized. This blocked the IDE and was disruptive.

**Fix applied across 4 files:**

| File | Change |
|------|--------|
| `src/extension.ts` | Removed `vscode.window.showInformationMessage({ modal: true })`. Reorganized `activate()` so `sidebarProvider` is created before `startInitialization`. If `!hasInitialized`, sidebar state is set to `not-initialized` (no auto-init). If already initialized, auto-runs `startInitialization()`. Registered `codeIngest.initializeCodebase` command. |
| `src/providers/sidebarProvider.ts` | Added `onInitialize` callback to `SidebarProviderOptions`. Added `errorMessage` to `SidebarState`. Added `"initialize"` message handler. |
| `resources/webview/sidebar/sidebar.html` | Added 4 overlay states: `not-initialized` (welcome + CTA button), `trust-locked`, `initializing` (animated spinner), `error` (with detail + retry). Existing panels wrapped in `#readyContent`. |
| `resources/webview/sidebar/sidebar.js` | Full state machine via `showView()`: toggles overlays vs ready content based on `status`. "Initialize Codebase" and "Retry" buttons post `"initialize"` message to extension host. |

**Sidebar state flow:**
```
not-initialized → [user clicks "Initialize Codebase"] → initializing → ready
                                                                      ↘ error → [user clicks "Retry"] → initializing → ...
trust-locked → (no action available — user must trust workspace)
```

---

### 2. TypeScript `moduleResolution` Deprecation Warning
**Problem:** `tsconfig.json` used `"moduleResolution": "node"` which is deprecated in TS 7.0 (detected as `node10`).

**Fix:** Added `"ignoreDeprecations": "5.0"` to `compilerOptions` in `tsconfig.json`. We keep `node10` resolution because the project uses `commonjs` modules targeting the VS Code extension host — migrating to `node16`/`bundler` resolution would require `module: "node16"` and explicit `.js` import extensions throughout the codebase.

---

### 3. Missing `sidebar.html` ENOENT Error
**Problem:** `webviewHelpers: Failed to read HTML file at e:\code-ingest\out\resources\webview\sidebar\sidebar.html` — the file didn't exist at runtime.

**Root causes (both fixed):**
1. **Webpack `output.clean: true`** wiped the entire `out/` directory on every build, destroying webview assets copied by `build:webview`. **Fixed:** Set `clean: false` in `webpack.config.js`.
2. **No `tasks.json`** — `launch.json` referenced `${defaultBuildTask}` but no task was defined, so the pre-launch build step either failed silently or wasn't run. **Fixed:** Created `.vscode/tasks.json` with `build:dev` as the default build task.

---

### 4. Missing `.vscode/tasks.json`
**Problem:** `launch.json` references `${defaultBuildTask}` as `preLaunchTask`, but no `tasks.json` existed.

**Fix:** Created `.vscode/tasks.json`:
```json
{
  "version": "2.0.0",
  "tasks": [
    {
      "label": "Build Extension (Dev)",
      "type": "npm",
      "script": "build:dev",
      "group": { "kind": "build", "isDefault": true },
      "problemMatcher": ["$tsc-watch"],
      "presentation": { "reveal": "silent", "panel": "shared" }
    }
  ]
}
```

---

## 🚀 Debug Mode Launch Procedure

### Prerequisites
1. **Node.js** installed (18+ or 20+)
2. **Dependencies installed:** Run `npm install` in the project root if `node_modules/` is missing
3. **VS Code** with the workspace `e:\code-ingest` open

### Step-by-Step: Launch in Debug Mode

#### Option A: F5 (Recommended)

1. Open the project in VS Code: `code e:\code-ingest`
2. Open the **Run and Debug** panel (`Ctrl+Shift+D`)
3. Select **"Run Extension"** from the dropdown (should be pre-selected)
4. Press **F5** (or click the green play button)
5. VS Code will:
   - Run the `build:dev` pre-launch task (`webpack --mode development && npm run build:webview`)
   - Launch a new **Extension Development Host** window with your extension loaded
6. In the Extension Development Host window:
   - Open a folder/workspace to test against
   - Click the **Code-Ingest icon** in the Activity Bar (left sidebar)
   - You should see the **"Welcome to Code-Ingest"** CTA in the sidebar (not a pop-up!)
   - Click **"Initialize Codebase"** to start indexing

#### Option B: Manual Build + Debug

1. Open a terminal in the project root
2. Run the dev build:
   ```bash
   npm run build:dev
   ```
3. Verify the output:
   ```bash
   # Check that sidebar.html exists:
   dir out\resources\webview\sidebar\sidebar.html
   
   # Check that extension.js exists:
   dir out\extension.js
   ```
4. Press **F5** to launch (build task will be skipped since output is fresh)

#### Option C: Command Line Only (No Debug Breakpoints)

1. Build: `npm run build:dev`
2. Launch manually:
   ```bash
   code --extensionDevelopmentPath=e:\code-ingest --disable-extensions
   ```

### What to Verify After Launch

| # | Check | Expected Result |
|---|-------|-----------------|
| 1 | **No modal pop-up** | The "Welcome to Code-Ingest" dialog should NOT appear as a pop-up |
| 2 | **Sidebar CTA** | Click Code-Ingest icon in Activity Bar → see "Welcome" overlay with "Initialize Codebase" button |
| 3 | **No ENOENT error** | Debug Console should NOT show `Failed to read HTML file at...sidebar.html` |
| 4 | **No deprecation warning** | Problems panel should NOT show `moduleResolution=node10 is deprecated` |
| 5 | **Initialize flow** | Click "Initialize Codebase" → sidebar shows spinner → notification progress bar → sidebar shows "Ready" with node/edge counts |
| 6 | **Error handling** | If initialization fails (e.g., disk full), sidebar shows error overlay with message + "Retry" button |
| 7 | **Rebuild works** | After initialization, "Rebuild Graph" button re-indexes and updates counts |
| 8 | **Graph View opens** | "Open Graph View" button opens the graph panel |
| 9 | **Settings** | "Open Settings" button opens settings panel |
| 10 | **Copilot context** | "Send to Copilot" opens Copilot Chat with context injected |

### Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| F5 does nothing / "Could not find task" | Missing `tasks.json` | Already fixed — verify `.vscode/tasks.json` exists |
| Sidebar shows "Unable to load webview" | `out/resources/webview/sidebar/` is empty | Run `npm run build:dev` (webpack + webview copy) |
| TypeScript errors in Problems panel | Type errors in source | Run `npm run type-check` to see details |
| Extension doesn't appear in Activity Bar | Extension failed to activate | Check **Output** → **Code-Ingest** channel for errors |
| `punycode` deprecation warning | Node.js internal deprecation | Harmless — ignore (comes from VS Code internals, not our code) |
| `SQLite is experimental` warning | Node.js built-in SQLite feature flag | Harmless — ignore (comes from `wa-sqlite` WASM detection probe) |

---

## 📋 Files Modified

| File | Type | Summary |
|------|------|---------|
| `tsconfig.json` | MODIFY | Added `"ignoreDeprecations": "5.0"` |
| `webpack.config.js` | MODIFY | Set `output.clean: false` |
| `.vscode/tasks.json` | NEW | Default build task for F5 debug |
| `src/extension.ts` | MODIFY | Removed modal, reorganized activate(), wired sidebar init flow |
| `src/providers/sidebarProvider.ts` | MODIFY | Added `onInitialize`, `errorMessage`, `"initialize"` handler |
| `resources/webview/sidebar/sidebar.html` | MODIFY | Added 4 state overlays, wrapped ready content |
| `resources/webview/sidebar/sidebar.js` | MODIFY | Full state machine, initialize/retry button handlers |

---

## 🔜 Remaining Items (from original next-phase)

### 1. The Lockfile Trap (graph.db.lock)
**Issue:** When the extension host crashes (e.g., due to ENOSPC) or is forcefully closed, `wa-sqlite` leaves behind a `graph.db.lock` file. On the next activation, `GraphDatabase.open()` throws an `EEXIST` error, causing `initializeRoot` to fail permanently.
**Resolution:**
- Update `GraphDatabase.open()` to read the PID from the lockfile.
- Use `process.kill(pid, 0)` to check if the locking process is dead.
- If dead, automatically `fs.unlinkSync()` the stale lockfile and proceed safely.

### 2. Missing "Initializing" UI Feedback — ✅ FIXED
The sidebar now transitions to an `"initializing"` state with a spinner before the indexing loop begins. This was resolved as part of the sidebar state machine implementation.

### 3. Silent Failures / Missing Error State — ✅ FIXED
The sidebar now has an `"error"` state overlay that surfaces the error message when `initializeRoot` throws. Users see what went wrong and can retry.

### 4. Webview "Not Initialized" Empty States & CTA — ✅ FIXED
The sidebar now has distinct overlays for `not-initialized` (with "Initialize Codebase" button) and `trust-locked`. The JavaScript state machine correctly maps all status values.
