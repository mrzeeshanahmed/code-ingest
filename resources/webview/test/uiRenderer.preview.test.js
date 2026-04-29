/**
 * @jest-environment jsdom
 */

const { beforeEach, describe, expect, it } = require("@jest/globals");
const { UIRenderer } = require("../uiRenderer.js");

describe("UIRenderer preview rendering", () => {
  let doc;
  let renderer;

  const bootstrapDocument = () => {
    document.body.innerHTML = `
      <div class="layout">
        <div class="status-strip" role="status">
          <span class="status-chip" data-element="status-config"></span>
        </div>
        <div data-element="insight-config"></div>
      </div>
      <article class="preview" data-state="empty">
        <h1 class="preview__title"></h1>
        <p class="preview__subtitle"></p>
        <div class="preview__content"></div>
        <footer class="preview__footer"></footer>
      </article>
      <div data-element="preview-meta"></div>
      <button type="button" data-action="toggle-redaction">Toggle redaction</button>
    `;
    doc = document;
  };

  beforeEach(() => {
    bootstrapDocument();
    renderer = new UIRenderer(doc);
  });

  it("keeps fallback banner when preview content is empty", () => {
    renderer.updatePreview({
      id: "preview-empty",
      content: "",
      summary: "",
      nodes: [],
      tokenCount: null
    });

    const article = doc.querySelector("article.preview");
    const contentNode = doc.querySelector(".preview__content");

    expect(article.dataset.state).toBe("empty");
    expect(contentNode.textContent).toContain("Run a generation to populate the preview.");
  });

  it("surfaces token truncation info in the preview meta strip", () => {
    renderer.updatePreview({
      id: "preview-token",
      content: "Example",
      tokenCount: { total: 100 }
    });

    renderer.setTokenCount({ approx: 50, truncated: true });

    const meta = doc.querySelector('[data-element="preview-meta"]');

    expect(meta.textContent).toContain("~50 tokens");
    expect(meta.textContent).toContain("Token count truncated");
  });

  it("renders configuration summaries and updates the redaction toggle state", () => {
    renderer.updateConfig({
      summary: {
        statusLine: "Include: src/** · Exclude: Defaults · Redaction: Off",
        lines: [
          "Include patterns: src/**",
          "Exclude patterns: Defaults",
          "Redaction: Disabled (override on)"
        ],
        redactionOverride: true
      }
    });

    const statusChip = doc.querySelector('[data-element="status-config"]');
    const insight = doc.querySelector('[data-element="insight-config"]');
    const toggle = doc.querySelector('[data-action="toggle-redaction"]');

    expect(statusChip.textContent).toContain("Include: src/**");
    expect(insight.textContent).toContain("Include patterns: src/**");
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(toggle.classList.contains("is-active")).toBe(true);
    expect(toggle.textContent).toBe("Disable Redaction");

    renderer.updateConfig({ include: ["docs/**"], redactionOverride: false });

    expect(statusChip.textContent).toContain("docs/**");
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(toggle.textContent).toBe("Enable Redaction");
  });
});