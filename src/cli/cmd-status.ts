import { register } from "./registry.js";
import { loadConfig, ensureDirs } from "../core/config.js";
import { VERSION } from "../core/version.js";
import { listSessions } from "../session.js";
import { aggregateTodayTokens, formatTokens } from "../usage.js";

register({
  name: "status",
  description: "System health overview",
  run: async () => {
    ensureDirs();
    const config = loadConfig();
    const c = "\x1b[36m", g = "\x1b[90m", b = "\x1b[1m", x = "\x1b[0m";
    const gr = "\x1b[32m", r = "\x1b[31m";

    console.log("");
    console.log(`  ${b}${c}CamelAGI${x} ${g}v${VERSION}${x}`);
    console.log("");

    // Check if gateway is running
    let gatewayRunning = false;
    try {
      const resp = await fetch(`http://${config.serve.host}:${config.serve.port}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      gatewayRunning = resp.ok;
    } catch {}

    console.log(`  ${b}Gateway:${x}  ${gatewayRunning ? gr + "running" + x + ` (port ${config.serve.port})` : r + "stopped" + x}`);

    // Provider & model
    const providerLabel = config.baseUrl?.includes("openrouter") ? "openai (openrouter)" : config.provider;
    console.log(`  ${b}Provider:${x} ${providerLabel}`);
    console.log(`  ${b}Model:${x}    ${config.model}`);
    console.log("");

    // Agents
    const entries = Object.entries(config.agents);
    if (entries.length > 0) {
      console.log(`  ${b}Agents (${entries.length}):${x}`);
      for (const [id, a] of entries) {
        const mcpCount = a.mcp ? Object.keys(a.mcp.servers).length : 0;
        const icon = a.admin ? "👑" : "🤖";
        const parts = [
          `    ${icon} ${c}${a.name}${x}`,
          g + `(${id})` + x,
        ];
        if (a.telegram?.botToken) parts.push(g + "telegram" + x);
        if (a.discord?.botToken) parts.push(g + "discord" + x);
        if (mcpCount > 0) parts.push(g + `${mcpCount} MCP` + x);
        console.log(parts.join(" "));
      }
      console.log("");
    }

    // Lanes
    const l = config.lanes;
    console.log(`  ${b}Lanes:${x}    main 0/${l.main} | cron 0/${l.cron} | subagent 0/${l.subagent}`);

    // Sessions
    const sessions = listSessions();
    console.log(`  ${b}Sessions:${x} ${sessions.length} total`);

    // Today's usage
    const todayTokens = aggregateTodayTokens();
    if (todayTokens > 0) {
      console.log(`  ${b}Today:${x}    ~${formatTokens(todayTokens)} tokens`);
    }

    console.log("");
  },
});
