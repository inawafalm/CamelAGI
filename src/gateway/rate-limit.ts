// Simple in-memory rate limiter — no dependencies

import type { Request, Response, NextFunction } from "express";

interface RateLimitOpts {
  windowMs: number;
  max: number;
}

const hits = new Map<string, { count: number; resetAt: number }>();

export function rateLimit(opts: RateLimitOpts) {
  // Periodically clean up expired entries
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) {
      if (now >= entry.resetAt) hits.delete(key);
    }
  }, opts.windowMs).unref();

  return (req: Request, res: Response, next: NextFunction): void => {
    const key = req.ip ?? "unknown";
    const now = Date.now();

    let entry = hits.get(key);
    if (!entry || now >= entry.resetAt) {
      entry = { count: 0, resetAt: now + opts.windowMs };
      hits.set(key, entry);
    }

    entry.count++;

    res.setHeader("X-RateLimit-Limit", opts.max);
    res.setHeader("X-RateLimit-Remaining", Math.max(0, opts.max - entry.count));
    res.setHeader("X-RateLimit-Reset", Math.ceil(entry.resetAt / 1000));

    if (entry.count > opts.max) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      res.setHeader("Retry-After", retryAfter);
      res.status(429).json({ error: "Too many requests, please try again later" });
      return;
    }

    next();
  };
}
