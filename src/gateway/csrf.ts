// CSRF protection — blocks cross-origin mutation requests from browsers

import type { Request, Response, NextFunction } from "express";
import { checkAuth, type GatewayState } from "./state.js";
import { LOOPBACK_HOSTS } from "../core/constants.js";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function isLoopbackOrigin(raw: string): boolean {
  try {
    const url = new URL(raw);
    return LOOPBACK_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

/**
 * Blocks browser-originated cross-site mutation requests.
 * Non-browser clients (curl, Node fetch) that don't send Origin/Sec-Fetch-Site pass through.
 *
 * When token auth is configured and the request carries a valid Bearer token,
 * CSRF checks are bypassed — if the client has the token, it's not a CSRF attack.
 */
export function csrfProtection(state: GatewayState) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (SAFE_METHODS.has(req.method)) { next(); return; }

    // Token-authenticated requests bypass CSRF — legitimate API client, not browser CSRF
    if (state.token && checkAuth(state, req.headers.authorization)) {
      next();
      return;
    }

    // Sec-Fetch-Site: if present, only allow same-origin / same-site / none
    const fetchSite = req.headers["sec-fetch-site"] as string | undefined;
    if (fetchSite === "cross-site") {
      res.status(403).json({ error: "Cross-site requests are not allowed" });
      return;
    }

    // Origin header: if present, must be loopback
    const origin = req.headers.origin;
    if (origin && !isLoopbackOrigin(origin)) {
      res.status(403).json({ error: "Non-local origin is not allowed" });
      return;
    }

    // Referer header: if present and no Origin, must be loopback
    const referer = req.headers.referer;
    if (!origin && referer && !isLoopbackOrigin(referer)) {
      res.status(403).json({ error: "Non-local referer is not allowed" });
      return;
    }

    next();
  };
}
