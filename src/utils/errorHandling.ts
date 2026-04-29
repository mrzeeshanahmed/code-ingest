export interface WrappedErrorMetadata {
  readonly [key: string]: unknown;
}

export interface ErrorWithMetadata extends Error {
  readonly metadata?: WrappedErrorMetadata;
  readonly cause?: unknown;
}

function assignMetadata(target: Error, metadata?: WrappedErrorMetadata, cause?: unknown): Error {
  const enriched = target as ErrorWithMetadata & { metadata?: WrappedErrorMetadata; cause?: unknown };
  if (metadata) {
    enriched.metadata = { ...(enriched.metadata ?? {}), ...metadata };
  }
  if (cause !== undefined && enriched.cause === undefined) {
    enriched.cause = cause;
  }
  return enriched;
}

/**
 * Wraps an unknown error with optional metadata context. If the provided value is already
 * an Error, its stack and name are preserved while augmenting with contextual details.
 */
export function wrapError(error: unknown, metadata?: WrappedErrorMetadata): Error {
  if (error instanceof Error) {
    return assignMetadata(error, metadata);
  }

  const normalizedMessage = typeof error === "string" ? error : "Unknown error";
  const wrapped = new Error(normalizedMessage);
  return assignMetadata(wrapped, metadata, error);
}