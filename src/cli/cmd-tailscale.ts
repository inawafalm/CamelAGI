// camel tailscale — interactive Tailscale setup and status

import { register } from "./registry.js";

const c = "\x1b[36m", g = "\x1b[90m", y = "\x1b[33m", r = "\x1b[31m",
      gr = "\x1b[32m", b = "\x1b[1m", x = "\x1b[0m";

register({
  name: "tailscale",
  description: "Tailscale remote access setup",
  usage: `Usage: camelagi tailscale [subcommand]

Manage Tailscale remote access for CamelAGI.

Subcommands:
  status              Check Tailscale status and current config
  serve               Enable Tailscale Serve (private tailnet access)
  funnel              Enable Tailscale Funnel (public access)
  off                 Disable Tailscale exposure
  link [host]         Connect to a remote CamelAGI via Tailscale
                      If no host given, lists tailnet devices to pick from

No subcommand runs an interactive setup guide.

Examples:
  camelagi tailscale
  camelagi tailscale status
  camelagi tailscale serve
  camelagi tailscale link
  camelagi tailscale link my-mac-mini.tailnet.ts.net`,
  run: async (args) => {
    const sub = args[0];

    const { findTailscaleBinary, getTailnetHostname } = await import("../infra/tailscale.js");
    const { loadConfig, saveConfig } = await import("../core/config.js");

    // ── Link ─────────────────────────────────────────────────────
    if (sub === "link") {
      await linkToRemote(args.slice(1));
      return;
    }

    // ── Status ───────────────────────────────────────────────────
    if (sub === "status") {
      await showStatus();
      return;
    }

    // ── Serve / Funnel / Off ─────────────────────────────────────
    if (sub === "serve" || sub === "funnel" || sub === "off") {
      const mode = sub as "serve" | "funnel" | "off";
      saveConfig({ serve: { tailscale: mode } });
      if (mode === "off") {
        console.log(`\n  ${gr}✓${x} Tailscale disabled. Restart the gateway to apply.\n`);
      } else {
        console.log(`\n  ${gr}✓${x} Tailscale mode set to ${b}${mode}${x}. Restart the gateway to apply.\n`);
      }
      return;
    }

    // ── Interactive setup (no subcommand) ────────────────────────
    await interactiveSetup();

    async function linkToRemote(linkArgs: string[]) {
      const { getFlag: gf } = await import("./parse.js");
      const token = gf(linkArgs, "--token") ?? process.env.CAMELAGI_TOKEN;
      let host = linkArgs.find((a) => !a.startsWith("--"));

      if (!host) {
        // No host given — list tailnet peers and let user pick
        const binary = await findTailscaleBinary();
        if (!binary) {
          console.log(`\n  ${r}✗${x} Tailscale CLI not found. Install it or provide a hostname directly.`);
          console.log(`    ${c}camel tailscale link my-mac.tailnet.ts.net${x}\n`);
          return;
        }

        console.log(`\n  ${b}${c}Tailscale Link${x}`);
        console.log(`  ${g}Scanning tailnet for devices...${x}\n`);

        const { execFile } = await import("node:child_process");
        let statusJson: string;
        try {
          statusJson = await new Promise<string>((resolve, reject) => {
            execFile(binary, ["status", "--json"], { timeout: 5000, maxBuffer: 400_000 }, (err, stdout) => {
              if (err) reject(err);
              else resolve(stdout);
            });
          });
        } catch {
          console.log(`  ${r}✗${x} Could not get Tailscale status. Is it running?\n`);
          return;
        }

        const parsed = JSON.parse(statusJson) as Record<string, unknown>;
        const peers = parsed.Peer as Record<string, Record<string, unknown>> | undefined;
        const selfNode = parsed.Self as Record<string, unknown> | undefined;
        const selfDns = (selfNode?.DNSName as string)?.replace(/\.$/, "") ?? "this machine";

        if (!peers || Object.keys(peers).length === 0) {
          console.log(`  ${y}!${x} No other devices found on your tailnet.`);
          console.log(`    Make sure the target machine has Tailscale running.\n`);
          return;
        }

        // Build device list
        interface PeerInfo { dns: string; os: string; online: boolean; ip: string }
        const devices: PeerInfo[] = [];

        for (const peer of Object.values(peers)) {
          const dns = ((peer.DNSName as string) ?? "").replace(/\.$/, "");
          const os = (peer.OS as string) ?? "?";
          const online = (peer.Online as boolean) ?? false;
          const ips = (peer.TailscaleIPs as string[]) ?? [];
          if (dns) {
            devices.push({ dns, os, online, ip: ips[0] ?? "" });
          }
        }

        // Sort: online first, then alphabetical
        devices.sort((a, b) => {
          if (a.online !== b.online) return a.online ? -1 : 1;
          return a.dns.localeCompare(b.dns);
        });

        if (devices.length === 0) {
          console.log(`  ${y}!${x} No named devices found on your tailnet.\n`);
          return;
        }

        console.log(`  ${g}You are: ${c}${selfDns}${x}\n`);

        // Show numbered list
        for (let i = 0; i < devices.length; i++) {
          const d = devices[i]!;
          const status = d.online ? `${gr}●${x}` : `${g}○${x}`;
          const osTag = `${g}(${d.os})${x}`;
          console.log(`  ${b}${i + 1})${x} ${status} ${c}${d.dns}${x} ${osTag}`);
        }
        console.log(`\n  ${b}0)${x} ${g}Cancel${x}`);

        const readline = await import("node:readline");
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const answer = await new Promise<string>((res) => rl.question(`\n  ${b}Select device:${x} `, res));
        rl.close();

        const idx = parseInt(answer, 10);
        if (isNaN(idx) || idx === 0 || idx > devices.length) {
          console.log(`\n  Cancelled.\n`);
          return;
        }

        host = devices[idx - 1]!.dns;
      }

      // Connect to the selected host
      const wsUrl = `wss://${host}`;
      const httpUrl = `https://${host}`;

      console.log(`\n  ${b}Connecting to ${c}${host}${x}...`);

      // Health check
      try {
        const headers: Record<string, string> = {};
        if (token) headers["Authorization"] = `Bearer ${token}`;
        const res = await fetch(`${httpUrl}/health`, {
          headers,
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) {
          console.log(`  ${r}✗${x} Gateway returned ${res.status}. Is CamelAGI running on ${host}?`);
          console.log(`    Make sure the remote machine has ${c}camel serve${x} with ${c}serve.tailscale: serve${x} in config.\n`);
          return;
        }
        console.log(`  ${gr}✓${x} Gateway reachable\n`);
      } catch (err) {
        console.log(`  ${r}✗${x} Cannot reach ${httpUrl}/health`);
        console.log(`    ${err instanceof Error ? err.message : String(err)}`);
        console.log(`\n    Make sure the remote machine has:`);
        console.log(`    1. CamelAGI running: ${c}camel serve${x}`);
        console.log(`    2. Tailscale Serve enabled: ${c}camel tailscale serve${x}\n`);
        return;
      }

      // Build final WS URL with token
      let finalWsUrl = wsUrl;
      if (token) {
        finalWsUrl = `${wsUrl}?token=${encodeURIComponent(token)}`;
      }

      // Launch TUI connected to remote
      const { runTui } = await import("../tui/tui.js");
      await runTui({ wsUrl: finalWsUrl });
    }

    async function showStatus() {
      const config = loadConfig();
      const binary = await findTailscaleBinary();
      const mode = config.serve.tailscale;

      console.log("");
      console.log(`  ${b}Tailscale Status${x}`);
      console.log(`  ${"─".repeat(36)}`);

      // Binary
      if (binary) {
        console.log(`  ${gr}✓${x} Binary: ${g}${binary}${x}`);
      } else {
        console.log(`  ${r}✗${x} Tailscale CLI not found`);
        console.log(`    Install: ${c}https://tailscale.com/download${x}`);
        console.log("");
        return;
      }

      // Hostname
      try {
        const hostname = await getTailnetHostname();
        console.log(`  ${gr}✓${x} Hostname: ${c}${hostname}${x}`);
      } catch {
        console.log(`  ${y}!${x} Could not resolve tailnet hostname (is Tailscale running?)`);
      }

      // Config
      console.log(`  ${mode === "off" ? g + "○" : gr + "●"}${x} Mode: ${b}${mode}${x}`);

      if (mode !== "off") {
        console.log(`  ${g}  Gateway will expose via Tailscale ${mode} on next start${x}`);
      }

      // Port
      console.log(`  ${g}  Port: ${config.serve.port}${x}`);
      console.log("");
    }

    async function interactiveSetup() {
      const readline = await import("node:readline");
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const ask = (q: string): Promise<string> => new Promise((res) => rl.question(q, res));

      console.log("");
      console.log(`  ${b}${c}Tailscale Remote Access Setup${x}`);
      console.log(`  ${"─".repeat(36)}`);
      console.log("");

      // Step 1: Check binary
      const binary = await findTailscaleBinary();
      if (!binary) {
        console.log(`  ${r}✗${x} Tailscale CLI not found.`);
        console.log("");
        console.log(`  Install Tailscale first:`);
        console.log(`    Mac:   ${c}brew install tailscale${x}  or  ${c}https://tailscale.com/download/macos${x}`);
        console.log(`    Linux: ${c}curl -fsSL https://tailscale.com/install.sh | sh${x}`);
        console.log("");
        rl.close();
        return;
      }
      console.log(`  ${gr}✓${x} Tailscale found: ${g}${binary}${x}`);

      // Step 2: Check hostname
      let hostname: string | null = null;
      try {
        hostname = await getTailnetHostname();
        console.log(`  ${gr}✓${x} Tailnet: ${c}${hostname}${x}`);
      } catch {
        console.log(`  ${y}!${x} Tailscale is not running or not logged in.`);
        console.log(`    Run: ${c}tailscale up${x}`);
        console.log("");
        rl.close();
        return;
      }

      // Step 3: Choose mode
      console.log("");
      console.log(`  Choose access mode:`);
      console.log("");
      console.log(`  ${b}1)${x} ${c}Serve${x} ${g}(recommended)${x}`);
      console.log(`     Private — only devices on your tailnet can access.`);
      console.log(`     Clients just need the Tailscale app, no CLI.`);
      console.log("");
      console.log(`  ${b}2)${x} ${c}Funnel${x}`);
      console.log(`     Public HTTPS — anyone with the URL can access.`);
      console.log(`     ${y}Requires auth token for security.${x}`);
      console.log("");
      console.log(`  ${b}3)${x} ${g}Cancel${x}`);
      console.log("");

      const choice = await ask(`  ${b}Choose [1/2/3]:${x} `);

      if (choice === "3" || !choice) {
        console.log(`\n  Cancelled.\n`);
        rl.close();
        return;
      }

      const mode = choice === "2" ? "funnel" : "serve";

      // Step 4: For funnel, ensure token exists
      if (mode === "funnel") {
        const config = loadConfig();
        if (!config.serve.token) {
          console.log(`\n  ${y}!${x} Funnel exposes a public URL — an auth token is required.`);
          const genToken = await ask(`  Generate one now? [Y/n]: `);
          if (genToken.toLowerCase() !== "n") {
            const { randomBytes } = await import("node:crypto");
            const token = randomBytes(32).toString("hex");
            saveConfig({ serve: { token, tailscale: mode } });
            console.log(`\n  ${gr}✓${x} Token generated and saved.`);
            console.log(`  ${c}${token}${x}`);
            console.log(`\n  Set on your client: ${c}CAMELAGI_TOKEN=${token}${x}`);
          } else {
            console.log(`\n  ${y}!${x} Set a token manually: ${c}camel serve --generate-token${x}`);
            saveConfig({ serve: { tailscale: mode } });
          }
        } else {
          saveConfig({ serve: { tailscale: mode } });
        }
      } else {
        saveConfig({ serve: { tailscale: mode } });
      }

      // Done
      console.log("");
      console.log(`  ${gr}✓${x} Tailscale ${b}${mode}${x} enabled.`);
      if (hostname) {
        console.log(`  ${g}  URL: ${c}https://${hostname}${x}`);
      }
      console.log("");
      console.log(`  Start the gateway: ${c}camel serve${x}`);
      console.log("");

      rl.close();
    }
  },
});
