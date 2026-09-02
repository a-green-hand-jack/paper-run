import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import {
  RunStateSchema,
  GatePolicySchema,
  StageHistorySchema,
  SessionStateSchema,
  AssessmentSchema,
} from "../../src/state/schema.js";
import {
  readRunState,
  writeRunState,
  updateRunState,
  readGatePolicy,
  writeGatePolicy,
  readStageHistory,
  writeStageHistory,
  readSessionState,
  writeSessionState,
  clearSessionState,
  readAssessment,
  ensurePaperRunDir,
  withStateLock,
  stateLockPath,
} from "../../src/state/store.js";
import {
  generateGatePreset,
  switchGatePreset,
  PIPELINE_STAGES,
} from "../../src/state/gate-presets.js";
import { StateSchemaError } from "../../src/utils/errors.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeRunState(overrides: Partial<ReturnType<typeof RunStateSchema.parse>> = {}) {
  return {
    schema_version: "paper-run-v1" as const,
    run_id: "abcdef12",
    run_branch: "paper-run/abcdef12",
    mode: "autonomous" as const,
    current_stage: "material_assessment",
    stage_status: "running" as const,
    started_at: "2026-08-28T10:00:00.000Z",
    updated_at: "2026-08-28T10:01:00.000Z",
    template_version: "v0.3.0",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

describe("RunStateSchema", () => {
  it("accepts valid state", () => {
    const result = RunStateSchema.safeParse(makeRunState());
    expect(result.success).toBe(true);
  });

  it("rejects wrong schema_version", () => {
    const result = RunStateSchema.safeParse(makeRunState({ schema_version: "paper-run-v99" as any }));
    expect(result.success).toBe(false);
  });

  it("rejects missing required fields", () => {
    const result = RunStateSchema.safeParse({ schema_version: "paper-run-v1" });
    expect(result.success).toBe(false);
  });

  it("accepts optional fields", () => {
    const data = makeRunState({
      material_hash: "sha256:abcdef",
      session_id: "ses_abc123",
      server_port: 4096,
      error: { stage: "drafting", message: "timeout", at: "2026-08-28T10:02:00.000Z" },
    });
    const result = RunStateSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it("accepts a positive stage timeout multiplier and rejects unsafe values", () => {
    expect(RunStateSchema.safeParse(makeRunState({ stage_timeout_multiplier: 2 })).success).toBe(true);
    expect(RunStateSchema.safeParse(makeRunState({ stage_timeout_multiplier: 0 })).success).toBe(false);
    expect(RunStateSchema.safeParse(makeRunState({ stage_timeout_multiplier: 101 })).success).toBe(false);
  });
});

describe("GatePolicySchema", () => {
  it("accepts valid policy", () => {
    const result = GatePolicySchema.safeParse({
      schema_version: "paper-run-gate-policy-v1",
      mode: "collaborative",
      gates: {
        material_assessment: { policy: "await_human" },
        full_draft: { policy: "auto" },
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid policy action", () => {
    const result = GatePolicySchema.safeParse({
      schema_version: "paper-run-gate-policy-v1",
      mode: "autonomous",
      gates: {
        bootstrap: { policy: "yolo" },
      },
    });
    expect(result.success).toBe(false);
  });
});

describe("StageHistorySchema", () => {
  it("accepts empty stages", () => {
    const result = StageHistorySchema.safeParse({
      schema_version: "paper-run-stage-history-v1",
      stages: [],
    });
    expect(result.success).toBe(true);
  });

  it("accepts a completed stage record", () => {
    const result = StageHistorySchema.safeParse({
      schema_version: "paper-run-stage-history-v1",
      stages: [
        {
          stage_id: "bootstrap",
          status: "completed",
          started_at: "2026-08-28T10:00:00.000Z",
          completed_at: "2026-08-28T10:01:00.000Z",
          commit_sha: "abc123",
          material_verdict: "usable",
        },
      ],
    });
    expect(result.success).toBe(true);
  });
});

describe("SessionStateSchema", () => {
  it("accepts valid session", () => {
    const result = SessionStateSchema.safeParse({
      schema_version: "paper-run-session-v1",
      server_url: "http://127.0.0.1:4096",
      session_id: "ses_abc123",
      created_at: "2026-08-28T10:00:00.000Z",
      pid: 12345,
    });
    expect(result.success).toBe(true);
  });
});

describe("AssessmentSchema", () => {
  it("accepts valid assessment", () => {
    const result = AssessmentSchema.safeParse({
      schema_version: "paper-run-assessment-v1",
      verdict: "partial",
      criteria: {
        research_question: { rating: "sufficient", evidence: "clearly stated in brief" },
        evidence: { rating: "partial", evidence: "only 2 of 5 experiments complete" },
      },
      summary: "Can proceed with some sections marked TODO",
      missing_for_usable: ["experiment 3 results", "figure 2"],
      can_proceed_with: ["introduction", "methods", "related work"],
      blockers: [],
      assessed_files: ["BRIEF.md", "EXPERIMENTS.md"],
      assessed_at: "2026-08-28T10:00:00.000Z",
    });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Store read/write
// ---------------------------------------------------------------------------

describe("store", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "paper-run-state-"));
    mkdirSync(join(tmpDir, ".paper-run"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("run state", () => {
    it("write then read roundtrips", () => {
      const state = makeRunState();
      writeRunState(tmpDir, state);
      const read = readRunState(tmpDir);
      expect(read).toEqual(state);
    });

    it("throws StateSchemaError on missing file", () => {
      expect(() => readRunState(tmpDir + "/nope")).toThrow(StateSchemaError);
    });

    it("throws StateSchemaError on invalid JSON", () => {
      writeFileSync(join(tmpDir, ".paper-run", "run.json"), "not json");
      expect(() => readRunState(tmpDir)).toThrow(StateSchemaError);
    });

    it("throws StateSchemaError on wrong schema", () => {
      writeFileSync(join(tmpDir, ".paper-run", "run.json"), JSON.stringify({ schema_version: "nope" }));
      expect(() => readRunState(tmpDir)).toThrow(StateSchemaError);
    });

    it("updateRunState merges and updates updated_at", () => {
      const state = makeRunState();
      writeRunState(tmpDir, state);

      const updated = updateRunState(tmpDir, { stage_status: "completed" });
      expect(updated.stage_status).toBe("completed");
      expect(updated.run_id).toBe(state.run_id);  // unchanged
      expect(updated.updated_at).not.toBe(state.updated_at);  // refreshed
    });

    it("holds an untracked lock for a mutation and releases it afterward", () => {
      const state = makeRunState();
      writeRunState(tmpDir, state);
      const lockPath = stateLockPath(tmpDir);

      expect(lockPath.startsWith(tmpDir + "/")).toBe(false);

      withStateLock(tmpDir, (store) => {
        expect(existsSync(lockPath)).toBe(true);
        store.updateRunState({ stage_status: "completed" });
      });

      expect(existsSync(lockPath)).toBe(false);
      expect(readRunState(tmpDir).stage_status).toBe("completed");
    });

    it("refuses a second state mutation while the repository lock is held", () => {
      writeRunState(tmpDir, makeRunState());

      withStateLock(tmpDir, () => {
        expect(() => withStateLock(tmpDir, () => undefined, 0)).toThrow(/lock is held/);
      });
    });

    it("keeps the lock until an asynchronous mutation boundary settles", async () => {
      writeRunState(tmpDir, makeRunState());

      await withStateLock(tmpDir, async (store) => {
        await Promise.resolve();
        expect(() => withStateLock(tmpDir, () => undefined, 0)).toThrow(/lock is held/);
        store.updateRunState({ stage_status: "completed" });
      });

      expect(readRunState(tmpDir).stage_status).toBe("completed");
      expect(existsSync(stateLockPath(tmpDir))).toBe(false);
    });

    it("recovers a lock whose owner process is dead", () => {
      writeRunState(tmpDir, makeRunState());
      const lockPath = stateLockPath(tmpDir);
      mkdirSync(dirname(lockPath), { recursive: true });
      writeFileSync(
        lockPath,
        JSON.stringify({ pid: 2_147_483_647, started: "proc:dead", token: "stale" }),
      );

      expect(updateRunState(tmpDir, { stage_status: "completed" }).stage_status).toBe("completed");
      expect(existsSync(lockPath)).toBe(false);
    });
  });

  describe("gate policy", () => {
    it("write then read roundtrips", () => {
      const policy = generateGatePreset("autonomous");
      writeGatePolicy(tmpDir, policy);
      const read = readGatePolicy(tmpDir);
      expect(read).toEqual(policy);
    });
  });

  describe("stage history", () => {
    it("write then read roundtrips", () => {
      const history = { schema_version: "paper-run-stage-history-v1" as const, stages: [] };
      writeStageHistory(tmpDir, history);
      const read = readStageHistory(tmpDir);
      expect(read).toEqual(history);
    });
  });

  describe("session state", () => {
    it("returns null when file does not exist", () => {
      expect(readSessionState(tmpDir)).toBeNull();
    });

    it("write then read roundtrips", () => {
      const session = {
        schema_version: "paper-run-session-v1" as const,
        server_url: "http://127.0.0.1:4096",
        session_id: "ses_abc",
        created_at: "2026-08-28T10:00:00.000Z",
        pid: 999,
      };
      writeSessionState(tmpDir, session);
      expect(readSessionState(tmpDir)).toEqual(session);
    });

    it("clearSessionState removes the file", () => {
      const session = {
        schema_version: "paper-run-session-v1" as const,
        server_url: "http://127.0.0.1:4096",
        session_id: "ses_abc",
        created_at: "2026-08-28T10:00:00.000Z",
      };
      writeSessionState(tmpDir, session);
      clearSessionState(tmpDir);
      expect(readSessionState(tmpDir)).toBeNull();
    });
  });

  describe("assessment", () => {
    it("returns null when file does not exist", () => {
      expect(readAssessment(tmpDir)).toBeNull();
    });
  });

  describe("ensurePaperRunDir", () => {
    it("creates .paper-run/ if missing", () => {
      const fresh = join(tmpDir, "newproject");
      mkdirSync(fresh);
      const dir = ensurePaperRunDir(fresh);
      expect(existsSync(dir)).toBe(true);
      expect(dir.endsWith(".paper-run")).toBe(true);
    });
  });

  describe("atomic write safety", () => {
    it("does not leave partial files on schema validation failure", () => {
      // writeRunState validates before writing — a bad state should throw,
      // and the file should not be created if it didn't exist before.
      const path = join(tmpDir, ".paper-run", "run.json");
      expect(existsSync(path)).toBe(false);

      expect(() =>
        writeRunState(tmpDir, { schema_version: "wrong" } as any),
      ).toThrow();

      expect(existsSync(path)).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// Gate presets
// ---------------------------------------------------------------------------

describe("gate presets", () => {
  it("autonomous: all gates auto", () => {
    const policy = generateGatePreset("autonomous");
    expect(policy.mode).toBe("autonomous");
    for (const stage of PIPELINE_STAGES) {
      expect(policy.gates[stage]?.policy).toBe("auto");
    }
  });

  it("collaborative: key gates await_human, others auto", () => {
    const policy = generateGatePreset("collaborative");
    expect(policy.mode).toBe("collaborative");
    expect(policy.gates["material_assessment"]?.policy).toBe("await_human");
    expect(policy.gates["paper_plan"]?.policy).toBe("await_human");
    expect(policy.gates["paper_plan"]?.policy).toBe("await_human");
    expect(policy.gates["full_draft"]?.policy).toBe("await_human");
    expect(policy.gates["independent_review"]?.policy).toBe("await_human");
    expect(policy.gates["paper_candidate"]?.policy).toBe("await_human");
    // Others are auto
    expect(policy.gates["bootstrap"]?.policy).toBe("auto");
    expect(policy.gates["self_review"]?.policy).toBe("auto");
    expect(policy.gates["evidence_reconciliation"]?.policy).toBe("auto");
  });

  it("covers all 13 pipeline stages", () => {
    const policy = generateGatePreset("autonomous");
    expect(Object.keys(policy.gates)).toHaveLength(PIPELINE_STAGES.length);
    for (const stage of PIPELINE_STAGES) {
      expect(policy.gates[stage]).toBeDefined();
    }
  });

  it("switchGatePreset preserves user overrides", () => {
    const collab = generateGatePreset("collaborative");
    // User overrides: set self_review to await_human (not the default)
    collab.gates["self_review"] = { policy: "await_human" };

    const switched = switchGatePreset(collab, "autonomous");
    expect(switched.mode).toBe("autonomous");
    // User override preserved (self_review was non-default, so kept)
    expect(switched.gates["self_review"]?.policy).toBe("await_human");
    // Others reset to autonomous defaults
    expect(switched.gates["material_assessment"]?.policy).toBe("auto");
    expect(switched.gates["full_draft"]?.policy).toBe("auto");
  });

  it("switchGatePreset resets non-overridden gates", () => {
    const auto = generateGatePreset("autonomous");
    const switched = switchGatePreset(auto, "collaborative");
    // All were at autonomous defaults, so all get collaborative defaults
    expect(switched.gates["material_assessment"]?.policy).toBe("await_human");
    expect(switched.gates["paper_plan"]?.policy).toBe("await_human");
  });
});
