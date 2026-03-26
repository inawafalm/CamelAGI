// CLI command: camel update — update via npm with progress bar

import { register } from "./registry.js";
import { VERSION } from "../core/version.js";
import { exec, execFile } from "node:child_process";

function run(cmd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(cmd, { encoding: "utf-8" }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout.trim());
    });
  });
}

const c = "\x1b[36m", g = "\x1b[90m", gr = "\x1b[32m", b = "\x1b[1m", x = "\x1b[0m";

function progressBar(percent: number, width = 30): string {
  const filled = Math.round(width * percent);
  const empty = width - filled;
  const bar = `${c}${"█".repeat(filled)}${g}${"░".repeat(empty)}${x}`;
  return `  ${bar} ${Math.round(percent * 100)}%`;
}

function installWithProgress(pkg: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let phase = 0;
    const phases = [
      { pct: 0.10, label: "Resolving..." },
      { pct: 0.25, label: "Downloading..." },
      { pct: 0.45, label: "Downloading..." },
      { pct: 0.60, label: "Extracting..." },
      { pct: 0.75, label: "Linking..." },
      { pct: 0.85, label: "Linking..." },
      { pct: 0.95, label: "Finalizing..." },
    ];

    const draw = (pct: number, label: string) => {
      process.stdout.write(`\r${progressBar(pct)} ${g}${label}${x}                    `);
    };

    draw(0.02, "Starting...");

    // Smooth progress on timer
    const timer = setInterval(() => {
      if (phase < phases.length) {
        const p = phases[phase]!;
        draw(p.pct, p.label);
        phase++;
      }
    }, 600);

    // Use execFile with npm path to avoid shell: true deprecation
    execFile("npm", ["i", "-g", `${pkg}@latest`], {
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
    }, (err) => {
      clearInterval(timer);
      if (err) {
        process.stdout.write(`\r${" ".repeat(70)}\r`);
        reject(err);
      } else {
        draw(1, "");
        process.stdout.write(`\r${progressBar(1)} ${gr}Done${x}                    \n`);
        resolve();
      }
    });
  });
}

register({
  name: "update",
  description: "Update CamelAGI to the latest version",
  run: async () => {
    const p = await import("@clack/prompts");

    p.intro(`${c}CamelAGI${x} update`);
    p.log.info(`Current version: ${VERSION}`);

    const s = p.spinner();
    s.start("Checking for updates...");

    let latest: string;
    try {
      latest = await run("npm view camelagi version");
    } catch (err) {
      s.stop("Failed");
      p.log.error(`Could not check npm: ${err instanceof Error ? err.message : err}`);
      return;
    }

    if (latest === VERSION) {
      s.stop("Up to date");
      p.log.success(`Already on latest version (${VERSION})`);
      p.outro("");
      return;
    }

    s.stop(`New version available: ${b}${VERSION}${x} → ${b}${c}${latest}${x}`);

    console.log("");
    try {
      await installWithProgress("camelagi");
    } catch (err) {
      console.log("");
      p.log.error(`Install failed: ${err instanceof Error ? err.message : err}`);
      p.log.info("Try manually: npm i -g camelagi@latest");
      return;
    }
    console.log("");

    p.log.success(`Updated: ${VERSION} → ${latest}`);
    p.outro("Restart any running server to use the new version.");
  },
});
