// Shared constants — single source of truth for magic numbers

// Token estimation
export const CHARS_PER_TOKEN = 4;

// Output limits
export const MAX_TOOL_OUTPUT_CHARS = 50_000;
export const MAX_STDERR_CHARS = 10_000;

// System prompt limits
export const MAX_BOOTSTRAP_FILE_CHARS = 20_000;
export const MAX_BOOTSTRAP_TOTAL_CHARS = 150_000;
export const MAX_SKILLS_TOTAL_CHARS = 30_000;

// Timeouts
export const HOOK_TIMEOUT_MS = 10_000;
export const HEARTBEAT_INTERVAL_MS = 30_000;
export const QUEUE_WAIT_TIMEOUT_MS = 15_000;

// Compaction
export const COMPACTION_TRIGGER_RATIO = 0.8;
export const MEMORY_FLUSH_MAX_CHARS = 30_000;

// API defaults
export const DEFAULT_MAX_TOKENS = 4096;
export const DEFAULT_MAX_TURNS = 25;
