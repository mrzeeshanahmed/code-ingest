/**
 * @jest-environment jsdom
 */
/*
 * Follow instructions in copilot-instructions.md exactly.
 */

describe("ProgressHandler selection progress", () => {
  let ProgressHandler;
  let UIRenderer;
  let createMockStore;

  const bootstrapDocument = () => {
    document.body.innerHTML = `
      <div class="layout">
        <section class="status-strip">
          <span data-element="status-primary"></span>
        </section>
        <details id="panel-status" open>
          <div class="progress" role="group">
            <div class="progress__track" role="progressbar">
              <div class="progress__indicator"></div>
            </div>
            <p class="progress__message status__message"></p>
          </div>
          <div class="progress__log status__log" data-element="status-log"></div>
        </details>
      </div>`;
  };

  beforeAll(async () => {
    ({ ProgressHandler } = await import("../progressHandler.js"));
    ({ UIRenderer } = await import("../../uiRenderer.js"));
    ({ createMockStore } = await import("./testUtils.js"));
    window.vscode = { postMessage: jest.fn() };
  });

  afterAll(() => {
    delete window.vscode;
  });

  beforeEach(() => {
    bootstrapDocument();
  });

  it("coalesces select progress logs and clears overlay on completion", async () => {
    const renderer = new UIRenderer(document);
    const store = createMockStore();
    const handler = new ProgressHandler(store, renderer, { postMessage: jest.fn(), log: console });

    const progressId = "select-test";
    const emit = async (percent, message, overlayMessage) => {
      await handler.process("progress", {
        progressId,
        phase: "select",
        percent,
        message,
        overlayMessage
      });
    };

    await emit(10, "Selecting 10 of 104 files", "Selecting files…");
    expect(renderer.loadingOverlay).not.toBeNull();
    expect(renderer.pipelineLogEntries).toEqual(["Selecting files: Selecting 10 of 104 files"]);

    await emit(50, "Selecting 52 of 104 files", "Selecting files…");
    expect(renderer.pipelineLogEntries).toEqual(["Selecting files: Selecting 52 of 104 files"]);

    await emit(100, "Selection complete");

    expect(renderer.pipelineLogEntries).toEqual(["Selecting files: Selection complete"]);
    expect(renderer.pipelineLog.textContent).toBe("Selecting files: Selection complete");
    expect(renderer.loadingOverlay).toBeNull();
    expect(renderer.pipelineSection.dataset.phase).toBe("idle");
    expect(renderer.pipelineMessage.textContent).toBe("Selection complete");
  });

  it("resets pipeline log between selection and digest runs", async () => {
    const renderer = new UIRenderer(document);
    const store = createMockStore();
    const handler = new ProgressHandler(store, renderer, { postMessage: jest.fn(), log: console });

    await handler.process("progress", {
      progressId: "select-1",
      phase: "select",
      percent: 100,
      message: "Selection complete"
    });

    expect(renderer.pipelineLogEntries).toEqual(["Selecting files: Selection complete"]);

    await handler.process("progress", {
      progressId: "digest-1",
      phase: "ingest",
      percent: 10,
      message: "Scanning workspace…"
    });

    expect(renderer.pipelineLogEntries).toEqual(["Ingesting: Scanning workspace…"]);
    expect(renderer.pipelineSection.dataset.phase).toBe("ingest");
  });
});