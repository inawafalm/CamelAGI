// Check for newer version on npm registry (non-blocking, fails silently)

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

interface PackageJson {
  name: string;
  version: string;
}

/** Compare semver strings. Returns 1 if a > b, -1 if a < b, 0 if equal. */
function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return 1;
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return -1;
  }
  return 0;
}

/**
 * Check npm registry for a newer version.
 * Returns update info or null. Never throws.
 */
export async function checkForUpdate(): Promise<{ current: string; latest: string } | null> {
  try {
    const pkg = require("../../package.json") as PackageJson;
    const current = pkg.version;

    const res = await fetch(`https://registry.npmjs.org/${pkg.name}/latest`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;

    const data = await res.json() as { version?: string };
    const latest = data.version;
    if (!latest) return null;

    if (compareSemver(latest, current) > 0) {
      return { current, latest };
    }
    return null;
  } catch {
    return null;
  }
}

/** Print update notice if available (non-blocking) */
export function printUpdateNotice(): void {
  checkForUpdate().then((update) => {
    if (update) {
      console.log(`\n\x1b[33m  Update available: ${update.current} → ${update.latest}\x1b[0m`);
      console.log(`\x1b[90m  Run: npm update -g camelagi\x1b[0m\n`);
    }
  }).catch(() => {});
}
