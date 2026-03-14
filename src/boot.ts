// BOOT.md: run startup script on gateway launch

import fs from "node:fs";
import path from "node:path";
import type { Config } from "./core/config.js";
import { workspacePaths } from "./workspace.js";
import { runAgent } from "./agent.js";
import { loadMessages, saveMessage } from "./session.js";

const BOOT_SESSION = "boot";

export interface BootResult {
  status: "skipped" | "ran" | "failed";
  response?: string;
  error?: string;
}

export async function runBoot(
  config: Config,
  systemPrompt: string,
): Promise<BootResult> {
  const bootFile = path.join(workspacePaths.workspaceDir, "BOOT.md");

  if (!fs.existsSync(bootFile)) return { status: "skipped" };

  const content = fs.readFileSync(bootFile, "utf-8").trim();
  if (!content) return { status: "skipped" };

  try {
    const history = loadMessages(BOOT_SESSION);
    const result = await runAgent(config.apiKey!, config.model, systemPrompt, history, content, {
      maxTurns: 10,
      timeoutMs: 60_000,
      sessionId: BOOT_SESSION,
      provider: config.provider,
      baseUrl: config.baseUrl,
    });

    saveMessage(BOOT_SESSION, { role: "user", content }, "boot");
    if (result.response) {
      saveMessage(BOOT_SESSION, { role: "assistant", content: result.response }, "boot");
    }

    return { status: "ran", response: result.response };
  } catch (err: unknown) {
    return { status: "failed", error: err instanceof Error ? err.message : String(err) };
  }
}
