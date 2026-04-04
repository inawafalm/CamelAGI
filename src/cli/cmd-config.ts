import { register } from "./registry.js";
import { loadConfig, saveConfig, ensureDirs } from "../core/config.js";

register({
  name: "config",
  description: "View/edit config (get, set, list)",
  usage: `Usage: camelagi config <subcommand> [options]

View or edit configuration.

Subcommands:
  list              List all config values (default)
  get <key>         Get a specific config value
  set <key> <value> Set a config value

Examples:
  camelagi config
  camelagi config list
  camelagi config get model
  camelagi config set model gpt-4o
  camelagi config set maxTurns 50`,
  run: async (args) => {
    ensureDirs();
    const sub = args[0];

    if (sub === "list" || !sub) {
      const config = loadConfig();
      for (const [key, value] of Object.entries(config)) {
        if (key === "apiKey" && value) {
          console.log(`  ${key}: ***${(value as string).slice(-4)}`);
        } else if (typeof value === "object") {
          console.log(`  ${key}: ${JSON.stringify(value)}`);
        } else {
          console.log(`  ${key}: ${value}`);
        }
      }
      process.exit(0);
    }

    if (sub === "get") {
      const key = args[1];
      if (!key) {
        console.error("Usage: camelagi config get <key>");
        process.exit(1);
      }
      const config = loadConfig();
      const value = (config as Record<string, unknown>)[key];
      if (value === undefined) {
        console.error(`Unknown key: ${key}`);
        process.exit(1);
      }
      if (key === "apiKey" && typeof value === "string") {
        console.log(`***${value.slice(-4)}`);
      } else {
        console.log(typeof value === "object" ? JSON.stringify(value, null, 2) : value);
      }
      process.exit(0);
    }

    if (sub === "set") {
      const key = args[1];
      const value = args[2];
      if (!key || value === undefined) {
        console.error("Usage: camelagi config set <key> <value>");
        process.exit(1);
      }

      // Validate key exists in config schema
      const config = loadConfig();
      if (!(key in config)) {
        const validKeys = Object.keys(config).join(", ");
        console.error(`Unknown config key: "${key}"\nValid keys: ${validKeys}`);
        process.exit(1);
      }

      let parsed: unknown = value;
      if (value === "true") parsed = true;
      else if (value === "false") parsed = false;
      else if (/^\d+$/.test(value)) parsed = parseInt(value, 10);

      saveConfig({ [key]: parsed });
      console.log(`Set ${key} = ${value}`);
      process.exit(0);
    }

    console.error(`Unknown config subcommand: ${sub}. Use: list, get, set`);
    process.exit(1);
  },
});
