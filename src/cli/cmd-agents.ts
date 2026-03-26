import { register } from "./registry.js";
import { loadConfig, saveConfig, ensureDirs, type Config } from "../core/config.js";
import { hasFlag } from "./parse.js";

register({
  name: "agents",
  description: "Manage agents interactively",
  usage: `Usage: camelagi agents [subcommand]

Manage configured agents. Run without arguments for interactive mode.

Subcommands:
  (none)          Interactive agent manager (default)
  rm <id>         Remove an agent (prompts for confirmation)

Options:
  --yes, -y       Skip confirmation prompt (with rm)

Examples:
  camelagi agents
  camelagi agents rm mybot`,
  run: async (args) => {
    const p = await import("@clack/prompts");
    ensureDirs();
    const config = loadConfig();

    // Subcommand: rm
    if (args[0] === "rm" && args[1]) {
      const agents = { ...(config.agents ?? {}) } as Record<string, unknown>;
      if (!agents[args[1]]) {
        p.log.error(`Agent "${args[1]}" not found.`);
        process.exit(1);
      }

      if (!hasFlag(args, "--yes") && !hasFlag(args, "-y")) {
        const ok = await p.confirm({ message: `Remove agent "${args[1]}"?` });
        if (p.isCancel(ok) || !ok) {
          p.cancel("Cancelled.");
          return;
        }
      }

      delete agents[args[1]];
      saveConfig({ agents });
      p.log.success(`Removed agent: ${args[1]}`);
      return;
    }

    if (args[0] && args[0] !== "rm") {
      p.log.error(`Unknown subcommand: ${args[0]}. Use: camelagi agents [rm <id>]`);
      process.exit(1);
    }

    // Interactive mode
    const agentEntries = Object.entries(config.agents ?? {});
    if (agentEntries.length === 0) {
      p.log.info("No agents configured.");
      const add = await p.confirm({ message: "Create a new agent?" });
      if (p.isCancel(add) || !add) return;
      await createAgent(p, config);
      return;
    }

    const options = [
      ...agentEntries.map(([id, a]) => {
        const tags: string[] = [];
        if (a.admin) tags.push("admin");
        if (a.telegram?.botToken) tags.push("telegram");
        if (a.discord?.botToken) tags.push("discord");
        const model = a.model ?? config.model;
        const hint = [model, ...tags].join(", ");
        return { value: id, label: `${a.name}`, hint };
      }),
      { value: "__new__", label: "Create new agent", hint: "" },
    ];

    const selected = await p.select({
      message: "Select an agent",
      options,
    });
    if (p.isCancel(selected)) return;

    if (selected === "__new__") {
      await createAgent(p, config);
      return;
    }

    await configureAgent(p, config, selected as string);
  },
});

async function configureAgent(p: typeof import("@clack/prompts"), config: Config, agentId: string) {
  const agent = config.agents[agentId];
  if (!agent) return;

  const action = await p.select({
    message: `${agent.name} (${agentId})`,
    options: [
      { value: "mode", label: "Mode", hint: agent.mode ?? "llm" },
      { value: "workDir", label: "Working Dir", hint: agent.workDir ?? "(default)" },
      { value: "model", label: "Model", hint: agent.model ?? config.model },
      { value: "name", label: "Name", hint: agent.name },
      { value: "thinking", label: "Thinking", hint: String(agent.thinking ?? config.thinking) },
      { value: "effort", label: "Effort", hint: String(agent.effort ?? config.effort) },
      { value: "telegram", label: "Telegram", hint: agent.telegram?.botToken ? "configured" : "not set" },
      { value: "remove", label: "Remove agent", hint: "" },
    ],
  });
  if (p.isCancel(action)) return;

  const agents = { ...config.agents };

  switch (action) {
    case "mode": {
      const mode = await p.select({
        message: "Agent mode:",
        options: [
          { value: "llm", label: "LLM (API-based)", hint: "Normal CamelAGI agent" },
          { value: "claude-code", label: "Claude Code", hint: "Local CLI subprocess" },
        ],
      });
      if (p.isCancel(mode)) return;
      agents[agentId] = { ...agent, mode: mode as "llm" | "claude-code" };
      saveConfig({ agents });
      p.log.success(`Mode set to: ${mode}`);
      break;
    }
    case "workDir": {
      const dir = await p.text({ message: "Working directory:", initialValue: agent.workDir ?? "" });
      if (p.isCancel(dir)) return;
      if (dir) {
        agents[agentId] = { ...agent, workDir: dir as string };
      } else {
        const { workDir: _, ...rest } = agent;
        agents[agentId] = rest as typeof agent;
      }
      saveConfig({ agents });
      p.log.success(dir ? `Working dir set to: ${dir}` : "Working dir cleared (using default)");
      break;
    }
    case "model": {
      const model = await p.text({ message: "Model:", initialValue: agent.model ?? config.model });
      if (p.isCancel(model)) return;
      agents[agentId] = { ...agent, model: model as string };
      saveConfig({ agents });
      p.log.success(`Model set to: ${model}`);
      break;
    }
    case "name": {
      const name = await p.text({ message: "Name:", initialValue: agent.name });
      if (p.isCancel(name)) return;
      agents[agentId] = { ...agent, name: name as string };
      saveConfig({ agents });
      p.log.success(`Name set to: ${name}`);
      break;
    }
    case "thinking": {
      const thinking = await p.select({
        message: "Thinking level:",
        options: [
          { value: "off", label: "Off" },
          { value: "low", label: "Low" },
          { value: "medium", label: "Medium" },
          { value: "high", label: "High" },
        ],
      });
      if (p.isCancel(thinking)) return;
      agents[agentId] = { ...agent, thinking: thinking as Config["thinking"] };
      saveConfig({ agents });
      p.log.success(`Thinking set to: ${thinking}`);
      break;
    }
    case "effort": {
      const effort = await p.select({
        message: "Effort level:",
        options: [
          { value: "low", label: "Low" },
          { value: "medium", label: "Medium" },
          { value: "high", label: "High" },
          { value: "max", label: "Max" },
        ],
      });
      if (p.isCancel(effort)) return;
      agents[agentId] = { ...agent, effort: effort as Config["effort"] };
      saveConfig({ agents });
      p.log.success(`Effort set to: ${effort}`);
      break;
    }
    case "telegram": {
      const token = await p.text({
        message: "Telegram bot token (from @BotFather):",
        initialValue: agent.telegram?.botToken ?? "",
      });
      if (p.isCancel(token)) return;
      if (!token) {
        const { telegram: _, ...rest } = agent;
        agents[agentId] = rest as typeof agent;
        saveConfig({ agents });
        p.log.success("Telegram removed");
      } else {
        // Verify the token
        const sv = p.spinner();
        sv.start("Verifying token...");
        try {
          const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, { signal: AbortSignal.timeout(10000) });
          const data = await res.json() as { ok: boolean; result?: { username?: string; first_name?: string } };
          if (!data.ok) {
            sv.stop("Invalid token");
            p.log.error("Token rejected by Telegram. Check it in @BotFather.");
            return;
          }
          const botName = data.result?.username ?? data.result?.first_name ?? "bot";
          sv.stop(`Verified: @${botName}`);

          agents[agentId] = {
            ...agent,
            telegram: {
              botToken: token as string,
              allowedUsers: agent.telegram?.allowedUsers ?? [],
              briefMode: agent.telegram?.briefMode ?? true,
              groups: agent.telegram?.groups ?? { mentionOnly: true },
            },
          };
          saveConfig({ agents });
          p.log.success(`Telegram configured (@${botName})`);
          p.log.info("Restart the server to activate: camel serve");
        } catch (err) {
          sv.stop("Failed");
          p.log.error(`Could not verify token: ${err instanceof Error ? err.message : err}`);
        }
      }
      break;
    }
    case "remove": {
      const ok = await p.confirm({ message: `Remove "${agent.name}"?` });
      if (p.isCancel(ok) || !ok) return;
      delete agents[agentId];
      saveConfig({ agents });
      p.log.success(`Removed: ${agentId}`);
      break;
    }
  }
}

async function createAgent(p: typeof import("@clack/prompts"), config: Config) {
  const name = await p.text({ message: "Agent name:" });
  if (p.isCancel(name) || !name) return;

  const id = (name as string).toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (config.agents[id]) {
    p.log.error(`Agent "${id}" already exists.`);
    return;
  }

  const mode = await p.select({
    message: "Agent mode:",
    options: [
      { value: "llm", label: "LLM (API-based)" },
      { value: "claude-code", label: "Claude Code (local CLI)" },
    ],
  });
  if (p.isCancel(mode)) return;

  let model: string | symbol = config.model;
  if (mode !== "claude-code") {
    model = await p.text({ message: "Model:", initialValue: config.model });
    if (p.isCancel(model)) return;
  }

  const wantTelegram = await p.confirm({ message: "Add Telegram bot?" });
  let telegramConfig: Config["agents"][string]["telegram"] | undefined;
  if (!p.isCancel(wantTelegram) && wantTelegram) {
    const token = await p.text({ message: "Bot token (from @BotFather):" });
    if (p.isCancel(token) || !token) return;
    telegramConfig = { botToken: token as string, allowedUsers: [], briefMode: true, groups: { mentionOnly: true } } as Config["agents"][string]["telegram"];
  }

  const { seedAgentWorkspace } = await import("../workspace.js");
  seedAgentWorkspace(id, name as string);

  const agents = { ...config.agents };
  agents[id] = {
    name: name as string,
    ...(mode === "claude-code" ? { mode: "claude-code" as const } : {}),
    ...(model !== config.model ? { model: model as string } : {}),
    ...(telegramConfig ? { telegram: telegramConfig } : {}),
  } as typeof agents[string];

  saveConfig({ agents });
  p.log.success(`Created agent: ${name} (${id})`);
  p.log.info("Restart the server to activate.");
}
