import { defineConfig } from "vitest/config";

/**
 * Shared settings. The three tiers are defined in vitest.workspace.ts.
 */
export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    // Integration and smoke tiers share on-disk fixtures, so files must not
    // run in parallel with each other.
    fileParallelism: false,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/index.ts", "src/version.ts"],
    },
  },
});
