import { defineConfig } from "tsup";

const shared: import("tsup").Options = {
  format: ["esm"],
  target: "node20",
  platform: "node",
  outDir: "dist",
  sourcemap: true,
  splitting: false,
  shims: false,
  // Keep runtime deps external so global installs resolve them from node_modules.
  external: ["@opencode-ai/sdk", "chalk", "commander", "execa", "zod"],
};

export default defineConfig([
  {
    ...shared,
    entry: { cli: "src/cli.ts" },
    clean: true,
    dts: false,
    banner: { js: "#!/usr/bin/env node" },
  },
  {
    ...shared,
    entry: { index: "src/index.ts" },
    clean: false,
    dts: true,
  },
]);
