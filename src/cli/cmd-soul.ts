import { register } from "./registry.js";
import { loadConfig, ensureDirs } from "../core/config.js";

register({
  name: "soul",
  description: "View/edit agent's SOUL.md in $EDITOR",
  run: async (args) => {
    ensureDirs();
    const { agentMemoryDir, seedAgentWorkspace } = await import("../workspace.js");
    const config = loadConfig();
    const agentEntries = Object.entries(config.agents ?? {});

    if (agentEntries.length === 0) {
      console.error("No agents configured.");
      process.exit(1);
    }

    // If no id given and only one agent, use that
    let targetId = args[0];
    if (!targetId && agentEntries.length === 1) {
      targetId = agentEntries[0][0];
    }

    if (!targetId) {
      console.log("Usage: camelagi soul <id>\n");
      for (const [id] of agentEntries) {
        console.log(`  ${id}`);
      }
      process.exit(0);
    }

    if (!config.agents[targetId]) {
      console.error(`Agent "${targetId}" not found.`);
      process.exit(1);
    }

    const { default: fs } = await import("node:fs");
    const { default: path } = await import("node:path");
    const soulPath = path.join(agentMemoryDir(targetId), "SOUL.md");

    if (!fs.existsSync(soulPath)) {
      seedAgentWorkspace(targetId, config.agents[targetId].name);
    }

    const editorCmd = process.env.EDITOR || process.env.VISUAL || "nano";
    const { spawnSync } = await import("node:child_process");
    spawnSync(editorCmd, [soulPath], { stdio: "inherit" });
    process.exit(0);
  },
});
