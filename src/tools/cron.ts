// Cron tool: let the agent manage scheduled tasks at runtime

import { z } from "zod";
import type { ToolDef } from "../core/types.js";
import {
  getAllJobStatuses,
  addRuntimeJob,
  removeRuntimeJob,
  runJobNow,
} from "../extensions/cron.js";

export const cronTool: ToolDef = {
  name: "cron",
  description: `Manage scheduled tasks (cron jobs). The user can ask you to set reminders, schedule recurring tasks, or manage existing jobs.

Actions:
- list: Show all cron jobs and their status
- add: Create a new scheduled job
- remove: Delete a runtime-created job
- run: Trigger a job immediately

Schedule formats:
- "5m", "1h", "30s", "1d" — repeating interval
- "*/5 * * * *" — cron expression
- "+20m", "+2h" — one-shot (runs once in N minutes/hours, then auto-deletes)
- "2026-03-14T09:00:00Z" — one-shot at exact time`,
  schema: z.object({
    action: z.enum(["list", "add", "remove", "run"]).describe("Action to perform"),
    id: z.string().nullable().optional().describe("Job ID (required for remove/run)"),
    name: z.string().nullable().optional().describe("Display name (for add)"),
    schedule: z.string().nullable().optional().describe("Schedule expression (for add)"),
    prompt: z.string().nullable().optional().describe("The message/task the agent receives when the job fires (for add)"),
  }),
  execute: async (args) => {
    const { action, id, name, schedule, prompt } = args as {
      action: string;
      id?: string | null;
      name?: string | null;
      schedule?: string | null;
      prompt?: string | null;
    };

    switch (action) {
      case "list": {
        const statuses = getAllJobStatuses();
        if (statuses.length === 0) return "No cron jobs configured.";
        return statuses
          .map((s) => {
            const lines = [`${s.id} — ${s.name || "(unnamed)"}`];
            lines.push(`  Schedule: ${s.schedule} | Source: ${s.source} | Enabled: ${s.enabled}`);
            if (s.running) lines.push("  Status: running");
            if (s.lastRunAt) {
              const ago = Math.round((Date.now() - s.lastRunAt) / 1000);
              lines.push(`  Last run: ${ago}s ago (${s.lastStatus}${s.lastError ? `: ${s.lastError}` : ""})`);
            }
            lines.push(`  Prompt: ${s.prompt.slice(0, 120)}${s.prompt.length > 120 ? "..." : ""}`);
            return lines.join("\n");
          })
          .join("\n\n");
      }

      case "add": {
        if (!schedule) return "Error: 'schedule' is required for add.";
        if (!prompt) return "Error: 'prompt' is required for add.";
        const jobId = id || `job-${Date.now().toString(36)}`;
        const jobName = name || jobId;

        try {
          const job = addRuntimeJob({
            id: jobId,
            name: jobName,
            schedule,
            prompt,
            enabled: true,
          });
          const isAt = schedule.startsWith("+") || (new Date(schedule).getTime() > 0 && schedule.length > 8);
          return `Created ${isAt ? "one-shot" : "repeating"} job "${job.id}" (${schedule}). ${isAt ? "Will auto-delete after running." : "Running now and then on schedule."}`;
        } catch (err: unknown) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      }

      case "remove": {
        if (!id) return "Error: 'id' is required for remove.";
        const removed = removeRuntimeJob(id);
        return removed
          ? `Removed job "${id}".`
          : `Job "${id}" not found. Config-defined jobs can only be removed by editing config.yaml.`;
      }

      case "run": {
        if (!id) return "Error: 'id' is required for run.";
        try {
          const response = await runJobNow(id);
          return `Job "${id}" ran successfully. Response:\n${response.slice(0, 500)}`;
        } catch (err: unknown) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      }

      default:
        return `Unknown action "${action}". Use: list, add, remove, run`;
    }
  },
};
