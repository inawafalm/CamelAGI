import * as esbuild from "esbuild";

await esbuild.build({
  entryPoints: ["src/gateway-entry.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outfile: "dist/camelagi-gateway.mjs",
  banner: {
    js: [
      "#!/usr/bin/env node",
      'import { createRequire } from "node:module";',
      "const require = createRequire(import.meta.url);",
    ].join("\n"),
  },
  external: [],
  minify: false,
  sourcemap: true,
});

console.log("Built dist/camelagi-gateway.mjs");
