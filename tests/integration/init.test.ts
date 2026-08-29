/**
 * `paper-run init` against the real harness template.
 *
 * The unit tests cover init's decisions with the fetch stubbed out. These run
 * it for real — a genuine template, real harness Python scripts, a real git
 * repository — because the failures that matter here are contract mismatches
 * with the harness, and those are invisible to a mock.
 *
 * Two of the three bugs found while building init were exactly that shape: a
 * parameter name that did not exist, and a pair of harness steps that refuse
 * to run without a GitHub origin.
 */

import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { execaSync } from "execa";

import { initCommand } from "../../src/commands/init.js";
import { readRunState, readGatePolicy, readStageHistory } from "../../src/state/store.js";
import { detectHarness } from "../../src/harness/harness.js";
import { isAdapterInstalled } from "../../src/adapter/install.js";
import { parseTrailers } from "../../src/utils/git.js";
import { DirectoryNotEmptyError } from "../../src/utils/errors.js";
import { PIPELINE_STAGES } from "../../src/state/gate-presets.js";

import { makeTmpDir, cleanupTmp, writeBrief, templateCache } from "./fixtures.js";

let workspace: string;

beforeAll(() => {
  // Warm the cache once so the first test is not paying for the clone.
  templateCache();
}, 180_000);

afterEach(() => {
  if (workspace) cleanupTmp(workspace);
});

describe("init against the real template", () => {
  it("produces a complete, valid writing repository", async () => {
    workspace = makeTmpDir();
    const target = join(workspace, "paper");
    const brief = writeBrief(join(workspace, "brief.md"), { mode: "autonomous" });

    await initCommand(target, {
      brief,
      mode: "autonomous",
      template: "v0.3.0",
      local: true,
    });

    // --- the harness is really there ---
    expect(detectHarness(target)).toBe(true);
    expect(existsSync(join(target, "AGENTS.md"))).toBe(true);
    expect(existsSync(join(target, "PAPER.md"))).toBe(true);
    expect(existsSync(join(target, ".agents", "tools", "verify.sh"))).toBe(true);

    // --- the brief was ingested, not invented ---
    const briefContent = readFileSync(join(target, "BRIEF.md"), "utf-8");
    expect(briefContent).toContain("Gate policies in agent-driven writing pipelines");

    // The harness fills only decided fields and leaves the rest unresolved.
    // If this ever drops to zero, something started inventing content.
    const paper = readFileSync(join(target, "PAPER.md"), "utf-8");
    expect(paper.toLowerCase()).toContain("unresolved");

    // --- run state ---
    const state = readRunState(target);
    expect(state.mode).toBe("autonomous");
    expect(state.current_stage).toBe("bootstrap");
    expect(state.run_id).toMatch(/^[0-9a-f]{8}$/);
    expect(state.run_branch).toBe(`paper-run/${state.run_id}`);

    const policy = readGatePolicy(target);
    expect(policy.mode).toBe("autonomous");
    expect(Object.keys(policy.gates).sort()).toEqual([...PIPELINE_STAGES].sort());

    expect(readStageHistory(target).stages).toEqual([]);

    // --- adapter ---
    expect(isAdapterInstalled(target)).toBe(true);
    for (const file of [
      ".opencode/agents/paper-writer.md",
      ".opencode/agents/paper-reviewer.md",
      ".opencode/commands/status.md",
      ".opencode/commands/mode.md",
      ".opencode/commands/approve.md",
      ".opencode/plugins/gate-plugin.ts",
      "opencode.json",
    ]) {
      expect(existsSync(join(target, file)), file).toBe(true);
    }

    // The adapter's model placeholder must be resolved, or OpenCode will
    // fail to parse the config.
    const config = readFileSync(join(target, "opencode.json"), "utf-8");
    expect(config).not.toContain("{{");

    // --- git ---
    const branch = execaSync("git", ["branch", "--show-current"], { cwd: target }).stdout.trim();
    expect(branch).toBe(state.run_branch);

    const message = execaSync("git", ["log", "-1", "--format=%B"], { cwd: target }).stdout;
    const trailers = parseTrailers(message);
    expect(trailers["Paper-Run-Stage"]).toBe("bootstrap");
    expect(trailers["Paper-Run-Status"]).toBe("completed");
    expect(trailers["Paper-Run-Run"]).toBe(state.run_id);
    expect(trailers["Paper-Run-Mode"]).toBe("autonomous");
    expect(trailers["Paper-Run-Template"]).toBe("v0.3.0");

    // Nothing left uncommitted: a resumed run starts from a clean tree.
    const dirty = execaSync("git", ["status", "--porcelain"], { cwd: target }).stdout.trim();
    expect(dirty).toBe("");
  });

  it("honours collaborative mode in the gate policy it writes", async () => {
    workspace = makeTmpDir();
    const target = join(workspace, "paper");
    const brief = writeBrief(join(workspace, "brief.md"), { mode: "collaborative" });

    await initCommand(target, {
      brief,
      mode: "collaborative",
      template: "v0.3.0",
      local: true,
    });

    const policy = readGatePolicy(target);
    expect(policy.mode).toBe("collaborative");
    // The decision points a human should see.
    expect(policy.gates["material_assessment"]?.policy).toBe("await_human");
    expect(policy.gates["paper_positioning"]?.policy).toBe("await_human");
    expect(policy.gates["canonical_drafting"]?.policy).toBe("await_human");
    // And the ones they should not be interrupted for.
    expect(policy.gates["evidence_inventory"]?.policy).toBe("auto");
  });

  it("runs the harness's own validators successfully on a fresh repo", async () => {
    // If init leaves the repo in a state the harness rejects, every stage
    // afterwards would fail validation for reasons that have nothing to do
    // with the writing.
    workspace = makeTmpDir();
    const target = join(workspace, "paper");
    const brief = writeBrief(join(workspace, "brief.md"));

    await initCommand(target, { brief, mode: "autonomous", template: "v0.3.0", local: true });

    const result = execaSync(
      "python3",
      [join(target, ".agents", "tools", "check-paper-contracts.py")],
      { cwd: target, reject: false },
    );

    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
  });

  it("rejects a brief the harness considers invalid, leaving nothing behind", async () => {
    workspace = makeTmpDir();
    const target = join(workspace, "paper");

    // A bare `Mode:` line rather than a list item — the exact mistake the
    // validator catches, and the one a user is most likely to make.
    const brief = join(workspace, "bad-brief.md");
    writeFileSync(
      brief,
      "# Brief\n\n## Paper identity\n\nSomething.\n\n## Operating mode\n\nMode: autonomous\n",
    );

    await expect(
      initCommand(target, { brief, mode: "autonomous", template: "v0.3.0", local: true }),
    ).rejects.toThrow(/did not pass validation/);

    expect(existsSync(target)).toBe(false);
  });

  it("refuses a directory that already holds work, without touching it", async () => {
    workspace = makeTmpDir();
    const target = join(workspace, "existing");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "thesis.tex"), "\\documentclass{article}");
    const brief = writeBrief(join(workspace, "brief.md"));

    await expect(
      initCommand(target, { brief, mode: "autonomous", template: "v0.3.0", local: true }),
    ).rejects.toThrow(DirectoryNotEmptyError);

    expect(readdirSync(target)).toEqual(["thesis.tex"]);
    expect(readFileSync(join(target, "thesis.tex"), "utf-8")).toBe("\\documentclass{article}");
  });

  it("refuses to re-initialize an existing paper-run project", async () => {
    workspace = makeTmpDir();
    const target = join(workspace, "paper");
    const brief = writeBrief(join(workspace, "brief.md"));

    await initCommand(target, { brief, mode: "autonomous", template: "v0.3.0", local: true });
    const before = readRunState(target);

    await expect(
      initCommand(target, { brief, mode: "autonomous", template: "v0.3.0", local: true }),
    ).rejects.toThrow(/already a paper-run project/);

    // The original run is intact.
    expect(readRunState(target).run_id).toBe(before.run_id);
  });
});
