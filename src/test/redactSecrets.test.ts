import { describe, expect, it } from "@jest/globals";
import { DEFAULT_SECRET_RULES, redactSecrets } from "../utils/redactSecrets";

describe("redactSecrets", () => {
  it("redacts known secret patterns", () => {
    const content = `Private key:\n-----BEGIN PRIVATE KEY-----ABC-----END PRIVATE KEY-----\nToken: abc123`;
    const redacted = redactSecrets(content);
    expect(redacted).toContain("[REDACTED]");
    expect(redacted.match(/PRIVATE KEY/g)).toBeNull();
  });

  it("supports custom rules", () => {
    const content = "api_key=abcdef";
    const rules = [
      {
        name: "custom",
        pattern: /abcdef/
      }
    ];

    expect(redactSecrets(content, rules)).toBe("api_key=[REDACTED]");
  });

  it("returns the original content when no secrets match", () => {
    const text = "nothing to redact";
    expect(redactSecrets(text, DEFAULT_SECRET_RULES)).toBe(text);
  });
});