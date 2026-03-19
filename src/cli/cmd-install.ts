// CLI command: camelagi install — self-install to ~/.camelagi/versions/ with symlinks

import { register } from "./registry.js";
import { VERSION } from "../core/version.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const VERSIONS_DIR = path.join(os.homedir(), ".camelagi", "versions");
const BIN_DIR = path.join(os.homedir(), ".camelagi", "bin");

register({
  name: "install",
  description: "Install camelagi to ~/.camelagi/versions/ and add to PATH",
  async run() {
    // 1. Create directories
    fs.mkdirSync(VERSIONS_DIR, { recursive: true });
    fs.mkdirSync(BIN_DIR, { recursive: true });

    // 2. Copy current binary to versions directory
    const currentBin = process.argv[0];
    const destBin = path.join(VERSIONS_DIR, VERSION);

    try {
      fs.copyFileSync(currentBin, destBin);
      fs.chmodSync(destBin, 0o755);
    } catch (err) {
      console.error(`Failed to copy binary: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }

    // 3. Create symlinks in bin directory
    const camelLink = path.join(BIN_DIR, "camel");
    const camelagiLink = path.join(BIN_DIR, "camelagi");
    try { fs.unlinkSync(camelLink); } catch {}
    try { fs.unlinkSync(camelagiLink); } catch {}
    fs.symlinkSync(destBin, camelLink);
    fs.symlinkSync(destBin, camelagiLink);

    console.log(`  Installed v${VERSION} to ${destBin}`);

    // 4. Symlink to /usr/local/bin if possible
    try {
      if (fs.existsSync("/usr/local/bin")) {
        fs.unlinkSync("/usr/local/bin/camel");
      }
    } catch {}
    try {
      if (fs.existsSync("/usr/local/bin")) {
        fs.unlinkSync("/usr/local/bin/camelagi");
      }
    } catch {}

    try {
      fs.symlinkSync(destBin, "/usr/local/bin/camel");
      fs.symlinkSync(destBin, "/usr/local/bin/camelagi");
      console.log(`  Linked to /usr/local/bin/`);
    } catch {
      // Fallback to shell profile
      const shellProfiles = [
        path.join(os.homedir(), ".zshrc"),
        path.join(os.homedir(), ".bashrc"),
        path.join(os.homedir(), ".bash_profile"),
      ];
      const pathLine = `export PATH="${BIN_DIR}:$PATH" # CamelAGI`;
      for (const profile of shellProfiles) {
        if (!fs.existsSync(profile)) continue;
        const content = fs.readFileSync(profile, "utf-8");
        if (content.includes("# CamelAGI")) continue;
        fs.appendFileSync(profile, `\n${pathLine}\n`);
        console.log(`  Added to PATH in ${profile}`);
        break;
      }
    }
  },
});
