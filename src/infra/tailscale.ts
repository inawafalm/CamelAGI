// Tailscale integration — binary discovery, serve/funnel management, hostname resolution
// Adapted from openclaw/src/infra/tailscale.ts

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";

function exec(
  cmd: string,
  args: string[],
  opts?: { timeoutMs?: number; maxBuffer?: number },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { timeout: opts?.timeoutMs ?? 10_000, maxBuffer: opts?.maxBuffer ?? 200_000 },
      (err, stdout, stderr) => {
        if (err) reject(Object.assign(err, { stdout, stderr }));
        else resolve({ stdout, stderr });
      },
    );
  });
}

// ── Binary discovery ─────────────────────────────────────────────────

let cachedBinary: string | null = null;

async function checkBinary(path: string): Promise<boolean> {
  if (!path || !existsSync(path)) return false;
  try {
    await exec(path, ["--version"], { timeoutMs: 3000 });
    return true;
  } catch {
    return false;
  }
}

export async function findTailscaleBinary(): Promise<string | null> {
  // Strategy 1: PATH lookup
  try {
    const { stdout } = await exec("which", ["tailscale"]);
    const fromPath = stdout.trim();
    if (fromPath && (await checkBinary(fromPath))) return fromPath;
  } catch { /* continue */ }

  // Strategy 2: Known macOS app path
  const macAppPath = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
  if (await checkBinary(macAppPath)) return macAppPath;

  // Strategy 3: find in /Applications
  try {
    const { stdout } = await exec(
      "find",
      ["/Applications", "-maxdepth", "3", "-name", "Tailscale", "-path", "*/Tailscale.app/Contents/MacOS/Tailscale"],
      { timeoutMs: 5000 },
    );
    const found = stdout.trim().split("\n")[0];
    if (found && (await checkBinary(found))) return found;
  } catch { /* continue */ }

  return null;
}

async function getTailscaleBinary(): Promise<string> {
  if (cachedBinary) return cachedBinary;
  cachedBinary = await findTailscaleBinary();
  return cachedBinary ?? "tailscale";
}

// ── Hostname resolution ──────────────────────────────────────────────

function parsePossiblyNoisyJson(stdout: string): Record<string, unknown> {
  const trimmed = stdout.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
  }
  return JSON.parse(trimmed) as Record<string, unknown>;
}

export async function getTailnetHostname(): Promise<string> {
  const bin = await getTailscaleBinary();
  const { stdout } = await exec(bin, ["status", "--json"], { timeoutMs: 5000, maxBuffer: 400_000 });
  const parsed = stdout ? parsePossiblyNoisyJson(stdout) : {};

  const self = typeof parsed.Self === "object" && parsed.Self !== null
    ? (parsed.Self as Record<string, unknown>)
    : undefined;

  const dns = typeof self?.DNSName === "string" ? self.DNSName : undefined;
  const ips = Array.isArray(self?.TailscaleIPs)
    ? ((parsed.Self as { TailscaleIPs?: string[] }).TailscaleIPs ?? [])
    : [];

  if (dns && dns.length > 0) return dns.replace(/\.$/, "");
  if (ips.length > 0) return ips[0]!;
  throw new Error("Could not determine Tailscale DNS or IP");
}

// ── Exec with sudo fallback ──────────────────────────────────────────

function isPermissionDenied(err: unknown): boolean {
  const e = err as { stdout?: string; stderr?: string; message?: string; code?: string };
  const combined = `${e.stdout ?? ""}\n${e.stderr ?? ""}\n${e.message ?? ""}`.toLowerCase();
  if (e.code?.toUpperCase() === "EACCES") return true;
  return (
    combined.includes("permission denied") ||
    combined.includes("access denied") ||
    combined.includes("operation not permitted") ||
    combined.includes("requires root") ||
    combined.includes("must be run as root")
  );
}

async function execWithSudoFallback(
  bin: string,
  args: string[],
  opts?: { maxBuffer?: number; timeoutMs?: number },
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await exec(bin, args, opts);
  } catch (err) {
    if (!isPermissionDenied(err)) throw err;
    try {
      return await exec("sudo", ["-n", bin, ...args], opts);
    } catch {
      throw err; // throw original error
    }
  }
}

// ── Serve / Funnel management ────────────────────────────────────────

export async function enableTailscaleServe(port: number): Promise<void> {
  const bin = await getTailscaleBinary();
  await execWithSudoFallback(bin, ["serve", "--bg", "--yes", `${port}`], {
    maxBuffer: 200_000,
    timeoutMs: 15_000,
  });
}

export async function disableTailscaleServe(): Promise<void> {
  const bin = await getTailscaleBinary();
  await execWithSudoFallback(bin, ["serve", "reset"], {
    maxBuffer: 200_000,
    timeoutMs: 15_000,
  });
}

export async function enableTailscaleFunnel(port: number): Promise<void> {
  const bin = await getTailscaleBinary();
  await execWithSudoFallback(bin, ["funnel", "--bg", "--yes", `${port}`], {
    maxBuffer: 200_000,
    timeoutMs: 15_000,
  });
}

export async function disableTailscaleFunnel(): Promise<void> {
  const bin = await getTailscaleBinary();
  await execWithSudoFallback(bin, ["funnel", "reset"], {
    maxBuffer: 200_000,
    timeoutMs: 15_000,
  });
}

// ── Orchestrator ─────────────────────────────────────────────────────

export interface TailscaleExposureResult {
  url: string | null;
  cleanup: (() => Promise<void>) | null;
}

export async function startTailscaleExposure(params: {
  mode: "serve" | "funnel";
  port: number;
  log: (...args: unknown[]) => void;
}): Promise<TailscaleExposureResult> {
  try {
    if (params.mode === "serve") {
      await enableTailscaleServe(params.port);
    } else {
      await enableTailscaleFunnel(params.port);
    }

    const host = await getTailnetHostname().catch(() => null);
    const url = host ? `https://${host}` : null;

    if (host) {
      params.log(`  Tailscale ${params.mode}: ${url}`);
    } else {
      params.log(`  Tailscale ${params.mode}: enabled`);
    }

    const cleanup = async () => {
      try {
        if (params.mode === "serve") {
          await disableTailscaleServe();
        } else {
          await disableTailscaleFunnel();
        }
      } catch { /* best effort */ }
    };

    return { url, cleanup };
  } catch (err) {
    params.log(`  Tailscale ${params.mode} failed: ${err instanceof Error ? err.message : String(err)}`);
    return { url: null, cleanup: null };
  }
}
