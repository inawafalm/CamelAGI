import { describe, it, expect } from "vitest";
import { classifyError, isRetryable, withRetry, type ErrorKind } from "../../src/runtime/retry.js";

describe("classifyError", () => {
  const cases: [string, ErrorKind][] = [
    ["aborted", "abort"],
    ["The operation was aborted", "abort"],
    ["401 Unauthorized", "auth"],
    ["invalid api key", "auth"],
    ["403 Forbidden", "auth"],
    ["402 Payment Required", "billing"],
    ["insufficient credits", "billing"],
    ["429 Too Many Requests", "rate_limit"],
    ["rate limit exceeded", "rate_limit"],
    ["quota exceeded", "rate_limit"],
    ["resource exhausted", "rate_limit"],
    ["500 Internal Server Error", "rate_limit"], // treated as retryable
    ["502 Bad Gateway", "rate_limit"],
    ["503 Service Unavailable", "rate_limit"],
    ["context length exceeded", "overflow"],
    ["prompt is too long", "overflow"],
    ["request too large", "overflow"],
    ["maximum context length", "overflow"],
    ["timeout waiting for response", "timeout"],
    ["deadline exceeded", "timeout"],
    ["400 Bad Request", "format"],
    ["invalid request body", "format"],
    ["validation failed", "format"],
    ["something random went wrong", "unknown"],
  ];

  for (const [message, expected] of cases) {
    it(`classifies "${message}" as ${expected}`, () => {
      expect(classifyError(new Error(message))).toBe(expected);
    });
  }
});

describe("isRetryable", () => {
  it("rate_limit is retryable", () => expect(isRetryable("rate_limit")).toBe(true));
  it("timeout is retryable", () => expect(isRetryable("timeout")).toBe(true));
  it("auth is not retryable", () => expect(isRetryable("auth")).toBe(false));
  it("billing is not retryable", () => expect(isRetryable("billing")).toBe(false));
  it("format is not retryable", () => expect(isRetryable("format")).toBe(false));
  it("abort is not retryable", () => expect(isRetryable("abort")).toBe(false));
  it("overflow is not retryable", () => expect(isRetryable("overflow")).toBe(false));
  it("unknown is not retryable", () => expect(isRetryable("unknown")).toBe(false));
});

describe("withRetry", () => {
  it("returns result on success", async () => {
    const result = await withRetry(() => Promise.resolve("ok"), { maxRetries: 3, backoffMs: 1 });
    expect(result).toBe("ok");
  });

  it("retries on rate_limit and succeeds", async () => {
    let attempt = 0;
    const result = await withRetry(
      () => {
        attempt++;
        if (attempt < 3) throw new Error("429 rate limit");
        return Promise.resolve("ok");
      },
      { maxRetries: 3, backoffMs: 1 },
    );
    expect(result).toBe("ok");
    expect(attempt).toBe(3);
  });

  it("throws immediately on auth error", async () => {
    let attempt = 0;
    await expect(
      withRetry(
        () => {
          attempt++;
          throw new Error("401 Unauthorized");
        },
        { maxRetries: 3, backoffMs: 1 },
      ),
    ).rejects.toThrow("401 Unauthorized");
    expect(attempt).toBe(1);
  });

  it("throws immediately on abort", async () => {
    let attempt = 0;
    await expect(
      withRetry(
        () => {
          attempt++;
          throw new Error("aborted");
        },
        { maxRetries: 3, backoffMs: 1 },
      ),
    ).rejects.toThrow("aborted");
    expect(attempt).toBe(1);
  });

  it("throws after maxRetries exhausted", async () => {
    let attempt = 0;
    await expect(
      withRetry(
        () => {
          attempt++;
          throw new Error("429 rate limit");
        },
        { maxRetries: 2, backoffMs: 1 },
      ),
    ).rejects.toThrow("429 rate limit");
    expect(attempt).toBe(3); // 1 initial + 2 retries
  });

  it("calls onRetry callback", async () => {
    const retries: [number, ErrorKind][] = [];
    let attempt = 0;
    await withRetry(
      () => {
        attempt++;
        if (attempt < 3) throw new Error("429 rate limit");
        return Promise.resolve("ok");
      },
      {
        maxRetries: 3,
        backoffMs: 1,
        onRetry: (a, kind) => { retries.push([a, kind]); },
      },
    );
    expect(retries).toEqual([[0, "rate_limit"], [1, "rate_limit"]]);
  });

  it("calls onCompact on overflow error", async () => {
    let compacted = false;
    let attempt = 0;
    await withRetry(
      () => {
        attempt++;
        if (attempt === 1) throw new Error("context length exceeded");
        return Promise.resolve("ok");
      },
      {
        maxRetries: 3,
        backoffMs: 1,
        onCompact: async () => { compacted = true; },
      },
    );
    expect(compacted).toBe(true);
    expect(attempt).toBe(2);
  });

  it("overflow retry only happens once", async () => {
    let compactCount = 0;
    await expect(
      withRetry(
        () => { throw new Error("context length exceeded"); },
        {
          maxRetries: 5,
          backoffMs: 1,
          onCompact: async () => { compactCount++; },
        },
      ),
    ).rejects.toThrow("context length exceeded");
    expect(compactCount).toBe(1);
  });

  it("unknown error gets one retry", async () => {
    let attempt = 0;
    await expect(
      withRetry(
        () => {
          attempt++;
          throw new Error("something weird");
        },
        { maxRetries: 3, backoffMs: 1 },
      ),
    ).rejects.toThrow("something weird");
    expect(attempt).toBe(2); // 1 initial + 1 unknown retry
  });
});
