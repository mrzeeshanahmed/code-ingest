# Code Ingest Developer Guide

This guide captures the concurrency and UI coordination helpers that underpin the hardening work completed in Phases 1–4. These conventions keep host commands predictable and prevent the webview from receiving conflicting status updates.

## Selection Locking

- Use `workspaceManager.withSelectionLock` whenever a command mutates or normalises the selection set. The lock serialises all selection-aware command handlers so they observe a consistent view of the tree.
- `withSelectionLock` accepts a promise-returning callback and releases automatically even when the callback throws. Never await work outside of the callback when you rely on the lock.
- Prefer feeding selection changes back through the manager (`setSelection`, `updateSelection`) so diagnostics and snapshot updates remain centralised.

## Operation Status Registry

- The `WebviewPanelManager` maintains an operation registry keyed by logical operation name (e.g. `digest`, `remoteIngest`). Update it via `updateOperationState(operation, update)`.
- Each state update should include a high-level `status` (`running`, `completed`, `failed`, `cancelled`) and optionally a user-facing `message`. Avoid clearing the entire registry manually—call `updateOperationState(operation, null)` when an operation no longer needs to be tracked.
- The registry automatically emits legacy `status` and `progress` patches for older webview consumers, so always go through the manager instead of mutating snapshots directly.

## Progress Channels & Helpers

- When you emit granular progress, call `updateOperationProgress(operation, progressId, payload)`. Use a stable `progressId` for the lifetime of a run so the client can reconcile incremental updates.
- Progress payloads should specify a `phase`, `message`, and `busy` flag. Include `filesProcessed`, `totalFiles`, or `percent` when meaningful. The helper tolerates partial updates—omit unchanged keys instead of re-sending the whole shape.
- Clear a progress channel only after the owning command completes, using `clearOperationProgress(progressId)`. This keeps concurrent commands (for example, remote ingest followed by a local digest) from wiping one another’s progress bars.
- When running digest-like work, route execution through `workspaceManager.queueDigestOperation`. The queue ensures only one mutation of shared preview/progress state occurs at a time while still allowing commands to enqueue future work.

Following these patterns keeps the extension’s concurrency guarantees intact and lets the dashboard accurately reflect the state of long-running tasks.