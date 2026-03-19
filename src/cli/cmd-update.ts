// CLI command: camel update — download latest version from GitHub Releases

import { register } from "./registry.js";
import { VERSION } from "../core/version.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO = "inawafalm/CamelAGI";
const VERSIONS_DIR = path.join(os.homedir(), ".camelagi", "versions");
const BIN_DIR = path.join(os.homedir(), ".camelagi", "bin");
const MAX_KEPT_VERSIONS = 3;

function compareSemver(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(".").map(Number);
  const pb = b.replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return 1;
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return -1;
  }
  return 0;
}

function getPlatform(): string {
  const osName = process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  return `${osName}-${arch}`;
}

register({
  name: "update",
  description: "Update CamelAGI to the latest version",
  run: async () => {
    const p = await import("@clack/prompts");

    p.intro("\x1b[36mCamelAGI\x1b[0m update");
    p.log.info(`Current version: ${VERSION}`);

    // 1. Check latest release
    const s = p.spinner();
    s.start("Checking for updates...");

    let latest: string;
    let downloadUrl: string;
    try {
      const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) throw new Error(`GitHub API: ${res.status}`);
      const data = await res.json() as { tag_name: string; assets: { name: string; browser_download_url: string }[] };
      latest = data.tag_name.replace(/^v/, "");

      const platform = getPlatform();
      const binaryName = `camelagi-${platform}`;
      const asset = data.assets.find(a => a.name === binaryName);
      if (!asset) {
        s.stop("No binary available");
        p.log.error(`No binary for ${platform} in release ${data.tag_name}`);
        p.outro("Check https://github.com/" + REPO + "/releases");
        return;
      }
      downloadUrl = asset.browser_download_url;
    } catch (err) {
      s.stop("Failed");
      p.log.error(`Could not check for updates: ${err instanceof Error ? err.message : err}`);
      return;
    }

    if (compareSemver(latest, VERSION) <= 0) {
      s.stop("Up to date");
      p.log.success(`Already on latest version (${VERSION})`);
      p.outro("");
      return;
    }

    s.stop(`New version available: ${latest}`);

    // 2. Download
    const s2 = p.spinner();
    s2.start(`Downloading v${latest}...`);

    fs.mkdirSync(VERSIONS_DIR, { recursive: true });
    const destPath = path.join(VERSIONS_DIR, latest);

    try {
      const res = await fetch(downloadUrl, { signal: AbortSignal.timeout(120000) });
      if (!res.ok) throw new Error(`Download failed: ${res.status}`);
      const buffer = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(destPath, buffer);
      fs.chmodSync(destPath, 0o755);
      s2.stop(`Downloaded (${(buffer.length / 1024 / 1024).toFixed(1)} MB)`);
    } catch (err) {
      s2.stop("Download failed");
      p.log.error(`${err instanceof Error ? err.message : err}`);
      try { fs.unlinkSync(destPath); } catch {}
      return;
    }

    // 3. Swap symlink
    fs.mkdirSync(BIN_DIR, { recursive: true });
    const camelLink = path.join(BIN_DIR, "camel");
    const camelagiLink = path.join(BIN_DIR, "camelagi");

    try { fs.unlinkSync(camelLink); } catch {}
    try { fs.unlinkSync(camelagiLink); } catch {}
    fs.symlinkSync(destPath, camelLink);
    fs.symlinkSync(destPath, camelagiLink);

    // Also update /usr/local/bin symlinks if they exist
    try {
      if (fs.lstatSync("/usr/local/bin/camel").isSymbolicLink()) {
        fs.unlinkSync("/usr/local/bin/camel");
        fs.symlinkSync(destPath, "/usr/local/bin/camel");
      }
    } catch {}
    try {
      if (fs.lstatSync("/usr/local/bin/camelagi").isSymbolicLink()) {
        fs.unlinkSync("/usr/local/bin/camelagi");
        fs.symlinkSync(destPath, "/usr/local/bin/camelagi");
      }
    } catch {}

    // 4. Clean old versions (keep last N)
    try {
      const versions = fs.readdirSync(VERSIONS_DIR)
        .filter(f => /^\d+\.\d+\.\d+/.test(f))
        .sort((a, b) => compareSemver(b, a)); // newest first

      for (const v of versions.slice(MAX_KEPT_VERSIONS)) {
        fs.unlinkSync(path.join(VERSIONS_DIR, v));
      }
    } catch {}

    p.log.success(`Updated: ${VERSION} → ${latest}`);
    p.outro("Restart any running server to use the new version.");
  },
});
