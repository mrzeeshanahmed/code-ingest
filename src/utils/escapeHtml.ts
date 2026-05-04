import * as crypto from "node:crypto";

/**
 * Entity-encode repository content to prevent XML boundary collision.
 * Replaces <, >, &, ", and ' with their HTML entities.
 * Additionally, encodes any text that matches or prefixes
 * the 8-hex boundary tag pattern used for prompt isolation.
 */
export function escapeHtml(text: string): string {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
  return escaped;
}

/**
 * Generate an 8-hex-character random boundary tag using
 * crypto.getRandomValues (NOT Math.random).
 * Each tag is regenerated per chat turn.
 */
export function generateBoundaryTag(): string {
  const bytes = crypto.randomBytes(4);
  return bytes.toString("hex").slice(0, 8);
}

/**
 * Generate opening and closing boundary tag strings.
 * Format: <rcc_a1b2c3d4> and </rcc_a1b2c3d4>
 */
export function generateBoundaryPair(): { open: string; close: string } {
  const hex = generateBoundaryTag();
  return {
    open: `<rcc_${hex}>`,
    close: `</rcc_${hex}>`
  };
}

/**
 * Wrap repository content inside randomized XML boundary tags
 * after entity-encoding the content so it cannot escape the boundary.
 * 
 * @param content - The repository content to wrap
 * @param boundaryTag - The 8-char hex tag (from generateBoundaryTag)
 * @returns XML-wrapped, entity-encoded content block
 */
export function wrapWithBoundary(content: string, boundaryTag: string): string {
  const escaped = escapeHtml(content);
  return `<rcc_${boundaryTag}>\n${escaped}\n</rcc_${boundaryTag}>`;
}

/**
 * Verify that repository content does NOT contain a string that
 * matches or prefixes the boundary tag pattern. Returns true if
 * the content is boundary-safe, false if a collision is detected.
 * 
 * This is used to confirm that entity-encoding has neutralized
 * any boundary-like text in repository content.
 */
export function isBoundarySafe(content: string, boundaryTag: string): boolean {
  const openTag = `<rcc_${boundaryTag}>`;
  const closeTag = `</rcc_${boundaryTag}>`;
  return !content.includes(openTag) && !content.includes(closeTag);
}

/**
 * Build the standard context footer format required by the PRD.
 * 
 * ```
 * ---
 * **Context Used:**
 * - Files: auth.ts, db.ts (2)
 * - Graph nodes: 14
 * - Retrieval depth: 3
 * - Semantic matches: included
 * - Prompt tokens: 1840 verified
 * - PII policy: strict
 * ```
 */
export function buildContextFooter(params: {
  files: string[];
  graphNodes: number;
  retrievalDepth: number;
  semanticMatchesIncluded: boolean;
  promptTokens: number;
  piiPolicy: string;
}): string {
  const fileList = params.files.length > 0
    ? `${params.files.join(", ")} (${params.files.length})`
    : `none (0)`;

  return [
    "",
    "---",
    "**Context Used:**",
    `- Files: ${fileList}`,
    `- Graph nodes: ${params.graphNodes}`,
    `- Retrieval depth: ${params.retrievalDepth}`,
    `- Semantic matches: ${params.semanticMatchesIncluded ? "included" : "excluded"}`,
    `- Prompt tokens: ${params.promptTokens} verified`,
    `- PII policy: ${params.piiPolicy}`
  ].join("\n");
}

/**
 * Collision test fixtures for boundary safety verification.
 * Each fixture is a string that attempts to break XML boundary isolation,
 * and should be rendered harmless by escapeHtml().
 */
export const BOUNDARY_COLLISION_FIXTURES: string[] = [
  // Exact boundary tag collision (open)
  '<rcc_a1b2c3d4>',
  // Exact boundary tag collision (close)
  '</rcc_a1b2c3d4>',
  // Prefix collision
  '<rcc_a1b',
  // Nested XML-looking content
  '<rcc_deadbeef><rcc_cafebabe>untrusted</rcc_cafebabe></rcc_deadbeef>',
  // Unicode and mixed boundary characters
  '<rcc_a1b2c3d4\u200B>',
  // Chained tags
  '<rcc_a1b2c3d4>some content</rcc_a1b2c3d4><rcc_different>',
  // Ampersand-rich content
  '&&&lt;&gt;&quot;',
  // Incomplete boundary fragments
  '<rcc_1234',
  '</rcc_5678'
];
