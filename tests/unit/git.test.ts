import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execaSync } from "execa";

import {
  generateRunId,
  createRunBranch,
  getCurrentBranch,
  isOnRunBranch,
  commitCheckpoint,
  tagCandidate,
  parseTrailers,
  getTrailersFromCommit,
  findLastCheckpoint,
  checkDirtyState,
  isGitRepo,
  verifyHeadConsistency,
} from "../../src/utils/git.js";

function initGitRepo(dir: string): void {
  execaSync("git", ["init"], { cwd: dir });
  execaSync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
  execaSync("git", ["config", "user.name", "Test"], { cwd: dir });
  // Need at least one commit for branch operations.
  execaSync("git", ["commit", "--allow-empty", "-m", "initial"], { cwd: dir });
}

describe("generateRunId", () => {
  it("returns 8-character string", () => {
    const id = generateRunId();
    expect(id).toHaveLength(8);
    expect(id).toMatch(/^[a-f0-9]{8}$/);
  });

  it("generates unique ids", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateRunId()));
    expect(ids.size).toBe(100);
  });
});

describe("branch management", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "paper-run-git-"));
    initGitRepo(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("createRunBranch creates and switches to the branch", async () => {
    const branch = await createRunBranch("abcd1234", tmpDir);
    expect(branch).toBe("paper-run/abcd1234");
    const current = await getCurrentBranch(tmpDir);
    expect(current).toBe("paper-run/abcd1234");
  });

  it("isOnRunBranch identifies run branches", () => {
    expect(isOnRunBranch("paper-run/abc123")).toBe(true);
    expect(isOnRunBranch("main")).toBe(false);
    expect(isOnRunBranch("feature/something")).toBe(false);
  });
});

describe("commitCheckpoint", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "paper-run-git-"));
    initGitRepo(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates a commit with trailers", async () => {
    writeFileSync(join(tmpDir, "test.txt"), "hello");

    const sha = await commitCheckpoint(
      {
        stageId: "material_assessment",
        status: "completed",
        runId: "abcd1234",
        mode: "autonomous",
        stageTimeoutMultiplier: 2,
        sessionId: "ses_xyz",
        templateVersion: "v0.3.0",
        materialHash: "sha256:deadbeef",
      },
      tmpDir,
    );

    expect(sha).toHaveLength(40);

    const trailers = await getTrailersFromCommit(sha, tmpDir);
    expect(trailers["Paper-Run-Stage"]).toBe("material_assessment");
    expect(trailers["Paper-Run-Status"]).toBe("completed");
    expect(trailers["Paper-Run-Run"]).toBe("abcd1234");
    expect(trailers["Paper-Run-Mode"]).toBe("autonomous");
    expect(trailers["Paper-Run-Stage-Timeout-Multiplier"]).toBe("2");
    expect(trailers["Paper-Run-Session"]).toBe("ses_xyz");
    expect(trailers["Paper-Run-Template"]).toBe("v0.3.0");
    expect(trailers["Paper-Run-Material-Hash"]).toBe("sha256:deadbeef");
    expect(trailers["Paper-Run-Timestamp"]).toBeDefined();
  });

  it("allows empty commits", async () => {
    const sha = await commitCheckpoint(
      {
        stageId: "bootstrap",
        status: "completed",
        runId: "abcd1234",
        mode: "collaborative",
        templateVersion: "v0.3.0",
      },
      tmpDir,
    );
    expect(sha).toHaveLength(40);
  });

  it("rejects invalid timeout provenance before committing", async () => {
    const before = execaSync("git", ["rev-parse", "HEAD"], { cwd: tmpDir }).stdout.trim();
    await expect(commitCheckpoint({
      stageId: "bootstrap",
      status: "completed",
      runId: "abcd1234",
      mode: "autonomous",
      stageTimeoutMultiplier: 0,
      templateVersion: "v0.3.0",
    }, tmpDir)).rejects.toThrow(/Invalid stage timeout multiplier/);
    expect(execaSync("git", ["rev-parse", "HEAD"], { cwd: tmpDir }).stdout.trim()).toBe(before);
  });

  it("stages only explicit checkpoint paths and rejects every other project change", async () => {
    writeFileSync(join(tmpDir, "owned.txt"), "owned");
    writeFileSync(join(tmpDir, "unexpected.txt"), "unexpected");

    await expect(commitCheckpoint({
      stageId: "bootstrap",
      status: "completed",
      runId: "abcd1234",
      mode: "autonomous",
      templateVersion: "v0.3.0",
      stageAll: false,
      stagePaths: ["owned.txt"],
    }, tmpDir)).rejects.toThrow(/unexpected project changes/);

    expect(execaSync("git", ["diff", "--cached", "--name-only"], { cwd: tmpDir }).stdout.trim()).toBe("owned.txt");
    expect(execaSync("git", ["status", "--porcelain", "unexpected.txt"], { cwd: tmpDir }).stdout).toContain("??");
  });
});

describe("tagCandidate", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "paper-run-git-"));
    initGitRepo(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates a tag with the correct name", async () => {
    const tag = await tagCandidate("abcd1234", tmpDir);
    expect(tag).toBe("paper-candidate/abcd1234");

    // Verify tag exists
    const { stdout } = execaSync("git", ["tag", "-l", tag], { cwd: tmpDir });
    expect(stdout.trim()).toBe(tag);
  });
});

describe("parseTrailers", () => {
  it("extracts Paper-Run-* trailers from a commit message", () => {
    const message = `Stage: material_assessment — completed

Paper-Run-Stage: material_assessment
Paper-Run-Status: completed
Paper-Run-Run: abcd1234
Paper-Run-Mode: autonomous
Paper-Run-Template: v0.3.0
Paper-Run-Kind: automatic
Paper-Run-Timestamp: 2026-08-28T10:00:00.000Z`;

    const trailers = parseTrailers(message);
    expect(trailers["Paper-Run-Stage"]).toBe("material_assessment");
    expect(trailers["Paper-Run-Status"]).toBe("completed");
    expect(trailers["Paper-Run-Run"]).toBe("abcd1234");
    expect(trailers["Paper-Run-Mode"]).toBe("autonomous");
    expect(trailers["Paper-Run-Template"]).toBe("v0.3.0");
  });

  it("returns empty object for messages without trailers", () => {
    const trailers = parseTrailers("Just a normal commit message\n\nWith a body");
    expect(Object.keys(trailers)).toHaveLength(0);
  });

  it.each([
    ["missing mandatory key", `Subject\n\nPaper-Run-Stage: bootstrap\nPaper-Run-Status: completed`],
    ["duplicate key", `Subject\n\nPaper-Run-Stage: bootstrap\nPaper-Run-Stage: bootstrap\nPaper-Run-Status: completed\nPaper-Run-Run: abcd1234\nPaper-Run-Mode: autonomous\nPaper-Run-Template: v0.3.0\nPaper-Run-Kind: automatic\nPaper-Run-Timestamp: 2026-08-28T10:00:00.000Z`],
    ["body impersonation", `Ordinary commit\n\nPaper-Run-Stage: bootstrap\nPaper-Run-Status: completed\nPaper-Run-Run: abcd1234\nPaper-Run-Mode: autonomous\nPaper-Run-Template: v0.3.0\nPaper-Run-Kind: automatic\nPaper-Run-Timestamp: 2026-08-28T10:00:00.000Z`],
    ["control injection", `Subject\n\nPaper-Run-Stage: bootstrap\rmalicious\nPaper-Run-Status: completed\nPaper-Run-Run: abcd1234\nPaper-Run-Mode: autonomous\nPaper-Run-Template: v0.3.0\nPaper-Run-Kind: automatic\nPaper-Run-Timestamp: 2026-08-28T10:00:00.000Z`],
    ["authorization on automatic checkpoint", `Stage: bootstrap — completed\n\nPaper-Run-Stage: bootstrap\nPaper-Run-Status: completed\nPaper-Run-Run: abcd1234\nPaper-Run-Mode: autonomous\nPaper-Run-Template: v0.3.0\nPaper-Run-Locked-Authorization: ${"a".repeat(40)}:${"b".repeat(64)}\nPaper-Run-Kind: automatic\nPaper-Run-Timestamp: 2026-08-28T10:00:00.000Z`],
  ])("rejects %s trailers", (_name, message) => {
    expect(() => parseTrailers(message)).toThrow(/Invalid Paper-Run checkpoint trailers/);
  });

  it("prevents newline injection while constructing trailers", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "paper-run-git-injection-"));
    initGitRepo(tmpDir);
    await expect(commitCheckpoint({
      stageId: "bootstrap\nPaper-Run-Run: attacker",
      status: "completed",
      runId: "abcd1234",
      mode: "autonomous",
      templateVersion: "v0.3.0",
    }, tmpDir)).rejects.toThrow(/Invalid Paper-Run-Stage/);
    rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe("findLastCheckpoint", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "paper-run-git-"));
    initGitRepo(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null when no checkpoint exists", async () => {
    const result = await findLastCheckpoint(tmpDir);
    expect(result).toBeNull();
  });

  it("finds the most recent checkpoint", async () => {
    await commitCheckpoint(
      { stageId: "bootstrap", status: "completed", runId: "run1", mode: "autonomous", templateVersion: "v0.3.0" },
      tmpDir,
    );
    await commitCheckpoint(
      { stageId: "material_assessment", status: "completed", runId: "run1", mode: "autonomous", templateVersion: "v0.3.0" },
      tmpDir,
    );

    const result = await findLastCheckpoint(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.trailers["Paper-Run-Stage"]).toBe("material_assessment");
  });

  it("filters by runId", async () => {
    await commitCheckpoint(
      { stageId: "bootstrap", status: "completed", runId: "run1", mode: "autonomous", templateVersion: "v0.3.0" },
      tmpDir,
    );
    await commitCheckpoint(
      { stageId: "bootstrap", status: "completed", runId: "run2", mode: "autonomous", templateVersion: "v0.3.0" },
      tmpDir,
    );

    const result = await findLastCheckpoint(tmpDir, "run1");
    expect(result).not.toBeNull();
    expect(result!.trailers["Paper-Run-Run"]).toBe("run1");
  });
});

describe("checkDirtyState", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "paper-run-git-"));
    initGitRepo(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reports clean when nothing changed", async () => {
    const state = await checkDirtyState(tmpDir);
    expect(state.clean).toBe(true);
    expect(state.files).toHaveLength(0);
  });

  it("reports dirty with untracked file", async () => {
    writeFileSync(join(tmpDir, "new.txt"), "content");
    const state = await checkDirtyState(tmpDir);
    expect(state.clean).toBe(false);
    expect(state.files.length).toBeGreaterThan(0);
    expect(state.untrackedFiles).toEqual(["new.txt"]);
  });
});

describe("verifyHeadConsistency", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "paper-run-git-"));
    initGitRepo(tmpDir);
    execaSync("git", ["checkout", "-b", "paper-run/abcd1234"], { cwd: tmpDir });
  });

  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it("requires the run checkpoint itself to be HEAD", async () => {
    const state = {
      schema_version: "paper-run-v1" as const,
      run_id: "abcd1234",
      run_branch: "paper-run/abcd1234",
      mode: "autonomous" as const,
      current_stage: "bootstrap",
      stage_status: "completed" as const,
      started_at: "2026-08-30T10:00:00.000Z",
      updated_at: "2026-08-30T10:00:00.000Z",
      template_version: "v0.3.0",
    };
    await commitCheckpoint({
      stageId: "bootstrap",
      status: "completed",
      runId: state.run_id,
      mode: state.mode,
      templateVersion: state.template_version,
    }, tmpDir);
    expect((await verifyHeadConsistency(state, tmpDir)).consistent).toBe(true);

    execaSync("git", ["commit", "--allow-empty", "-m", "not a checkpoint"], { cwd: tmpDir });
    expect((await verifyHeadConsistency(state, tmpDir)).consistent).toBe(false);
  });
});

describe("isGitRepo", () => {
  it("returns true for a git repo", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "paper-run-git-"));
    initGitRepo(tmpDir);
    expect(isGitRepo(tmpDir)).toBe(true);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns false for a non-git directory", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "paper-run-git-"));
    expect(isGitRepo(tmpDir)).toBe(false);
    rmSync(tmpDir, { recursive: true, force: true });
  });
});
