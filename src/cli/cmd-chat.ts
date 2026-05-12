import { register } from "./registry.js";
import { getFlag } from "./parse.js";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

function findBun(): string | undefined {
  const candidates = [
    join(process.env.HOME ?? "", ".bun/bin/bun"),
    "/usr/local/bin/bun",
    "/opt/homebrew/bin/bun",
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  const path = process.env.PATH ?? "";
  for (const dir of path.split(":")) {
    const cand = join(dir, "bun");
    if (existsSync(cand)) return cand;
  }
  return undefined;
}

function findTuiEntry(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  let cur = here;
  for (let i = 0; i < 6; i++) {
    const candidate = join(cur, "tui", "src", "main.tsx");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return undefined;
}

register({
  name: "chat",
  description: "Interactive REPL",
  usage: `Usage: camelagi chat [options]

Start the interactive TUI chat client.

Options:
  --session <id>   Resume a specific session
  --classic        Use the legacy pi-tui client

Examples:
  camelagi chat
  camelagi chat --session my-session`,
  run: async (args) => {
    const sessionId = getFlag(args, "--session");
    const classic = args.includes("--classic");

    const { startServer } = await import("../serve.js");
    const handle = await startServer({
      port: 0,
      silent: true,
      channels: false,
      boot: false,
      cron: false,
    });

    const wsUrl = `ws://127.0.0.1:${handle.port}`;
    const token = handle.config.serve.token;

    // Try Bun TUI first (unless --classic)
    const bunPath = !classic ? findBun() : undefined;
    const tuiEntry = !classic ? findTuiEntry() : undefined;

    if (bunPath && tuiEntry) {
      const env: Record<string, string> = {
        ...process.env as Record<string, string>,
        CAMELAGI_WS_URL: wsUrl,
        CAMELAGI_MODEL: process.env.CAMELAGI_MODEL ?? "",
        CAMELAGI_CWD: process.cwd(),
      };
      if (token) env.CAMELAGI_TOKEN = token;
      if (sessionId) env.CAMELAGI_SESSION = sessionId;

      const child = spawn(bunPath, [tuiEntry], {
        stdio: "inherit",
        env,
        cwd: process.cwd(),
      });

      await new Promise<void>((resolve) => {
        child.on("exit", () => resolve());
      });
    } else {
      // Fallback: legacy pi-tui
      if (!classic && !bunPath) {
        console.log("  Bun not found — using legacy TUI. Install Bun for the new UI: https://bun.sh");
      }
      const { runTui } = await import("../tui/tui.js");
      await runTui({ session: sessionId, wsUrl });
    }

    await handle.close();
  },
});
