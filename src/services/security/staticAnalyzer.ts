import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";

import type {
  CodeSnippet,
  SecurityFinding,
  SecurityRule,
  SeverityLevel
} from "./types";

interface FileReader {
  readFile(filePath: string): Promise<string>;
}

const DEFAULT_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".json", ".html"];

export class StaticSecurityAnalyzer {
  private securityRules: SecurityRule[] = [];
  private extensionFiles: string[] = [];
  private readonly fileReader: FileReader;

  constructor(fileReader?: FileReader) {
    this.fileReader = fileReader ?? {
      readFile: async (filePath: string) => fs.readFile(filePath, "utf8")
    };
    this.initializeSecurityRules();
  }

  setExtensionFiles(files: string[]): void {
    this.extensionFiles = [...files];
  }

  async scanCodebase(): Promise<SecurityFinding[]> {
    const files = await this.resolveFileList();
    const findings: SecurityFinding[] = [];

    for (const file of files) {
      const fileFindings = await this.scanFile(file);
      findings.push(...fileFindings);
    }

    return findings;
  }

  private async resolveFileList(): Promise<string[]> {
    if (this.extensionFiles.length > 0) {
      return [...this.extensionFiles];
    }

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
      return [];
    }

    const matches = await vscode.workspace.findFiles("**/*", "**/node_modules/**");
    const filtered = matches
      .map((uri) => uri.fsPath)
      .filter((filePath) => DEFAULT_EXTENSIONS.includes(path.extname(filePath)));

    return filtered;
  }

  private async scanFile(filePath: string): Promise<SecurityFinding[]> {
    try {
      const code = await this.fileReader.readFile(filePath);
      const findings: SecurityFinding[] = [];

      for (const rule of this.securityRules) {
        if (rule.pattern instanceof RegExp) {
          findings.push(...this.runRegexRule(rule, code, filePath));
        } else {
          findings.push(...rule.pattern(code, filePath));
        }
      }

      findings.push(...this.detectCommandInjection(code, filePath));
      findings.push(...this.detectPathTraversal(code, filePath));
      findings.push(...this.detectXSSVulnerabilities(code, filePath));
      findings.push(...this.detectHardcodedSecrets(code, filePath));
      findings.push(...this.detectCryptoVulnerabilities(code, filePath));
      findings.push(...this.detectUnsafeDeserialization(code, filePath));

      return findings;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return [
        {
          id: `FILE_READ_ERROR_${filePath}`,
          ruleId: "FILE_READ_ERROR",
          severity: "MEDIUM",
          category: "DATA_LEAK",
          message: `Unable to scan file: ${message}`,
          filePath,
          line: 0,
          column: 0,
          remediation: "Ensure the file is accessible and readable during the audit"
        }
      ];
    }
  }

  private runRegexRule(rule: SecurityRule, code: string, filePath: string): SecurityFinding[] {
    const findings: SecurityFinding[] = [];
    const regexPattern = rule.pattern as RegExp;
    const flags = regexPattern.flags.includes("g") ? regexPattern.flags : `${regexPattern.flags}g`;
    const regex = new RegExp(regexPattern.source, flags);
    let match: RegExpExecArray | null = regex.exec(code);

    while (match) {
      const index = match.index;
      const { line, column } = this.computeLineColumn(code, index);
      const snippet = this.extractSnippet(code, line);

      const finding: SecurityFinding = {
        id: `${rule.id}_${filePath}_${line}_${column}`,
        ruleId: rule.id,
        severity: rule.severity,
        category: rule.category,
        message: rule.description,
        filePath,
        line,
        column,
        snippet,
        remediation: rule.remediation
      };

      if (rule.references && rule.references.length > 0) {
        finding.references = [...rule.references];
      }

      findings.push(finding);

      match = regex.exec(code);
    }

    return findings;
  }

  private detectCommandInjection(code: string, filePath: string): SecurityFinding[] {
    const patterns = [
      /(exec|spawn|spawnSync|execSync)\s*\(\s*[`'"]([^`'"\n]*\$\{[^}]+\}[^`'"\n]*)[`'"]\s*\)/g,
      /(exec|spawn|spawnSync|execSync)\s*\(\s*templateStringsArray\s*\)/g
    ];
    return this.collectPatternFindings(patterns, "CMD_INJECTION_DYNAMIC", "Potential command injection via dynamic shell command", "INJECTION", "CRITICAL", filePath, code, "Ensure all shell commands are parameterized and user input is validated before execution");
  }

  private detectPathTraversal(code: string, filePath: string): SecurityFinding[] {
    const patterns = [
      /(path\.join|path\.resolve)\s*\([^)]*\.{2}\//g,
      /(fs\.(?:read|write|append)File(?:Sync)?)\s*\([^,]+\.{2}\//g
    ];
    return this.collectPatternFindings(patterns, "PATH_TRAVERSAL_DYNAMIC", "Potential path traversal via unsanitized input", "PATH_TRAVERSAL", "HIGH", filePath, code, "Validate and normalize user-supplied paths before use");
  }

  private detectXSSVulnerabilities(code: string, filePath: string): SecurityFinding[] {
    const patterns = [
      /innerHTML\s*=\s*[^;]+/g,
      /document\.write\s*\(/g,
      /("|')<script[^>]*>/gi
    ];
    return this.collectPatternFindings(patterns, "WEBVIEW_XSS_001", "Potential XSS vector detected", "XSS", "HIGH", filePath, code, "Sanitize HTML output and avoid using innerHTML with untrusted data");
  }

  private detectHardcodedSecrets(code: string, filePath: string): SecurityFinding[] {
    const patterns = [
      /(?:api[_-]?key|secret|password|token)\s*[:=]\s*['"][a-zA-Z0-9+/]{20,}['"]/g,
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g
    ];
    return this.collectPatternFindings(patterns, "HARDCODED_SECRET_GENERIC", "Potential hardcoded secret detected", "DATA_LEAK", "HIGH", filePath, code, "Move secrets to secure storage such as environment variables or secret vaults");
  }

  private detectCryptoVulnerabilities(code: string, filePath: string): SecurityFinding[] {
    const patterns = [
      /crypto\.createHash\(['"]md5['"]\)/gi,
      /crypto\.createCipher\(/gi,
      /openssl\s+enc\s+-des/gi,
      /jwt\.sign\([^,]+,[^,]+,[^)]*algorithm\s*:\s*['"]HS256['"]/gi
    ];
    return this.collectPatternFindings(patterns, "WEAK_CRYPTO_USAGE", "Weak or outdated cryptographic primitive in use", "CRYPTO", "HIGH", filePath, code, "Use modern algorithms (SHA-256+, AES-GCM) and strong key management");
  }

  private detectUnsafeDeserialization(code: string, filePath: string): SecurityFinding[] {
    const patterns = [
      /JSON\.parse\s*\(([^)]+)\)/g,
      /eval\s*\(/g,
      /vm\.runInThisContext\s*\(/g
    ];
    return this.collectPatternFindings(patterns, "UNSAFE_DESERIALIZATION", "Potential unsafe deserialization or code execution", "DESERIALIZATION", "MEDIUM", filePath, code, "Validate and sanitize serialized inputs before parsing or executing");
  }

  private collectPatternFindings(
    patterns: RegExp[],
    ruleId: string,
    message: string,
    category: SecurityRule["category"],
    severity: SeverityLevel,
    filePath: string,
    code: string,
    remediation: string
  ): SecurityFinding[] {
    const findings: SecurityFinding[] = [];
    for (const pattern of patterns) {
      const regex = new RegExp(pattern, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
      let match: RegExpExecArray | null = regex.exec(code);
      while (match) {
        const { line, column } = this.computeLineColumn(code, match.index);
        const snippet = this.extractSnippet(code, line);
        findings.push({
          id: `${ruleId}_${filePath}_${line}_${column}`,
          ruleId,
          severity,
          category,
          message,
          filePath,
          line,
          column,
          snippet,
          remediation
        });
        match = regex.exec(code);
      }
    }
    return findings;
  }

  private computeLineColumn(code: string, index: number): { line: number; column: number } {
    const lines = code.slice(0, index).split(/\r?\n/);
    const line = lines.length;
    const column = lines[lines.length - 1]?.length ?? 0;
    return { line, column };
  }

  private extractSnippet(code: string, line: number, context = 2): CodeSnippet {
    const rows = code.split(/\r?\n/);
    const start = Math.max(line - context - 1, 0);
    const end = Math.min(line + context, rows.length);
    return {
      path: "",
      startLine: start + 1,
      endLine: end,
      content: rows.slice(start, end).join("\n")
    };
  }

  private initializeSecurityRules(): void {
    const regexRule = (
      id: string,
      name: string,
      category: SecurityRule["category"],
      severity: SeverityLevel,
      pattern: RegExp,
      description: string,
      remediation: string,
      cwe: string,
      references?: string[]
    ): SecurityRule => {
      const rule: SecurityRule = {
        id,
        name,
        category,
        severity,
        pattern,
        description,
        remediation,
        cwe
      };

      if (references && references.length > 0) {
        rule.references = [...references];
      }

      return rule;
    };

    this.securityRules = [
      regexRule("CMD_INJECTION_001", "Command Injection in exec/spawn", "INJECTION", "CRITICAL", /(exec|spawn)\s*\(\s*[^)]+\)/g, "Potential command injection vulnerability in exec() call", "Use parameterized commands and validate all user inputs", "CWE-78"),
      regexRule("PATH_TRAVERSAL_001", "Path Traversal Vulnerability", "PATH_TRAVERSAL", "HIGH", /path\.join\s*\([^)]*\.{2}[^)]*\)/g, "Potential path traversal vulnerability", "Validate and sanitize file paths, use path.resolve()", "CWE-22"),
      regexRule("HARDCODED_SECRET_001", "Hardcoded API Key", "DATA_LEAK", "HIGH", /(?:api[_-]?key|secret|password|token)\s*[:=]\s*['"][a-zA-Z0-9+/]{20,}['"]/g, "Hardcoded API key or secret detected", "Move secrets to secure configuration or environment variables", "CWE-798"),
      regexRule("XSS_INNER_HTML", "Unsanitized innerHTML Assignment", "XSS", "HIGH", /innerHTML\s*=\s*[^;]+/g, "innerHTML assignment without sanitization", "Use textContent or sanitize HTML before assignment", "CWE-79"),
      regexRule("UNSAFE_EVAL", "Use of eval", "DESERIALIZATION", "CRITICAL", /eval\s*\(/g, "Use of eval enables arbitrary code execution", "Avoid eval; use safe parsers or interpreters", "CWE-95"),
      regexRule("WEAK_HASH_MD5", "MD5 Hash Usage", "CRYPTO", "MEDIUM", /crypto\.createHash\(['"]md5['"]\)/gi, "MD5 is cryptographically broken", "Use SHA-256 or stronger hashing algorithms", "CWE-327"),
      regexRule("WEAK_HASH_SHA1", "SHA1 Hash Usage", "CRYPTO", "MEDIUM", /crypto\.createHash\(['"]sha1['"]\)/gi, "SHA-1 is deprecated", "Use SHA-256 or stronger hashing algorithms", "CWE-327"),
      regexRule("HARDCODED_JWT_SECRET", "Hardcoded JWT Secret", "DATA_LEAK", "HIGH", /jwt\.sign\([^,]+,[^,]+,[^)]*['"]secret['"]/gi, "Hardcoded JWT secret", "Load secrets from secure storage", "CWE-798"),
      regexRule("BROWSER_ALERT", "Alert Invocation", "XSS", "LOW", /alert\s*\(/g, "Alert used in production code may indicate debugging or XSS payload", "Remove debug statements and ensure alert isn't reachable via input", "CWE-489"),
      regexRule("DOCUMENT_WRITE", "document.write Usage", "XSS", "MEDIUM", /document\.write\s*\(/g, "document.write can introduce XSS", "Avoid document.write; manipulate DOM safely", "CWE-79"),
      regexRule("UNSAFE_HTTP", "Insecure HTTP Request", "DATA_LEAK", "MEDIUM", /http:\/\//gi, "HTTP requests without TLS", "Use HTTPS for all network communications", "CWE-319"),
      regexRule("INSECURE_RANDOM", "Math.random Security", "CRYPTO", "LOW", /Math\.random\s*\(/g, "Math.random is not cryptographically secure", "Use crypto.randomBytes for security-sensitive randomness", "CWE-330"),
      regexRule("WEAK_CIPHER_DES", "DES Cipher Usage", "CRYPTO", "HIGH", /DES|3DES/gi, "DES/3DES are weak ciphers", "Use AES-GCM or ChaCha20", "CWE-327"),
      regexRule("BASIC_AUTH_HEADER", "Basic Auth Header", "DATA_LEAK", "MEDIUM", /Authorization:\s*Basic\s+[A-Za-z0-9+/=]+/gi, "Basic auth credentials detected", "Use OAuth tokens or other secure authentication mechanisms", "CWE-522"),
      regexRule("UNSAFE_REQUIRE_DYNAMIC", "Dynamic require", "DESERIALIZATION", "MEDIUM", /require\s*\(\s*[`'"][^`'"\n]*\+[^)]*\)/g, "Dynamic require may load untrusted modules", "Validate module paths before requiring", "CWE-829"),
      regexRule("UNTRUSTED_FS", "Untrusted Path File Access", "FILE_SYSTEM", "HIGH", /fs\.(?:read|write|append)File\s*\([^)]*\+[^)]*\)/g, "File access with concatenated input", "Normalize and validate file paths", "CWE-73"),
      regexRule("CHILD_PROCESS_FORK", "child_process.fork", "PROCESS", "MEDIUM", /child_process\.fork\s*\(/g, "child_process.fork may execute untrusted code", "Review fork usage and ensure controlled inputs", "CWE-94"),
      regexRule("SHELL_TRUE", "Shell command with true", "PROCESS", "LOW", /shell:\s*true/gi, "Shell execution allowed", "Disable shell execution or validate commands", "CWE-78"),
      regexRule("UNSAFE_IFRAME", "Insecure iframe", "WEBVIEW", "MEDIUM", /<iframe[^>]+src=['"]http:/gi, "Insecure iframe source", "Use secure origins and CSP", "CWE-346"),
      regexRule("MISSING_CSP", "Missing CSP Meta", "WEBVIEW", "MEDIUM", /<meta[^>]+Content-Security-Policy/gi, "Check CSP configuration", "Ensure CSP meta tag is present and strict", "CWE-1021"),
      regexRule("DISABLE_WEB_SECURITY", "Disabled web security", "WEBVIEW", "CRITICAL", /webSecurity\s*:\s*false/gi, "webview webSecurity disabled", "Do not disable web security in webviews", "CWE-1038"),
      regexRule("HARDEN_WEBVIEW", "Allow all scripts", "WEBVIEW", "HIGH", /allow-scripts allow-same-origin/gi, "Overly permissive webview sandbox", "Restrict sandbox permissions", "CWE-1004"),
      regexRule("NODE_INJECTION", "process.env Execution", "INJECTION", "MEDIUM", /process\.env\[[`'"][^`'"\]]+[`'"]\]/g, "Environment variable usage, ensure validation", "Validate environment variables from user input", "CWE-20"),
      regexRule("LOGGING_SECRETS", "Logging secrets", "DATA_LEAK", "MEDIUM", /(console\.(log|error|warn))\s*\([^)]*(password|secret|token)[^)]*\)/gi, "Potential logging of sensitive values", "Avoid logging secrets", "CWE-532"),
      regexRule("UNSAFE_HTTP_SERVER", "Insecure HTTP server", "PROCESS", "MEDIUM", /http\.createServer\s*\(/g, "HTTP server without TLS", "Use HTTPS or reverse proxy with TLS", "CWE-319"),
      regexRule("DIRECT_OS_COMMAND", "Direct OS command", "PROCESS", "HIGH", /(system\(|popen\()|Runtime\.getRuntime\(\)\.exec/gi, "Direct OS command invocation", "Avoid direct OS command execution with untrusted data", "CWE-78"),
      regexRule("TEMP_FILE_INSECURE", "Insecure temp file", "FILE_SYSTEM", "LOW", /os\.tmpdir\(\)/g, "Temp directory usage; ensure secure permissions", "Use secure temporary file patterns and restrict permissions", "CWE-377"),
      regexRule("OPEN_REDIRECT", "Potential open redirect", "WEBVIEW", "MEDIUM", /res\.redirect\s*\([^)]*\)/g, "Potential open redirect", "Validate redirect destinations against allow-list", "CWE-601")
    ];
  }
}
