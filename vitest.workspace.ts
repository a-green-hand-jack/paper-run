import { defineWorkspace } from "vitest/config";

/**
 * Three tiers, separated by what they need and how long they take.
 *
 *  - **unit** — no network, no OpenCode, no clock dependence. Runs anywhere,
 *    including on a machine with no internet.
 *  - **integration** — real git repositories and a real harness template, but
 *    OpenCode is mocked. Needs network on a cold cache.
 *  - **smoke** — a real `opencode` binary driving a real session. Excluded
 *    from the default run because it needs credentials and spends tokens.
 *
 * `npm test` runs unit + integration, so a contributor without OpenCode
 * credentials still gets a green suite. Smoke is opt-in.
 */
export default defineWorkspace([
  {
    test: {
      name: "unit",
      environment: "node",
      include: ["tests/unit/**/*.test.ts"],
    },
  },
  {
    test: {
      name: "integration",
      environment: "node",
      include: ["tests/integration/**/*.test.ts"],
      // Cloning a template and running harness scripts is an order of
      // magnitude slower than a unit test.
      testTimeout: 120_000,
      hookTimeout: 180_000,
    },
  },
  {
    test: {
      name: "smoke",
      environment: "node",
      include: ["tests/smoke/**/*.test.ts"],
      testTimeout: 600_000,
      hookTimeout: 600_000,
    },
  },
]);
