import { register } from "./registry.js";

register({
  name: "bootstrap",
  description: "First-time setup (alias for 'camel setup')",
  run: async () => {
    const { runSetup } = await import("../setup.js");
    await runSetup();
  },
});
