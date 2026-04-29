export interface RedactionRule {
  name: string;
  pattern: RegExp;
}

const PEM_KEY_PATTERN = /-----BEGIN [^-]*?PRIVATE KEY-----[\s\S]+?-----END [^-]*?PRIVATE KEY-----/g;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;
const GENERIC_API_KEY_PATTERN = /\b(?:api[_-]?key|token|access[_-]?key|secret|password)\s*[:=]\s*["']?[A-Za-z0-9_-]{16,}["']?/gi;
const GITHUB_TOKEN_PATTERN = /\bgh[pousr]_?[A-Za-z0-9]{36,}\b/g;
const AWS_ACCESS_KEY_PATTERN = /\bAKIA[0-9A-Z]{16}\b/g;

export const DEFAULT_SECRET_RULES: ReadonlyArray<RedactionRule> = Object.freeze([
  { name: "PEM Private Key", pattern: PEM_KEY_PATTERN },
  { name: "JWT", pattern: JWT_PATTERN },
  { name: "Generic API Key", pattern: GENERIC_API_KEY_PATTERN },
  { name: "GitHub Token", pattern: GITHUB_TOKEN_PATTERN },
  { name: "AWS Access Key", pattern: AWS_ACCESS_KEY_PATTERN }
]);

export function redactSecrets(content: string, rules: ReadonlyArray<RedactionRule> = DEFAULT_SECRET_RULES): string {
  if (!content) {
    return content;
  }

  let redacted = content;
  for (const rule of rules) {
    redacted = redacted.replace(rule.pattern, "[REDACTED]");
  }

  return redacted;
}