// Doctor: health checks and diagnostics

import fs from "node:fs";
import path from "node:path";
import { paths, loadConfig } from "./core/config.js";
import { listSessions } from "./session.js";
import { workspacePaths } from "./workspace.js";

interface Check {
  name: string;
  status: "ok" | "warn" | "error";
  message: string;
}

export async function runDoctor(): Promise<Check[]> {
  const checks: Check[] = [];

  // 1. Config file
  if (fs.existsSync(paths.configFile)) {
    checks.push({ name: "Config file", status: "ok", message: paths.configFile });
  } else {
    checks.push({ name: "Config file", status: "warn", message: "Not found. Run: camelagi setup" });
  }

  // 2. Config valid
  try {
    const config = loadConfig();
    checks.push({ name: "Config valid", status: "ok", message: `provider=${config.provider} model=${config.model}` });

    // 3. API key
    if (config.apiKey) {
      const masked = "***" + config.apiKey.slice(-4);
      checks.push({ name: "API key", status: "ok", message: masked });
    } else {
      checks.push({ name: "API key", status: "error", message: "No API key configured" });
    }

    // 4. Base URL
    if (config.baseUrl) {
      checks.push({ name: "Base URL", status: "ok", message: config.baseUrl });
    }

    // 5. Model connectivity
    if (config.apiKey) {
      try {
        const { createClient, chatDirect } = await import("./model.js");
        const client = createClient(config);
        const result = await chatDirect(client, config.model, "You are a test.", "Say OK");
        const text = result.content || "received response";
        checks.push({ name: "Model connectivity", status: "ok", message: `${config.model}: ${text.slice(0, 50)}` });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        checks.push({ name: "Model connectivity", status: "error", message: msg.slice(0, 100) });
      }
    } else {
      checks.push({ name: "Model connectivity", status: "error", message: "Skipped (no API key)" });
    }

    // 6. Telegram bots
    const botTokens: { label: string; token: string }[] = [];
    if (config.telegram.botToken) {
      botTokens.push({ label: "Telegram", token: config.telegram.botToken });
    }
    for (const [id, agent] of Object.entries(config.agents)) {
      if (agent.telegram?.botToken) {
        botTokens.push({ label: `Agent "${id}"`, token: agent.telegram.botToken });
      }
    }
    for (const { label, token } of botTokens) {
      try {
        const resp = await fetch(`https://api.telegram.org/bot${token}/getMe`);
        const data = await resp.json() as { ok: boolean; result?: { username?: string; first_name?: string }; description?: string };
        if (data.ok && data.result) {
          const name = data.result.first_name ?? "Bot";
          const username = data.result.username ? `@${data.result.username}` : "";
          checks.push({ name: label, status: "ok", message: `${username} (${name})` });
        } else {
          checks.push({ name: label, status: "error", message: `Bot token invalid: ${data.description ?? "Unknown error"}` });
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        checks.push({ name: label, status: "error", message: `Bot token check failed: ${msg}` });
      }
    }

    // 7. Thinking
    if (config.thinking !== "off") {
      checks.push({ name: "Thinking", status: "ok", message: config.thinking });
    }

  } catch (err: unknown) {
    checks.push({ name: "Config valid", status: "error", message: err instanceof Error ? err.message : String(err) });
  }

  // 8. Workspace
  const { workspaceDir } = workspacePaths;
  if (fs.existsSync(workspaceDir)) {
    const files = fs.readdirSync(workspaceDir);
    checks.push({ name: "Workspace", status: "ok", message: `${workspaceDir} (${files.length} files)` });
  } else {
    checks.push({ name: "Workspace", status: "warn", message: "Not found. Run: camelagi setup" });
  }

  // 9. Bootstrap files
  const bootstrapFiles = ["AGENTS.md", "SOUL.md", "USER.md", "TOOLS.md", "IDENTITY.md"];
  const missing = bootstrapFiles.filter((f) => !fs.existsSync(path.join(workspaceDir, f)));
  if (missing.length === 0) {
    checks.push({ name: "Bootstrap files", status: "ok", message: "All present" });
  } else {
    checks.push({ name: "Bootstrap files", status: "warn", message: `Missing: ${missing.join(", ")}` });
  }

  // 10. Memory directory
  const memoryDir = path.join(workspaceDir, "memory");
  if (fs.existsSync(memoryDir)) {
    const dailyFiles = fs.readdirSync(memoryDir).filter((f) => f.endsWith(".md"));
    checks.push({ name: "Memory", status: "ok", message: `${dailyFiles.length} daily file(s)` });
  } else {
    checks.push({ name: "Memory", status: "warn", message: "memory/ directory not found" });
  }

  // 11. Sessions
  const sessions = listSessions();
  checks.push({ name: "Sessions", status: "ok", message: `${sessions.length} session(s)` });

  // 11b. Usage tracking
  const usageDir = path.join(paths.configDir, "usage");
  if (fs.existsSync(usageDir)) {
    const usageFiles = fs.readdirSync(usageDir).filter((f) => f.endsWith(".json"));
    checks.push({ name: "Token usage", status: "ok", message: `${usageFiles.length} tracked session(s)` });
  }

  // 12. Hooks directory
  const hooksDir = path.join(paths.configDir, "hooks");
  if (fs.existsSync(hooksDir)) {
    const hooks = fs.readdirSync(hooksDir).filter((f) => f.endsWith(".sh") || f.endsWith(".js"));
    checks.push({ name: "Hooks", status: "ok", message: `${hooks.length} hook(s)` });
  }

  // 13. Skills directory
  const skillsDir = path.join(paths.configDir, "skills");
  if (fs.existsSync(skillsDir)) {
    const skills = fs.readdirSync(skillsDir, { withFileTypes: true }).filter((d) => d.isDirectory());
    checks.push({ name: "Skills", status: "ok", message: `${skills.length} skill(s)` });
  }

  // Security checks
  try {
    const config = loadConfig();

    // Config file permissions (should be owner-only)
    if (fs.existsSync(paths.configFile)) {
      const stat = fs.statSync(paths.configFile);
      const mode = stat.mode & 0o777;
      if (mode & 0o077) {
        checks.push({ name: "Config permissions", status: "warn", message: `${paths.configFile} is readable by others (${mode.toString(8)}). Run: chmod 600 ~/.camelagi/config.yaml` });
      } else {
        checks.push({ name: "Config permissions", status: "ok", message: `0${mode.toString(8)}` });
      }
    }

    // Auth token
    if (config.serve.token) {
      if (config.serve.token.length < 24) {
        checks.push({ name: "Auth token", status: "warn", message: `Token is short (${config.serve.token.length} chars). 24+ recommended.` });
      } else {
        checks.push({ name: "Auth token", status: "ok", message: `${config.serve.token.length} chars` });
      }
    } else {
      checks.push({ name: "Auth token", status: "warn", message: "No auth token set. Anyone on localhost can access the API." });
    }

    // Bind address
    if (config.serve.host !== "127.0.0.1" && config.serve.host !== "::1" && config.serve.host !== "localhost") {
      checks.push({ name: "Bind address", status: "warn", message: `Binding to ${config.serve.host} — server is exposed to the network. Use a reverse proxy + TLS.` });
    } else {
      checks.push({ name: "Bind address", status: "ok", message: `${config.serve.host} (localhost only)` });
    }

    // State directory permissions
    const statDirStat = fs.statSync(paths.configDir);
    const dirMode = statDirStat.mode & 0o777;
    if (dirMode & 0o077) {
      checks.push({ name: "State directory", status: "warn", message: `~/.camelagi/ is accessible by others (${dirMode.toString(8)}). Run: chmod 700 ~/.camelagi` });
    } else {
      checks.push({ name: "State directory", status: "ok", message: `0${dirMode.toString(8)}` });
    }
  } catch { /* config already checked above */ }

  // 14. Node.js version
  const nodeVersion = process.version;
  const major = parseInt(nodeVersion.slice(1), 10);
  if (major >= 20) {
    checks.push({ name: "Node.js", status: "ok", message: nodeVersion });
  } else {
    checks.push({ name: "Node.js", status: "warn", message: `${nodeVersion} (20+ recommended)` });
  }

  return checks;
}

export function formatChecks(checks: Check[]): string {
  const icons = { ok: "\x1b[32m✓\x1b[0m", warn: "\x1b[33m!\x1b[0m", error: "\x1b[31m✗\x1b[0m" };
  return checks
    .map((c) => `  ${icons[c.status]} ${c.name}: ${c.message}`)
    .join("\n");
}
