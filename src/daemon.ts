// Daemon management — launchd (macOS) plist generation + launchctl

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";

const LABEL = "com.camelagi.server";
const PLIST_PATH = path.join(os.homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);

function getNodePath(): string {
  try {
    return execSync("which node", { encoding: "utf-8" }).trim();
  } catch {
    return "/usr/local/bin/node";
  }
}

function getEntryPath(): string {
  return path.resolve(import.meta.dirname, "..", "camelagi.mjs");
}

function generatePlist(): string {
  const nodePath = getNodePath();
  const entryPath = getEntryPath();
  const logDir = path.join(os.homedir(), ".camelagi", "logs");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${entryPath}</string>
    <string>serve</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${logDir}/daemon.stdout.log</string>
  <key>StandardErrorPath</key>
  <string>${logDir}/daemon.stderr.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${process.env.PATH}</string>
  </dict>
</dict>
</plist>`;
}

export function install(): void {
  fs.mkdirSync(path.dirname(PLIST_PATH), { recursive: true });
  fs.mkdirSync(path.join(os.homedir(), ".camelagi", "logs"), { recursive: true });

  fs.writeFileSync(PLIST_PATH, generatePlist());

  try {
    execSync(`launchctl load -w "${PLIST_PATH}"`, { stdio: "pipe" });
  } catch {
    try { execSync(`launchctl unload "${PLIST_PATH}"`, { stdio: "pipe" }); } catch { /* ignore */ }
    execSync(`launchctl load -w "${PLIST_PATH}"`, { stdio: "pipe" });
  }

  console.log(`\x1b[32m✓\x1b[0m Daemon installed and started`);
  console.log(`  Plist: ${PLIST_PATH}`);
  console.log(`  Logs:  ~/.camelagi/logs/daemon.{stdout,stderr}.log`);
  console.log(`  Run \x1b[36mcamelagi daemon status\x1b[0m to check`);
}

export function uninstall(): void {
  if (!fs.existsSync(PLIST_PATH)) {
    console.log("Daemon is not installed.");
    return;
  }

  try { execSync(`launchctl unload "${PLIST_PATH}"`, { stdio: "pipe" }); } catch { /* not loaded */ }
  fs.unlinkSync(PLIST_PATH);
  console.log(`\x1b[32m✓\x1b[0m Daemon uninstalled`);
}

export function status(): void {
  if (!fs.existsSync(PLIST_PATH)) {
    console.log("Daemon: \x1b[90mnot installed\x1b[0m");
    return;
  }

  try {
    const output = execSync(`launchctl list 2>/dev/null | grep ${LABEL}`, { encoding: "utf-8" }).trim();
    if (output) {
      const parts = output.split(/\s+/);
      const pid = parts[0];
      const exitCode = parts[1];
      if (pid !== "-") {
        console.log(`Daemon: \x1b[32mrunning\x1b[0m (PID ${pid})`);
      } else {
        console.log(`Daemon: \x1b[31mstopped\x1b[0m (last exit code: ${exitCode})`);
      }
    } else {
      console.log("Daemon: \x1b[90mnot loaded\x1b[0m");
    }
  } catch {
    console.log("Daemon: \x1b[90mnot loaded\x1b[0m");
  }

  console.log(`  Plist: ${PLIST_PATH}`);
}
