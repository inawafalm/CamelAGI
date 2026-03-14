import { register } from "./registry.js";
import { getFlagInt } from "./parse.js";

register({
  name: "logs",
  description: "Tail server request log",
  usage: `Usage: camelagi logs [options]

Display recent server request logs.

Options:
  -n <number>   Number of lines to show (default: 50, min: 1)

Examples:
  camelagi logs
  camelagi logs -n 100`,
  run: async (args) => {
    let lines = 50;
    try {
      lines = getFlagInt(args, "-n", 1) ?? 50;
    } catch (err: unknown) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
    const { tailLog } = await import("../gateway/logger.js");
    console.log(tailLog(lines));
    process.exit(0);
  },
});
