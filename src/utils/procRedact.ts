import { spawn } from "node:child_process";

interface SpawnGitOptions {
  secretsToRedact?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

interface SpawnGitError extends Error {
  code?: number | string | null;
  stdout: string;
  stderr: string;
}

function redact(text: string, secrets: readonly string[]): string {
  if (!text) {
    return text;
  }

  let output = text;
  for (const secret of secrets) {
    if (!secret) {
      continue;
    }

    const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    output = output.replace(new RegExp(escaped, "g"), "[REDACTED]");
  }

  return output;
}

function createError(
  message: string,
  code: number | string | null | undefined,
  stdout: string,
  stderr: string
): SpawnGitError {
  const error = new Error(message) as SpawnGitError;
  error.code = code ?? null;
  error.stdout = stdout;
  error.stderr = stderr;
  return error;
}

export async function spawnGitPromise(
  args: string[],
  options: SpawnGitOptions = {}
): Promise<{ stdout: string; stderr: string }> {
  const { secretsToRedact = [], cwd, env } = options;

  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      env,
      shell: false
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      const redactedStdout = redact(stdout, secretsToRedact);
      const redactedStderr = redact(stderr, secretsToRedact);
      const redactedMessage = redact(error.message, secretsToRedact);
      reject(createError(redactedMessage, (error as SpawnGitError).code, redactedStdout, redactedStderr));
    });

    child.on("close", (code, signal) => {
      const redactedStdout = redact(stdout, secretsToRedact);
      const redactedStderr = redact(stderr, secretsToRedact);

      if (code === 0) {
        resolve({ stdout: redactedStdout, stderr: redactedStderr });
        return;
      }

      const command = redact(args.join(" "), secretsToRedact);
      const reason = code !== null ? `exit code ${code}` : `signal ${signal}`;
      const message = `git ${command} failed with ${reason}: ${redactedStderr || redactedStdout}`;
      reject(createError(message, code ?? signal ?? null, redactedStdout, redactedStderr));
    });
  });
}
