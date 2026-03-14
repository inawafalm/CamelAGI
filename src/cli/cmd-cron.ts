import { register } from "./registry.js";
import { loadConfig, ensureDirs } from "../core/config.js";
import { getFlag, validateSchedule } from "./parse.js";

register({
  name: "cron",
  description: "Manage cron jobs (list, add, rm, run)",
  usage: `Usage: camelagi cron <subcommand> [options]

Manage scheduled AI tasks.

Subcommands:
  list                     List all cron jobs (default)
  add [options]            Create a new cron job
  rm <id>                  Remove a runtime job
  run <id>                 Run a job immediately

Add options:
  --name <name>            Job name (default: "Untitled")
  --schedule <schedule>    Schedule: 5m, 1h, 1d, +20m, */5 * * * *, ISO timestamp
  --prompt <prompt>        Prompt to run (required)
  --id <id>                Custom job ID

Examples:
  camelagi cron list
  camelagi cron add --name "Daily" --schedule "1d" --prompt "summarize today"
  camelagi cron rm job-abc123
  camelagi cron run daily-summary`,
  run: async (args) => {
    ensureDirs();
    const { getAllJobStatuses, addRuntimeJob, removeRuntimeJob, loadRuntimeJobs } = await import("../extensions/cron.js");
    const sub = args[0];

    if (!sub || sub === "list") {
      const config = loadConfig();
      const configJobs = config.cron.filter((j) => j.enabled);
      const runtimeJobs = loadRuntimeJobs();
      const allJobs = [
        ...configJobs.map((j) => ({ ...j, source: "config" as const })),
        ...runtimeJobs.map((j) => ({ ...j, source: "runtime" as const })),
      ];

      if (allJobs.length === 0) {
        console.log("No cron jobs. Add one with: camelagi cron add --name 'My Job' --schedule '1h' --prompt 'do something'");
      } else {
        for (const j of allJobs) {
          const status = j.enabled ? "\x1b[32m●\x1b[0m" : "\x1b[90m○\x1b[0m";
          const src = j.source === "config" ? "\x1b[90m(config)\x1b[0m" : "\x1b[36m(runtime)\x1b[0m";
          console.log(`  ${status} ${j.id}  ${j.name || "(unnamed)"}  ${j.schedule}  ${src}`);
          console.log(`    \x1b[90m${j.prompt.slice(0, 100)}${j.prompt.length > 100 ? "..." : ""}\x1b[0m`);
        }
      }
      process.exit(0);
    }

    if (sub === "add") {
      const name = getFlag(args, "--name");
      const schedule = getFlag(args, "--schedule");
      const prompt = getFlag(args, "--prompt");
      const id = getFlag(args, "--id");

      if (!schedule || !prompt) {
        console.error("Usage: camelagi cron add --name 'Job Name' --schedule '5m' --prompt 'do something'");
        console.error("\nSchedule formats: 5m, 1h, 1d, */5 * * * *, +20m (one-shot), ISO timestamp (one-shot)");
        process.exit(1);
      }

      try {
        validateSchedule(schedule);
      } catch (err: unknown) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }

      try {
        const job = addRuntimeJob({
          id: id || `job-${Date.now().toString(36)}`,
          name: name || "Untitled",
          schedule,
          prompt,
          enabled: true,
        }, false);
        console.log(`\x1b[32m✓\x1b[0m Created job: ${job.id} (${schedule})`);
        console.log("  Will start on next \x1b[36mcamelagi serve\x1b[0m");
      } catch (err: unknown) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
      process.exit(0);
    }

    if (sub === "rm" && args[1]) {
      const removed = removeRuntimeJob(args[1]);
      if (removed) {
        console.log(`\x1b[32m✓\x1b[0m Removed job: ${args[1]}`);
      } else {
        console.error(`Job "${args[1]}" not found. Config-defined jobs must be removed from config.yaml.`);
        process.exit(1);
      }
      process.exit(0);
    }

    if (sub === "run" && args[1]) {
      console.log(`Triggering job "${args[1]}" via embedded server...`);
      const { startServer } = await import("../serve.js");
      const handle = await startServer({ port: 0, silent: true, channels: false, boot: false, cron: false });
      try {
        const { runJobNow } = await import("../extensions/cron.js");
        const response = await runJobNow(args[1]);
        console.log(`\x1b[32m✓\x1b[0m Response:\n${response}`);
      } catch (err: unknown) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      } finally {
        await handle.close();
      }
      process.exit(0);
    }

    console.error(`Unknown cron subcommand: ${sub}. Use: list, add, rm <id>, run <id>`);
    process.exit(1);
  },
});
