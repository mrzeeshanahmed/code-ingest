export enum PIIPolicyMode {
  Strict = "strict",
  Mask = "mask",
  Allow = "allow"
}

export interface PIIResult {
  detected: boolean;
  redactedContent?: string;
  tags?: string[];
}

const PII_PATTERNS = {
  email: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
  ipv4: /\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}\b/g,
  // A generic secret heuristic (e.g., matching basic tokens, api keys, though simple here)
  genericSecret: /([a-zA-Z0-9_-]*(?:api_key|secret|token)[a-zA-Z0-9_-]*\s*[:=]\s*["']?)([a-zA-Z0-9\-_]{16,})(["']?)/gi
};

export class PIIService {
  private mode: PIIPolicyMode;

  constructor(mode: PIIPolicyMode = PIIPolicyMode.Strict) {
    this.mode = mode;
  }

  public setMode(mode: PIIPolicyMode): void {
    this.mode = mode;
  }

  public getMode(): PIIPolicyMode {
    return this.mode;
  }

  public scanAndRedact(content: string, isComment: boolean = false): PIIResult {
    if (this.mode === PIIPolicyMode.Allow) {
      return { detected: false };
    }

    let detected = false;
    let redactedContent = content;
    const tags: Set<string> = new Set();

    // Scan Emails
    if (PII_PATTERNS.email.test(redactedContent)) {
      detected = true;
      tags.add("email");
      if (this.mode === PIIPolicyMode.Mask) {
        redactedContent = redactedContent.replace(PII_PATTERNS.email, "[REDACTED_EMAIL]");
      } else if (this.mode === PIIPolicyMode.Strict) {
        redactedContent = redactedContent.replace(PII_PATTERNS.email, "***");
      }
    }

    // Scan IPv4
    if (PII_PATTERNS.ipv4.test(redactedContent)) {
      detected = true;
      tags.add("ipv4");
      if (this.mode === PIIPolicyMode.Mask) {
        redactedContent = redactedContent.replace(PII_PATTERNS.ipv4, "[REDACTED_IP]");
      } else if (this.mode === PIIPolicyMode.Strict) {
        redactedContent = redactedContent.replace(PII_PATTERNS.ipv4, "***");
      }
    }

    // Scan Generic Secrets
    if (PII_PATTERNS.genericSecret.test(redactedContent)) {
      detected = true;
      tags.add("secret");
      if (this.mode === PIIPolicyMode.Mask) {
        redactedContent = redactedContent.replace(PII_PATTERNS.genericSecret, "$1[REDACTED_SECRET]$3");
      } else if (this.mode === PIIPolicyMode.Strict) {
        redactedContent = redactedContent.replace(PII_PATTERNS.genericSecret, "$1***$3");
      }
    }

    if (!detected) {
      return { detected: false };
    }

    return {
      detected: true,
      redactedContent: redactedContent,
      tags: Array.from(tags)
    };
  }
}
