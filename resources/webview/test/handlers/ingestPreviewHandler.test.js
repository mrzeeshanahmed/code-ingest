/*
 * Follow instructions in copilot-instructions.md exactly.
 */

const { IngestPreviewHandler } = require("../../handlers/ingestPreviewHandler.js");
const { TestUtils } = require("../setup.js");

describe("IngestPreviewHandler", () => {
  let handler;
  let mockStore;
  let mockUIRenderer;

  beforeEach(() => {
    mockStore = TestUtils.createMockStore({
      preview: {
        content: "",
        tokenCount: null,
        truncated: false
      }
    });
    mockUIRenderer = TestUtils.createMockUIRenderer();
    handler = new IngestPreviewHandler(mockStore, mockUIRenderer, { log: console });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe("validate", () => {
    it("accepts valid preview payload", () => {
      const payload = {
        previewId: "preview-1",
        content: "test content",
        tokenCount: { total: 100 },
        format: "markdown"
      };
      const result = handler.validate(payload);
      expect(result.ok).toBe(true);
    });

    it("allows payload without content", () => {
      const payload = {
        previewId: "preview-2",
        tokenCount: { total: 100 },
        format: "markdown"
      };
      const result = handler.validate(payload);
      expect(result.ok).toBe(true);
      expect(result.value.content).toBeUndefined();
    });

    it("rejects payload with invalid format", () => {
      const payload = {
        previewId: "preview-3",
        content: "test content",
        tokenCount: { total: 100 },
        format: "invalid"
      };
      const result = handler.validate(payload);
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("invalid enum value");
    });

    it("normalizes payload with negative token count", () => {
      const payload = {
        previewId: "preview-4",
        content: "test content",
        tokenCount: { total: -10 },
        format: "markdown"
      };
      const result = handler.validate(payload);
      expect(result.ok).toBe(true);
      expect(result.value.tokenCount.total).toBe(0);
    });
  });

  describe("handle", () => {
    it("updates store with preview content", async () => {
      const payload = {
        previewId: "preview-5",
        content: "test content",
        tokenCount: { total: 150 },
        format: "markdown",
        truncated: false
      };

      await handler.handle(payload);

      expect(mockStore.setState).toHaveBeenCalledWith(
        expect.objectContaining({
          preview: expect.objectContaining({
            content: "test content",
            tokenCount: { total: 150 },
            format: "markdown",
            truncated: false
          })
        })
      );
    });

    it("updates UI renderer with preview state", async () => {
      const payload = {
        previewId: "preview-6",
        content: "preview",
        tokenCount: { total: 150 },
        format: "markdown"
      };

      await handler.handle(payload);

      expect(mockUIRenderer.updatePreview).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "preview-6",
          content: "preview",
          format: "markdown"
        })
      );
      expect(mockUIRenderer.setTokenCount).toHaveBeenCalledWith({ total: 150 });
    });

    it("handles empty preview content", async () => {
      const payload = {
        previewId: "preview-7",
        content: "",
        tokenCount: { total: 0 },
        format: "markdown"
      };

      await expect(handler.handle(payload)).resolves.not.toThrow();
      expect(mockStore.setState).toHaveBeenCalled();
    });

    it("handles large preview content efficiently", async () => {
      const largeContent = "x".repeat(100_000);
      const payload = {
        previewId: "preview-8",
        content: largeContent,
        tokenCount: { total: 1000 },
        format: "markdown"
      };

      const startTime = performance.now();
      await handler.handle(payload);
      const endTime = performance.now();

      expect(endTime - startTime).toBeLessThan(150);
    });
  });

  describe("canHandle", () => {
    it("returns true for ingestPreview", () => {
      expect(handler.canHandle("ingestPreview")).toBe(true);
    });

    it("returns false for other message types", () => {
      expect(handler.canHandle("progress")).toBe(false);
      expect(handler.canHandle("treeData")).toBe(false);
    });
  });
});