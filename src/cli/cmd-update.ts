// CLI command: camel update — update via npm

import { register } from "./registry.js";
import { VERSION } from "../core/version.js";
import { exec } from "node:child_process";

function run(cmd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(cmd, { encoding: "utf-8" }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout.trim());
    });
  });
}

register({
  name: "update",
  description: "Update CamelAGI to the latest version",
  run: async () => {
    const p = await import("@clack/prompts");

    p.intro("\x1b[36mCamelAGI\x1b[0m update");
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

    s.stop(`New version available: ${VERSION} → ${latest}`);

    const s2 = p.spinner();
    s2.start(`Installing v${latest}...`);

    try {
      await run("npm i -g camelagi@latest");
      s2.stop(`Installed v${latest}`);
    } catch (err) {
      s2.stop("Install failed");
      p.log.error(`${err instanceof Error ? err.message : err}`);
      p.log.info("Try manually: npm i -g camelagi@latest");
      return;
    }

    p.log.success(`Updated: ${VERSION} → ${latest}`);
    p.outro("Restart any running server to use the new version.");
  },
});
