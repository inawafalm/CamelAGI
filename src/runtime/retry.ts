// Error classification + retry logic for agent runs

export type ErrorKind =
  | "auth"
  | "rate_limit"
  | "server_error"
  | "timeout"
  | "abort"
  | "overflow"
  | "billing"
  | "format"
  | "unknown";

/** Extract HTTP status code from SDK error objects or message */
function extractStatusCode(err: Error): number | undefined {
  // OpenAI SDK and Anthropic SDK both set .status on errors
  const status = (err as any).status ?? (err as any).statusCode;
  if (typeof status === "number") return status;

  // Fallback: extract 3-digit HTTP codes from message — but only when
  // they appear as standalone tokens (e.g. "Error 429" not "model-429b")
  const match = err.message.match(/\b([4-5]\d{2})\b/);
  return match ? Number(match[1]) : undefined;
}

export function classifyError(err: Error): ErrorKind {
  const msg = err.message.toLowerCase();
  const status = extractStatusCode(err);

  // 1. User abort — exact match only (not substring) to avoid collision with timeout
  if (msg === "aborted" || msg === "the operation was aborted" || msg === "this operation was aborted") {
    return "abort";
  }
  // Also check for AbortError name (DOMException style)
  if (err.name === "AbortError") {
    return "abort";
  }

  // 2. Status-code-first classification (more reliable than string matching)
  if (status) {
    if (status === 401 || status === 403) return "auth";
    if (status === 402) return "billing";
    if (status === 429) return "rate_limit";
    if (status === 400 || status === 422) return "format";
    if (status === 408) return "timeout";
    if (status >= 500 && status < 600) return "server_error";
  }

  // 3. String-based fallbacks for errors without status codes
  // Auth
  if (msg.includes("unauthorized") || msg.includes("invalid api key") || msg.includes("token expired")) {
    return "auth";
  }

  // Billing
  if (msg.includes("insufficient") || msg.includes("payment required") || msg.includes("billing")) {
    return "billing";
  }

  // Rate limit
  if (msg.includes("rate limit") || msg.includes("too many requests")
    || msg.includes("quota") || msg.includes("resource exhausted")) {
    return "rate_limit";
  }

  // Context overflow
  if (msg.includes("context") && (msg.includes("exceeded") || msg.includes("too large"))
    || msg.includes("prompt is too long") || msg.includes("request too large")
    || msg.includes("maximum context length")) {
    return "overflow";
  }

  // Timeout (check after abort to avoid misclassification)
  if (msg.includes("timeout") || msg.includes("deadline exceeded") || msg.includes("etimedout")) {
    return "timeout";
  }

  // Server errors
  if (msg.includes("service unavailable") || msg.includes("internal server error")
    || msg.includes("bad gateway")) {
    return "server_error";
  }

  // Format errors
  if (msg.includes("invalid request") || msg.includes("validation")) {
    return "format";
  }

  return "unknown";
}

export function isRetryable(kind: ErrorKind): boolean {
  return kind === "rate_limit" || kind === "timeout" || kind === "server_error";
}

const DEFAULT_MAX_BACKOFF_MS = 30_000;

export interface RetryOpts {
  maxRetries: number;
  backoffMs: number;
  maxBackoffMs?: number;
  onRetry?: (attempt: number, kind: ErrorKind, err: Error) => void;
  onCompact?: () => Promise<void>;
}

/**
 * Wrap an async function with retry logic.
 * - rate_limit/timeout/server_error: retry with capped exponential backoff
 * - overflow: call onCompact() then retry once
 * - auth/billing/format/abort: fail immediately
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOpts,
): Promise<T> {
  let lastError: Error | undefined;
  let overflowRetried = false;
  const maxBackoff = opts.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const kind = classifyError(lastError);

      // Non-retryable errors
      if (kind === "auth" || kind === "billing" || kind === "format" || kind === "abort") {
        throw lastError;
      }

      // Overflow: compact and retry once
      if (kind === "overflow" && !overflowRetried && opts.onCompact) {
        overflowRetried = true;
        opts.onRetry?.(attempt, kind, lastError);
        await opts.onCompact();
        continue;
      }

      // Last attempt — don't retry
      if (attempt === opts.maxRetries) break;

      // Retryable: capped exponential backoff
      if (isRetryable(kind)) {
        opts.onRetry?.(attempt, kind, lastError);
        const delay = Math.min(opts.backoffMs * Math.pow(2, attempt), maxBackoff);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      // Unknown errors: retry once then fail
      if (kind === "unknown" && attempt === 0) {
        opts.onRetry?.(attempt, kind, lastError);
        await new Promise((r) => setTimeout(r, opts.backoffMs));
        continue;
      }

      break;
    }
  }

  throw lastError!;
}
