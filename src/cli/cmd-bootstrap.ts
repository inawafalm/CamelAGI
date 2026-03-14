import { register } from "./registry.js";

register({
  name: "bootstrap",
  description: "First-time setup via Telegram admin bot",
  run: async (args) => {
    const { runBootstrap } = await import("../bootstrap.js");
    await runBootstrap(args[0]);
  },
});
