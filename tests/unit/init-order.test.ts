import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const events = vi.hoisted(() => [] as string[]);

vi.mock("../../src/harness/template.js", () => ({
  fetchTemplate: vi.fn(async ({ targetDir }: { targetDir: string }) => {
    mkdirSync(targetDir, { recursive: true });
    return { source: "local", version: "v0.3.0" };
  }),
  verifyTemplateTree: vi.fn(() => []),
  hasGhCli: vi.fn(async () => true),
  hasGhAuth: vi.fn(async () => true),
}));

vi.mock("../../src/harness/harness.js", () => ({
  initializeHarnessTrust: vi.fn(async () => { events.push("trust"); }),
  runBriefValidate: vi.fn(async () => {
    events.push("brief-validate");
    return { passed: true, exitCode: 0, stdout: "", stderr: "", scriptName: "paper-brief.py" };
  }),
  runPaperInit: vi.fn(async () => { events.push("paper-init"); }),
  runBriefIngest: vi.fn(async () => { events.push("brief-ingest"); }),
  getTemplateVersion: vi.fn(() => "v0.3.0"),
}));

vi.mock("../../src/adapter/install.js", () => ({ installAdapter: vi.fn(async () => undefined) }));
vi.mock("../../src/state/gate-presets.js", () => ({ generateGatePreset: vi.fn(() => ({})) }));
vi.mock("../../src/state/store.js", () => ({
  ensurePaperRunDir: vi.fn(),
  writeRunState: vi.fn(),
  writeGatePolicy: vi.fn(),
  writeStageHistory: vi.fn(),
}));
vi.mock("../../src/utils/git.js", () => ({
  isGitRepo: vi.fn(() => true),
  generateRunId: vi.fn(() => "test-run"),
  createRunBranch: vi.fn(async () => undefined),
  commitCheckpoint: vi.fn(async () => "0123456789abcdef"),
}));
vi.mock("execa", () => ({
  execa: vi.fn(async () => ({ stdout: "https://github.com/me/paper.git", exitCode: 0 })),
}));

import { initCommand } from "../../src/commands/init.js";

describe("init trust ordering", () => {
  let root: string;

  afterEach(() => {
    events.length = 0;
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("establishes trust before every fetched harness script", async () => {
    root = mkdtempSync(join(tmpdir(), "paper-run-init-order-"));
    const brief = join(root, "brief.md");
    writeFileSync(brief, "# Brief\n");

    await initCommand(join(root, "paper"), {
      brief,
      mode: "autonomous",
      template: "v0.3.0",
      local: true,
    });

    expect(events).toEqual([
      "trust",
      "brief-validate",
      "paper-init",
      "paper-init",
      "brief-ingest",
    ]);
  });
});
