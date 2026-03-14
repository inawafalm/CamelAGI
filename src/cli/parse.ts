// Common CLI argument parsing helpers

/** Get flag value: --port 8080 → "8080" */
export function getFlag(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

/** Get flag as int with validation */
export function getFlagInt(args: string[], name: string, min?: number, max?: number): number | undefined {
  const raw = getFlag(args, name);
  if (raw === undefined) return undefined;
  const n = parseInt(raw, 10);
  if (isNaN(n)) throw new Error(`Invalid value for ${name}: "${raw}" (expected a number)`);
  if (min !== undefined && n < min) throw new Error(`${name} must be >= ${min}`);
  if (max !== undefined && n > max) throw new Error(`${name} must be <= ${max}`);
  return n;
}

/** Check if flag is present (no value): --confirm */
export function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

/** Validate a cron schedule string format and warn about limitations */
export function validateSchedule(schedule: string): void {
  // Duration: 5m, 1h, 1d, 30s
  if (/^\d+[smhd]$/.test(schedule)) return;
  // One-shot relative: +20m, +1h
  if (/^\+\d+[smhd]$/.test(schedule)) return;
  // Cron expression: 5 whitespace-separated fields
  const fields = schedule.trim().split(/\s+/);
  if (fields.length === 5) {
    // Only */N minute-field patterns are fully supported; other cron expressions
    // (e.g. "0 9 * * *") fall back to a 1-minute interval which is rarely intended.
    if (!fields[0].startsWith("*/")) {
      console.warn(
        `\x1b[33mWarning:\x1b[0m Cron expression "${schedule}" will run as a 1-minute interval.\n` +
        `  Only \`*/N * * * *\` patterns are fully supported. Consider using a duration (e.g. "1d") instead.`,
      );
    }
    return;
  }
  // ISO timestamp
  if (schedule.length > 8 && !isNaN(Date.parse(schedule))) return;

  throw new Error(
    `Invalid schedule format: "${schedule}"\n` +
    `  Supported: 5m, 1h, 1d (interval), +20m (one-shot), */5 * * * * (cron), ISO timestamp`,
  );
}
