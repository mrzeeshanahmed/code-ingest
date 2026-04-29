/*
 * Follow instructions in copilot-instructions.md exactly.
 */

const { TestUtils, mockVSCodeAPI } = require("../setup.js");

let WebviewApplication;
let COMMAND_MAP;

if (typeof window !== "undefined") {
  ({ WebviewApplication } = require("../../main.js"));
  ({ COMMAND_MAP } = require("../../commandMap.js"));
}

const describeOrSkip = typeof window === "undefined" ? describe.skip : describe;

describeOrSkip("Webview integration", () => {
  let app;

  beforeEach(async () => {
    jest.clearAllMocks();
    app = new WebviewApplication();
    await app.initialize();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe("message handling", () => {
    it("processes ingestPreview events", async () => {
      const tokenSpy = jest.spyOn(app.uiRenderer, "setTokenCount");
      const message = {
        type: "ingestPreview",
        payload: {
          previewId: "preview-1",
          content: "test preview content",
          tokenCount: { total: 100 },
          format: "markdown"
        }
      };

      window.dispatchEvent(new MessageEvent("message", { data: message }));

      await TestUtils.waitFor(() =>
        app.store.getState().generation.preview.content === "test preview content"
      );
      expect(tokenSpy).toHaveBeenCalledWith({ total: 100 });
      tokenSpy.mockRestore();
    });

    it("handles progress updates", async () => {
      const message = {
        type: "progress",
        payload: {
          phase: "scan",
          percent: 25,
          message: "Scanning",
          filesProcessed: 25,
          totalFiles: 100
        }
      };

      window.dispatchEvent(new MessageEvent("message", { data: message }));

      await TestUtils.waitFor(() =>
        app.store.getState().generation.progress.percent === 25
      );
      expect(app.store.getState().generation.progress.phase).toBe("scan");
    });

    it("sends commands to the extension host", async () => {
      await app.commandRegistry.execute(COMMAND_MAP.WEBVIEW_TO_HOST.GENERATE_DIGEST, {
        selectedFiles: ["file1.js"],
        outputFormat: "markdown"
      });

      expect(mockVSCodeAPI.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "command",
          command: COMMAND_MAP.WEBVIEW_TO_HOST.GENERATE_DIGEST,
          payload: expect.objectContaining({
            selectedFiles: ["file1.js"],
            outputFormat: "markdown"
          })
        })
      );
    });
  });

  describe("error handling", () => {
    it("reports unhandled errors", async () => {
      const error = new Error("Test error");
      const event = new ErrorEvent("error", {
        error,
        message: error.message,
        filename: "test.js",
        lineno: 10
      });

      window.dispatchEvent(event);

      await TestUtils.waitFor(() =>
        mockVSCodeAPI.postMessage.mock.calls.some(([message]) => message?.type === "error")
      );

      expect(mockVSCodeAPI.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "error",
          command: "reportWebviewError",
          payload: expect.objectContaining({
            error: expect.objectContaining({ message: "Test error" })
          })
        })
      );
    });

    it("ignores malformed messages", () => {
      expect(() => {
        window.dispatchEvent(new MessageEvent("message", { data: { invalid: "message" } }));
      }).not.toThrow();
    });
  });

  describe("performance", () => {
    it("handles rapid progress updates efficiently", () => {
      const start = performance.now();
      for (let index = 0; index < 100; index += 1) {
        const message = {
          type: "progress",
          payload: {
            phase: "scan",
            percent: index,
            message: `Progress ${index}`,
            filesProcessed: index,
            totalFiles: 100
          }
        };
        window.dispatchEvent(new MessageEvent("message", { data: message }));
      }
      const elapsed = performance.now() - start;
      expect(elapsed).toBeLessThan(1000);
    });
  });
});