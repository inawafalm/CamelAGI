import { register } from "./registry.js";
import { ensureDirs } from "../core/config.js";

register({
  name: "doctor",
  description: "Run health checks",
  run: async () => {
    ensureDirs();
    console.log("\n\x1b[36m  CamelAGI Doctor\x1b[0m\n");
    const { runDoctor, formatChecks } = await import("../doctor.js");
    const checks = await runDoctor();
    console.log(formatChecks(checks));
    const errors = checks.filter((c) => c.status === "error");
    const warns = checks.filter((c) => c.status === "warn");
    console.log(`\n  ${checks.length} checks: ${checks.length - errors.length - warns.length} ok, ${warns.length} warnings, ${errors.length} errors\n`);
    process.exit(errors.length > 0 ? 1 : 0);
  },
});
