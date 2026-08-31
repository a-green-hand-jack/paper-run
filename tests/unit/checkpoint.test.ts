import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execaSync } from "execa";

import { checkpointCommand, prepareRunResume } from "../../src/commands/checkpoint.js";
import { checkStagedLockedContracts } from "../../src/pipeline/locked-contract.js";
import { switchOperatingMode } from "../../src/state/mode.js";
import { generateGatePreset } from "../../src/state/gate-presets.js";
import {
  readStageHistory,
  writeGatePolicy,
  writeRunState,
  writeStageHistory,
} from "../../src/state/store.js";
import type { RunState } from "../../src/state/schema.js";
import {
  commitCheckpoint,
  getTrailersFromCommit,
  worktreeFileDigest,
} from "../../src/utils/git.js";

let repo: string;
let cwdSpy: ReturnType<typeof vi.spyOn>;

function state(overrides: Partial<RunState> = {}): RunState {
  return {
    schema_version: "paper-run-v1",
    run_id: "run12345",
    run_branch: "paper-run/run12345",
    mode: "autonomous",
    current_stage: "bootstrap",
    stage_status: "pending",
    started_at: "2026-08-30T10:00:00.000Z",
    updated_at: "2026-08-30T10:00:00.000Z",
    template_version: "v0.3.0",
    ...overrides,
  };
}

async function checkpoint(stageId = "bootstrap", status: RunState["stage_status"] = "completed") {
  return commitCheckpoint({
    stageId,
    status,
    runId: "run12345",
    mode: "autonomous",
    templateVersion: "v0.3.0",
  }, repo);
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "paper-run-checkpoint-"));
  mkdirSync(join(repo, ".paper-run"), { recursive: true });
  execaSync("git", ["init"], { cwd: repo });
  execaSync("git", ["config", "user.email", "test@test.com"], { cwd: repo });
  execaSync("git", ["config", "user.name", "Test"], { cwd: repo });
  execaSync("git", ["checkout", "-b", "paper-run/run12345"], { cwd: repo });
  writeRunState(repo, state());
  writeGatePolicy(repo, generateGatePreset("autonomous"));
  writeStageHistory(repo, { schema_version: "paper-run-stage-history-v1", stages: [] });
  writeFileSync(
    join(repo, "PAPER.md"),
    "# Paper Contract\n\n## Operating mode\n\n- Mode: autonomous\n\n## Next\n\nText.\n",
  );
  writeFileSync(join(repo, "BRIEF.md"), "# Brief\n\nImmutable brief.\n");
  execaSync("git", ["add", "-A"], { cwd: repo });
  execaSync("git", ["commit", "-m", "initial run state"], { cwd: repo });
  cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(repo);
});

afterEach(() => {
  cwdSpy.mockRestore();
  vi.restoreAllMocks();
  rmSync(repo, { recursive: true, force: true });
});

describe("prepareRunResume", () => {
  it("reconciles run state and history to the checkpoint at HEAD", async () => {
    const sha = await checkpoint();

    const result = await prepareRunResume(repo);

    expect(result.current_stage).toBe("bootstrap");
    expect(result.stage_status).toBe("completed");
    expect(readStageHistory(repo).stages).toEqual([
      expect.objectContaining({ stage_id: "bootstrap", status: "completed", commit_sha: sha }),
    ]);
  });

  it("rewinds a later mutable stage to the validated HEAD checkpoint", async () => {
    await checkpoint();
    writeRunState(repo, state({ current_stage: "material_assessment", stage_status: "approved" }));

    const result = await prepareRunResume(repo);

    expect(result.current_stage).toBe("bootstrap");
    expect(result.stage_status).toBe("completed");
    expect(readStageHistory(repo).stages.map((record) => record.stage_id)).toEqual(["bootstrap"]);
  });

  it("preserves a pending headless permission denial across resume reconciliation", async () => {
    await checkpoint();
    const message = [
      "Headless run requires approval for the bash permission.",
      "Stage: bootstrap",
      "Session: ses_1",
      "Request: per_1",
      'Command: "python3 .agents/tools/check-structure.py"',
      'Patterns: ["python3 .agents/tools/*"]',
    ].join("\n");
    writeRunState(repo, state({
      stage_status: "pending",
      error: { stage: "bootstrap", message, at: "2026-08-30T10:05:00.000Z" },
    }));

    const result = await prepareRunResume(repo);

    expect(result.stage_status).toBe("pending");
    expect(result.error?.message).toBe(message);
  });

  it("restores an earlier gate_waiting HEAD over later mutable state and history", async () => {
    const sha = await checkpoint("bootstrap", "gate_waiting");
    writeRunState(repo, state({ current_stage: "evidence_inventory", stage_status: "completed" }));
    writeStageHistory(repo, {
      schema_version: "paper-run-stage-history-v1",
      stages: [
        {
          stage_id: "evidence_inventory",
          status: "completed",
          started_at: "2026-08-30T10:01:00.000Z",
          completed_at: "2026-08-30T10:02:00.000Z",
          commit_sha: "mutable-only",
        },
      ],
    });

    const result = await prepareRunResume(repo);

    expect(result).toMatchObject({ current_stage: "bootstrap", stage_status: "gate_waiting" });
    expect(readStageHistory(repo).stages).toEqual([]);
    expect(execaSync("git", ["rev-parse", "HEAD"], { cwd: repo }).stdout.trim()).toBe(sha);
  });

  it("refuses project changes instead of allowing a later automatic checkpoint to sweep them in", async () => {
    await checkpoint();
    writeFileSync(join(repo, "notes.txt"), "unrelated work\n");

    await expect(prepareRunResume(repo)).rejects.toThrow(/uncheckpointed project changes/);
    expect(execaSync("git", ["status", "--porcelain", "notes.txt"], { cwd: repo }).stdout).toContain("??");
  });

  it("allows only unchanged partial output recorded after a timeout", async () => {
    await checkpoint();
    const partial = join(repo, "partial-stage-output.txt");
    writeFileSync(partial, "partial\n");
    writeRunState(repo, state({
      timeout_recovery: {
        stage: "bootstrap",
        files: { "partial-stage-output.txt": worktreeFileDigest(repo, "partial-stage-output.txt") },
      },
    }));

    await expect(prepareRunResume(repo)).resolves.toMatchObject({ current_stage: "bootstrap" });
    expect(readFileSync(partial, "utf-8")).toBe("partial\n");

    writeFileSync(partial, "changed after timeout\n");
    await expect(prepareRunResume(repo)).rejects.toThrow(/uncheckpointed project changes/);
  });

  it("rolls an uncheckpointed mode switch back to validated trailer provenance", async () => {
    await checkpoint();
    switchOperatingMode(repo, "collaborative");

    await expect(prepareRunResume(repo)).resolves.toMatchObject({ mode: "autonomous" });
    expect(readPaper(repo)).toContain("- Mode: autonomous");
  });

  it("does not let an arbitrary PAPER.md edit hide behind a mode switch", async () => {
    await checkpoint();
    switchOperatingMode(repo, "collaborative");
    writeFileSync(join(repo, "PAPER.md"), readPaper(repo).replace("Text.", "Changed text."));

    await expect(prepareRunResume(repo)).rejects.toThrow(/uncheckpointed project changes/);
  });

  it("does not let an arbitrary gate-policy edit hide behind a mode switch", async () => {
    await checkpoint();
    switchOperatingMode(repo, "collaborative");
    const path = join(repo, ".paper-run", "gate-policy.json");
    const policy = JSON.parse(readFileSync(path, "utf-8"));
    policy.gates.bootstrap.policy = "await_human";
    writeFileSync(path, `${JSON.stringify(policy, null, 2)}\n`);

    await expect(prepareRunResume(repo)).rejects.toThrow(/uncheckpointed project changes/);
  });

  it("refuses the wrong branch and a non-checkpoint commit at HEAD", async () => {
    await checkpoint();
    execaSync("git", ["checkout", "-b", "other"], { cwd: repo });
    await expect(prepareRunResume(repo)).rejects.toThrow(/belongs to branch/);

    execaSync("git", ["checkout", "paper-run/run12345"], { cwd: repo });
    execaSync("git", ["commit", "--allow-empty", "-m", "ordinary commit"], { cwd: repo });
    await expect(prepareRunResume(repo)).rejects.toThrow(/not a valid checkpoint/);
  });

  it.each(["pending", "running", "validating", "approved"] as const)(
    "reruns a %s checkpoint at that exact stage",
    async (status) => {
      await checkpoint("material_assessment", status);
      writeRunState(repo, state({ current_stage: "evidence_inventory", stage_status: "completed" }));

      await expect(prepareRunResume(repo)).resolves.toMatchObject({
        current_stage: "material_assessment",
        stage_status: "pending",
      });
    },
  );

  it("keeps a blocked checkpoint blocked and restores optional provenance", async () => {
    await commitCheckpoint({
      stageId: "material_assessment",
      status: "blocked",
      runId: "run12345",
      mode: "autonomous",
      stageTimeoutMultiplier: 2,
      sessionId: "ses_checkpoint",
      templateVersion: "v0.3.0",
      materialHash: "sha256:abc",
    }, repo);
    writeRunState(repo, state({ current_stage: "paper_positioning", session_id: "mutable" }));

    await expect(prepareRunResume(repo)).resolves.toMatchObject({
      current_stage: "material_assessment",
      stage_status: "blocked",
      session_id: "ses_checkpoint",
      material_hash: "sha256:abc",
      stage_timeout_multiplier: 2,
    });
  });

  it.each(["completed", "blocked", "gate_waiting"] as const)(
    "treats a legacy manual %s trailer as pending at the exact stage",
    async (status) => {
      writeFileSync(join(repo, "paper.tex"), "modified nonlocked output\n");
      execaSync("git", ["add", "paper.tex"], { cwd: repo });
      await commitCheckpoint({
        stageId: "material_assessment",
        status,
        runId: "run12345",
        mode: "autonomous",
        templateVersion: "v0.3.0",
        kind: "manual",
        stageAll: false,
      }, repo);
      writeRunState(repo, state({ current_stage: "evidence_inventory", stage_status: "completed" }));

      await expect(prepareRunResume(repo)).resolves.toMatchObject({
        current_stage: "material_assessment",
        stage_status: "pending",
      });
      expect(readStageHistory(repo).stages).toEqual([]);
    },
  );
});

function readPaper(dir: string): string {
  return readFileSync(join(dir, "PAPER.md"), "utf-8");
}

describe("checkpointCommand", () => {
  it("creates a manual checkpoint from explicitly staged changes", async () => {
    writeFileSync(join(repo, "paper.tex"), "draft\n");
    execaSync("git", ["add", "paper.tex"], { cwd: repo });

    await checkpointCommand();

    const sha = execaSync("git", ["rev-parse", "HEAD"], { cwd: repo }).stdout.trim();
    const trailers = await getTrailersFromCommit(sha, repo);
    expect(trailers["Paper-Run-Kind"]).toBe("manual");
    expect(trailers["Paper-Run-Stage"]).toBe("bootstrap");
    expect(trailers["Paper-Run-Status"]).toBe("pending");
    expect(execaSync("git", ["show", "--format=", "--name-only", "HEAD"], { cwd: repo }).stdout).toContain("paper.tex");
  });

  it("stamps pending even when mutable state says the stage completed", async () => {
    writeRunState(repo, state({ stage_status: "completed" }));
    writeFileSync(join(repo, "paper.tex"), "modified nonlocked output\n");
    execaSync("git", ["add", ".paper-run/run.json", "paper.tex"], { cwd: repo });

    await checkpointCommand();

    const trailers = await getTrailersFromCommit("HEAD", repo);
    expect(trailers["Paper-Run-Status"]).toBe("pending");
    await expect(prepareRunResume(repo)).resolves.toMatchObject({
      current_stage: "bootstrap",
      stage_status: "pending",
    });
  });

  it("rejects staged locked contract changes while leaving the index intact", async () => {
    writeFileSync(join(repo, "BRIEF.md"), "# Brief\n\nChanged immutable brief.\n");
    execaSync("git", ["add", "BRIEF.md"], { cwd: repo });
    const before = execaSync("git", ["rev-parse", "HEAD"], { cwd: repo }).stdout.trim();

    await expect(checkpointCommand()).rejects.toThrow(/locked-contract violation/);

    expect(execaSync("git", ["rev-parse", "HEAD"], { cwd: repo }).stdout.trim()).toBe(before);
    expect(execaSync("git", ["diff", "--cached", "--name-only"], { cwd: repo }).stdout).toContain("BRIEF.md");
  });

  it("rejects a staged PAPER.md heading-locked change", async () => {
    const path = join(repo, "PAPER.md");
    writeFileSync(path, "# Paper\n\n## Operating mode\n\n- Mode: autonomous\n\n## What readers should believe\n\n### Central thesis — locked\n\nOriginal thesis.\n\n## What must not change silently\n\n- None.\n");
    execaSync("git", ["add", "PAPER.md"], { cwd: repo });
    execaSync("git", ["commit", "-m", "establish paper contract"], { cwd: repo });
    writeFileSync(path, readPaper(repo).replace("Original thesis.", "Changed thesis."));
    execaSync("git", ["add", "PAPER.md"], { cwd: repo });

    await expect(checkpointCommand()).rejects.toThrow(/locked selector central_thesis/);
  });

  it("commits an exact digest-bound locked change with an audit trailer", async () => {
    const path = join(repo, "PAPER.md");
    writeFileSync(path, "# Paper\n\n## Operating mode\n\n- Mode: autonomous\n\n## What readers should believe\n\n### Central thesis — locked\n\nOriginal thesis.\n\n## What must not change silently\n\n- None.\n");
    execaSync("git", ["add", "PAPER.md"], { cwd: repo });
    execaSync("git", ["commit", "-m", "establish paper contract"], { cwd: repo });
    writeFileSync(path, readPaper(repo).replace("Original thesis.", "Human-authorized thesis."));
    execaSync("git", ["add", "PAPER.md"], { cwd: repo });
    const locked = await checkStagedLockedContracts(repo);
    const authorization = `${locked.baseCommit}:${locked.candidateDigest}`;

    await checkpointCommand({ authorizeLockedChange: authorization });

    const trailers = await getTrailersFromCommit("HEAD", repo);
    expect(trailers["Paper-Run-Locked-Authorization"]).toBe(authorization);
    expect(trailers["Paper-Run-Kind"]).toBe("manual");
    expect(trailers["Paper-Run-Status"]).toBe("pending");
  });

  it("rejects a stale locked-change authorization without changing HEAD", async () => {
    writeFileSync(join(repo, "BRIEF.md"), "Changed immutable brief.\n");
    execaSync("git", ["add", "BRIEF.md"], { cwd: repo });
    const before = execaSync("git", ["rev-parse", "HEAD"], { cwd: repo }).stdout.trim();

    await expect(
      checkpointCommand({ authorizeLockedChange: `${before}:${"0".repeat(64)}` }),
    ).rejects.toThrow(/does not match/);
    expect(execaSync("git", ["rev-parse", "HEAD"], { cwd: repo }).stdout.trim()).toBe(before);
  });

  it("refuses unstaged and untracked changes without modifying the index or HEAD", async () => {
    writeFileSync(join(repo, "notes.txt"), "not selected\n");
    const before = execaSync("git", ["rev-parse", "HEAD"], { cwd: repo }).stdout.trim();

    await expect(checkpointCommand()).rejects.toThrow(/refused unstaged changes/);

    expect(execaSync("git", ["rev-parse", "HEAD"], { cwd: repo }).stdout.trim()).toBe(before);
    expect(execaSync("git", ["diff", "--cached", "--name-only"], { cwd: repo }).stdout).toBe("");
  });
});
