/*
 * Follow instructions in copilot-instructions.md exactly.
 */

const { describe, expect, it } = require("@jest/globals");
const { validateCommandPayload } = require("../commandValidation.js");
const { COMMAND_MAP } = require("../commandMap.js");

describe("commandValidation", () => {
  it("parses toggle redaction payloads", () => {
    const result = validateCommandPayload(COMMAND_MAP.WEBVIEW_TO_HOST.TOGGLE_REDACTION, { enabled: "true" });
    expect(result).toEqual({ ok: true, value: { enabled: true } });

    const defaultResult = validateCommandPayload(COMMAND_MAP.WEBVIEW_TO_HOST.TOGGLE_REDACTION, {});
    expect(defaultResult).toEqual({ ok: true, value: {} });
  });

  it("normalises preset payloads", () => {
    const emptyResult = validateCommandPayload(COMMAND_MAP.WEBVIEW_TO_HOST.APPLY_PRESET, {});
    expect(emptyResult).toEqual({ ok: true, value: { presetId: "default" } });

    const custom = validateCommandPayload(COMMAND_MAP.WEBVIEW_TO_HOST.APPLY_PRESET, { presetId: " custom " });
    expect(custom).toEqual({ ok: true, value: { presetId: "custom" } });
  });

  it("accepts optional remote repo payload fields", () => {
    const empty = validateCommandPayload(COMMAND_MAP.WEBVIEW_TO_HOST.LOAD_REMOTE_REPO, undefined);
    expect(empty).toEqual({ ok: true, value: {} });

    const payload = {
      repoUrl: "https://github.com/acme/repo",
      ref: "main",
      sparsePaths: ["src", "docs"]
    };
    const valid = validateCommandPayload(COMMAND_MAP.WEBVIEW_TO_HOST.LOAD_REMOTE_REPO, payload);
    expect(valid).toEqual({ ok: true, value: payload });
  });
});