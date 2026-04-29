Remaining Architectural Risks
Risk 1: SingleWriterQueue VFS Drain — No Timeout Contract
The queue spec in Step 2.4 mandates: "the queue MUST await Asyncify VFS drain before accepting the next write batch". This is correct, but neither the PRD nor the plan specifies what happens if xSync (the Asyncify VFS sync call that drives drain completion) hangs — for example on a slow NFS mount, a suspended laptop, or a locked file handle on Windows. There is no timeout or watchdog on the VFS drain await. In practice, this can deadlock the writer queue indefinitely with no user signal and no recovery path.

Fix: Add a vfsDrainTimeoutMs constant (default 5000) to constants.ts. The queue's drain-await must race against this timeout, and on timeout, emit a warning to the Output Channel and mark the root runtime degraded (but not disposed). This is a one-line change in specification but critical in production.

Risk 2: KnowledgeService Synthesis Pool — Reader-Writer Coordination Gap
Step 6.4 caps synthesis concurrency at 2–3 per root and specifies that Merkle reads must "coordinate with the writer queue so knowledge refresh never reads half-applied write batches". However, the mechanism for this coordination is unspecified. The SingleWriterQueue only exposes write-side flushing — it has no read-side advisory lock or generation counter that KnowledgeService can wait on. Without a queue-generation concept or a simple awaitDrainedRead() API, a synthesis job that begins a Merkle hash comparison during an in-flight write batch will silently observe stale state.

Fix: Expose a waitForQuiescent(): Promise<void> method on SingleWriterQueue that resolves when no write is active. KnowledgeService must call this before reading directorystate.merklehash for staleness comparison. Add a test that verifies a synthesis job started during a large write batch waits until queue quiescence before reading Merkle state.

Risk 3: @sqlite.org/sqlite-wasm vs wa-sqlite — No Evaluation Gate
The plan installs wa-sqlite as the normative runtime (Step 1.2) and the PRD designates it as "the reference v1 runtime". As noted previously, the official @sqlite.org/sqlite-wasm is more actively maintained. This is acceptable as a v1 decision — but there is no evaluation gate or future migration note in either document. If wa-sqlite receives a breaking Asyncify change, there is no documented path to swap the VFS bridge. This becomes a maintenance liability.

Fix: Add a one-paragraph note in Appendix B acknowledging the choice, recording the rationale (Asyncify build stability), and flagging @sqlite.org/sqlite-wasm as the preferred migration target for v2 if wa-sqlite diverges.

Risk 4: @vscode/prompt-tsx — Conditional Usage Is Under-Specified
Both the PRD and the plan say ContextBuilder should "preferably use @vscode/prompt-tsx when its component model can preserve the same boundary and provenance guarantees". The @vscode/prompt-tsx package is listed as a dependency in Step 1.2. But the evaluation criterion for when it can preserve boundary isolation is never defined. A developer will interpret this ambiguously: some will build the manual serializer as the safe path, others will attempt the TSX path and discover halfway through that the boundary escaping contract doesn't compose cleanly with TSX's rendering model. This ambiguity will cause Phase 5 to branch unpredictably.

Fix: Add a spike-and-decide step (Step 5.3a) to Phase 5: build a minimal TSX component that wraps one repository content block with the randomized XML boundary, runs the escapeHtml fixtures through it, and verifies boundary isolation holds. If it passes, proceed with TSX. If not, document the failure mode and commit to the manual serializer. This gates the decision before the full ContextBuilder implementation begins.

Risk 5: DirtyBufferResolver Stale Snapshot Race — Commit Discard Path Missing from Tests
The PRD mandates that if disk mtimeMs advances before commit, "the dirty-buffer write is discarded and the file is re-queued from disk". This is implemented in Step 3.2. However, the integration test matrix in Step 12.2 does not include this specific scenario: a dirty-buffer parse that completes successfully and is waiting in the SingleWriterQueue, but whose file is saved to disk between parse completion and write flush. The queue discard-and-requeue logic will not be covered unless this race is explicitly tested.

Fix: Add one integration test in Phase 12 that: (1) triggers a dirty-buffer parse, (2) simulates an on-disk mtime advance before the queue flush, and (3) asserts the buffer is discarded and the file re-appears in the queue from disk within one debounce cycle.

Risk 6: HNSW Sidecar Compaction — No Trigger Criteria Defined
Step 6.1 exposes a "compaction/rebuild hook" and the PRD states "periodic compaction/rebuild is required because HNSW append behavior degrades over time". Neither document defines what "periodic" means — no node-addition count threshold, no time window, no degradation ratio trigger. Without a concrete trigger, compaction will either never happen (engineers won't implement an undefined threshold) or will be ad-hoc per developer instinct.

Fix: Add to constants.ts: HNSW_COMPACTION_DOC_THRESHOLD = 5000 and HNSW_COMPACTION_STALENESS_RATIO = 0.3 (i.e., if more than 30% of indexed documents are stale, rebuild). SemanticIndexWorker checks these conditions after each batch write. Document both constants in Appendix A under SemanticIndexStore.

New Minor Issues in v1.2.3
codeIngest.knowledge.maxConcurrentSyntheses default is missing. Step 9.3 exposes this setting but Step 6.4 says "2–3 concurrent syntheses" without committing to a default. The constants.ts extension in Step 1.4 should define KNOWLEDGE_MAX_CONCURRENT_SYNTHESES = 2 as the shipped default.

languageModelResolver.ts is listed in Appendix A but has no dedicated implementation step. It appears in Phase 7 Step 7.2's 14-step flow as implicit but is never created as an explicit step. Add a Step 7.0: Create srcservices/languageModelResolver.ts as a pre-condition to copilotParticipant.ts.

The sidebar Ready state mirrors context-window usage requirement (PRD Section 7.9) is described in the PRD but has no corresponding Step in Phase 9. The sidebar state machine step (Step 9.1) covers the four-state shell but omits the token-usage indicator wiring. Add a Step 9.2a to wire the ready-state token estimate from TokenBudgetService into the sidebar panel.

The escapeHtml.ts fixtures cover boundary-collision cases — but Step 5.0 does not specify the character set for the 8-hex randomized boundary tag generation. If the boundary generator uses Math.random() instead of a cryptographically uniform source, repeated boundary prefixes are possible at scale. This should explicitly use crypto.getRandomValues() in the extension host context.

Unified Issues List — Code-Ingest v1.2.3
Each item has been cross-checked against the current PRD (v1.2.3) and Phased Plan (v1.2.3). The status reflects exactly what is and isn't covered in either document today.

🔴 Critical Risks — Not Addressed in Either Document
R1 · SingleWriterQueue VFS Drain — No Timeout Contract
Where: PRD §6.4 Queue Guarantees; Plan Step 2.4

Both documents mandate "the queue MUST await Asyncify VFS drain before accepting the next write batch" but neither defines what happens when xSync hangs. No vfsDrainTimeoutMs constant, no watchdog, no timeout escape, no Output Channel warning, and no degraded-but-not-disposed runtime fallback are specified anywhere.

Required fix: Add VFS_DRAIN_TIMEOUT_MS = 5000 to constants.ts. The queue's drain-await must Promise.race against this timeout. On timeout, emit a warning to the Output Channel and mark the root runtime degraded without disposing it.

R2 · KnowledgeService Reader-Writer Coordination — Mechanism Unspecified
Where: PRD §6.4 Queue Guarantees; Plan Step 6.4

Both documents state the requirement correctly — "coordinate Merkle reads through the writer queue so knowledge refresh never reads half-applied state" — but neither defines the coordination mechanism. There is no waitForQuiescent(): Promise<void> on SingleWriterQueue, no queue-generation counter, and no read-side advisory lock. The requirement is present; the implementation contract is absent.

Required fix: Add waitForQuiescent(): Promise<void> to SingleWriterQueue. KnowledgeService must call this before reading directorystate.merklehash for staleness comparison. Add a test that starts a synthesis job mid-write-batch and asserts it waits for quiescence before reading Merkle state.

R3 · wa-sqlite vs @sqlite.org/sqlite-wasm — No Migration Gate or Rationale
Where: Plan Appendix B (listed in ToC as "Gap Traceability Summary" but contains no runtime selection note)

wa-sqlite is installed as the normative runtime in Step 1.2 with no documented evaluation rationale and no migration path. Appendix B as it stands contains no paragraph acknowledging the choice, recording the Asyncify build-stability rationale, or flagging @sqlite.org/sqlite-wasm as the v2 migration target.

Required fix: Add a one-paragraph note to Appendix B recording why wa-sqlite was chosen over @sqlite.org/sqlite-wasm for v1, and flag the official package as the preferred migration target for v2 if the Asyncify build diverges.

R4 · @vscode/prompt-tsx Evaluation Criterion Undefined
Where: PRD §7.7; Plan Step 5.3

Both documents say "preferably uses @vscode/prompt-tsx when that path can preserve the same boundary and provenance guarantees" but neither defines what "can preserve" means in practice. No spike step exists before Step 5.3 builds the full ContextBuilder. This will cause Phase 5 to branch unpredictably mid-implementation.

Required fix: Add Step 5.3a: build a minimal TSX component wrapping one repository content block with a randomized XML boundary, run the escapeHtml fixture suite through it, and verify boundary isolation holds. Gate the decision before the full ContextBuilder build begins. Document the outcome in the plan.

R5 · DirtyBufferResolver Stale Snapshot Race — Integration Test Missing
Where: PRD §6.4 Dirty Buffer and Worker Boundary; Plan Steps 3.2, 12.2

Step 3.2 correctly specifies that "if disk mtimeMs advances before commit, the dirty-buffer write is discarded and the file is re-queued from disk." However, the integration test matrix in Step 12.2 does not include this specific race: a dirty-buffer parse that completes and is queued, but whose file is saved to disk between parse completion and queue flush.

Required fix: Add one integration test in Phase 12 that: (1) triggers a dirty-buffer parse, (2) simulates an mtime advance before queue flush, and (3) asserts the buffer is discarded and the file re-appears in the queue from disk within one debounce cycle.

R6 · HNSW Sidecar Compaction — No Trigger Criteria
Where: PRD §6.3 State and Semantic Artifact Tables, §7.15; Plan Step 6.1

The PRD states "periodic compaction/rebuild is required because HNSW append behavior degrades over time" and Step 6.1 exposes rebuild/compaction hooks on SemanticIndexWorker. Neither document defines what "periodic" means: no document-addition threshold, no staleness ratio, and no time window. Without a concrete trigger, compaction will either never be implemented or will be ad-hoc per developer instinct.

Required fix: Add HNSW_COMPACTION_DOC_THRESHOLD = 5000 and HNSW_COMPACTION_STALENESS_RATIO = 0.3 to constants.ts. SemanticIndexWorker checks these conditions after each batch write. Document both in Appendix A under SemanticIndexStore.

🟡 Minor Issues — Requirement Present, Implementation Detail Missing
M1 · KNOWLEDGE_MAX_CONCURRENT_SYNTHESES Not Formalized in constants.ts
Where: PRD §7.14 Rules; Plan Steps 6.4, 9.3

The PRD says "default maximum of 2 concurrent syntheses" and Step 6.4 says "2–3 concurrent node/module syntheses." Step 9.3 exposes codeIngest.knowledge.maxConcurrentSyntheses as a user-facing setting, but the Step 1.4 constants.ts extension never defines KNOWLEDGE_MAX_CONCURRENT_SYNTHESES = 2 as the shipped default. The setting and the constant will be implemented inconsistently.

Required fix: Add KNOWLEDGE_MAX_CONCURRENT_SYNTHESES = 2 to Step 1.4's constants.ts extension. Step 6.4 and Step 9.3 should both reference this constant rather than inline integers.

M2 · languageModelResolver.ts Has No Dedicated Implementation Step
Where: PRD §5.3 New Modules; Plan Phase 7

src/services/languageModelResolver.ts is listed in the module disposition table and is referenced implicitly in Step 7.2's 14-step flow (steps 3–5), but no step says "create this file." A developer implementing Phase 7 in sequence will create copilotParticipant.ts before the resolver exists, introducing either an import-time error or an inline stub that becomes permanent.

Required fix: Add Step 7.0: "Create src/services/languageModelResolver.ts as a pre-condition to copilotParticipant.ts." Specify its public API: resolveModel(request: vscode.ChatRequest): Promise<vscode.LanguageModelChat>.

M3 · Sidebar Ready-State Token-Usage Indicator — No Wiring Step
Where: PRD §7.9 Ready-State Sections, §15 Definition of Done; Plan Step 9.2

PRD §7.9 lists "retrieval controls and context-window indicator" as a required Ready-state section. The Definition of Done confirms "token-usage indicators remain consistent in Ready state." Step 9.2 builds the Ready-state sections but contains no sub-step that wires the TokenBudgetService estimate into the sidebar panel. The section will be built as a static shell with no live token estimate.

Required fix: Add Step 9.2a: wire the Ready-state token estimate from TokenBudgetService.estimate() into the sidebar panel's context-window indicator. Define the message envelope type for the sidebar's token-budget update.

M4 · escapeHtml.ts Boundary Tag RNG Source Unspecified
Where: PRD §8.3 Prompt Injection Isolation; Plan Step 5.0

Both documents specify "8-hex randomized boundary tags regenerated each chat turn" but neither specifies that the source must be crypto.getRandomValues() rather than Math.random(). Math.random() is seeded with a predictable 32-bit state; repeated boundary prefix collisions become possible at scale and the isolation guarantee weakens.

Required fix: Step 5.0 must explicitly state: "boundary tag generation MUST use crypto.getRandomValues(new Uint8Array(4)) in the extension host context. Math.random() is out of spec for security-sensitive boundary generation."