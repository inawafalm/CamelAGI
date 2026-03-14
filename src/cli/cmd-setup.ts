import { register } from "./registry.js";

register({
  name: "setup",
  description: "Interactive setup wizard",
  run: async () => {
    const { runSetup } = await import("../setup.js");
    await runSetup();
    process.exit(0);
  },
});
