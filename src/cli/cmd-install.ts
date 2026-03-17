// CLI command: camelagi install — self-install to ~/.camelagi/bin/ and add to PATH

import { register } from "./registry.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const INSTALL_DIR = path.join(os.homedir(), ".camelagi", "bin");

register({
  name: "install",
  description: "Install camelagi to ~/.camelagi/bin/ and add to PATH",
  async run(args: string[]) {
    const target = args[0]; // optional version target (unused for now)

    // 1. Create install directory
    fs.mkdirSync(INSTALL_DIR, { recursive: true });

    // 2. Copy current binary to install directory
    const currentBin = process.argv[0];
    const destBin = path.join(INSTALL_DIR, "camel");
    const destBinAlt = path.join(INSTALL_DIR, "camelagi");

    try {
      fs.copyFileSync(currentBin, destBin);
      fs.chmodSync(destBin, 0o755);
      // Create symlink for `camelagi` alias
      try { fs.unlinkSync(destBinAlt); } catch {}
      fs.symlinkSync("camel", destBinAlt);
    } catch (err) {
      console.error(`Failed to copy binary: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }

    console.log(`  Installed to ${destBin}`);

    // 3. Add to PATH via shell profile
    const shellProfiles = getShellProfiles();
    const pathLine = `export PATH="${INSTALL_DIR}:$PATH"`;
    const marker = "# CamelAGI";
    const fullLine = `${pathLine} ${marker}`;
    let addedToProfile = false;

    for (const profile of shellProfiles) {
      if (!fs.existsSync(profile)) continue;
      const content = fs.readFileSync(profile, "utf-8");
      if (content.includes(marker)) {
        addedToProfile = true;
        continue; // Already added
      }
      fs.appendFileSync(profile, `\n${fullLine}\n`);
      addedToProfile = true;
      console.log(`  Added to PATH in ${profile}`);
    }

    // If no existing profile found, create .zshrc (macOS default)
    if (!addedToProfile) {
      const zshrc = path.join(os.homedir(), ".zshrc");
      fs.appendFileSync(zshrc, `\n${fullLine}\n`);
      console.log(`  Added to PATH in ${zshrc}`);
    }

    if (target) {
      console.log(`  Version: ${target}`);
    }
  },
});

function getShellProfiles(): string[] {
  const home = os.homedir();
  return [
    path.join(home, ".zshrc"),
    path.join(home, ".bashrc"),
    path.join(home, ".bash_profile"),
    path.join(home, ".profile"),
  ];
}
