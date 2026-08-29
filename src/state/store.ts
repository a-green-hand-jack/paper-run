/**
 * Read/write helpers for `.paper-run/` state files.
 *
 * All writes are atomic (write to .tmp, then rename) to avoid corruption when
 * the process is killed mid-write. Reads validate against Zod schemas and
 * throw StateSchemaError on mismatch.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { ZodType } from "zod";

import { PAPER_RUN_DIR, STATE_FILES } from "../utils/constants.js";
import { StateSchemaError } from "../utils/errors.js";
import {
  RunStateSchema,
  GatePolicySchema,
  StageHistorySchema,
  SessionStateSchema,
  AssessmentSchema,
} from "./schema.js";
import type { RunState, GatePolicy, StageHistory, SessionState, Assessment } from "./schema.js";

// ---------------------------------------------------------------------------
// Generic read/write with schema validation + atomic write
// ---------------------------------------------------------------------------

function statePath(projectDir: string, file: string): string {
  return join(resolve(projectDir), PAPER_RUN_DIR, file);
}

function readJson<T>(path: string, schema: ZodType<T>, fileName: string): T {
  if (!existsSync(path)) {
    throw new StateSchemaError(fileName, "file does not exist");
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    throw new StateSchemaError(fileName, `invalid JSON: ${(err as Error).message}`);
  }

  const result = schema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new StateSchemaError(fileName, issues);
  }

  return result.data;
}

function writeJson(path: string, data: unknown): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const tmp = `${path}.${randomUUID().slice(0, 8)}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf-8");
  renameSync(tmp, path);
}

// ---------------------------------------------------------------------------
// run.json
// ---------------------------------------------------------------------------

export function readRunState(projectDir: string): RunState {
  return readJson(statePath(projectDir, STATE_FILES.run), RunStateSchema, STATE_FILES.run);
}

export function writeRunState(projectDir: string, state: RunState): void {
  // Re-validate before writing (belt+suspenders).
  RunStateSchema.parse(state);
  writeJson(statePath(projectDir, STATE_FILES.run), state);
}

/**
 * Partially update run state. Reads current, merges, writes.
 * Automatically updates `updated_at`.
 */
export function updateRunState(projectDir: string, patch: Partial<RunState>): RunState {
  const current = readRunState(projectDir);
  const next: RunState = {
    ...current,
    ...patch,
    updated_at: new Date().toISOString(),
  };
  writeRunState(projectDir, next);
  return next;
}

// ---------------------------------------------------------------------------
// gate-policy.json
// ---------------------------------------------------------------------------

export function readGatePolicy(projectDir: string): GatePolicy {
  return readJson(
    statePath(projectDir, STATE_FILES.gatePolicy),
    GatePolicySchema,
    STATE_FILES.gatePolicy,
  );
}

export function writeGatePolicy(projectDir: string, policy: GatePolicy): void {
  GatePolicySchema.parse(policy);
  writeJson(statePath(projectDir, STATE_FILES.gatePolicy), policy);
}

// ---------------------------------------------------------------------------
// stage-history.json
// ---------------------------------------------------------------------------

export function readStageHistory(projectDir: string): StageHistory {
  return readJson(
    statePath(projectDir, STATE_FILES.stageHistory),
    StageHistorySchema,
    STATE_FILES.stageHistory,
  );
}

export function writeStageHistory(projectDir: string, history: StageHistory): void {
  StageHistorySchema.parse(history);
  writeJson(statePath(projectDir, STATE_FILES.stageHistory), history);
}

// ---------------------------------------------------------------------------
// session.json
// ---------------------------------------------------------------------------

export function readSessionState(projectDir: string): SessionState | null {
  const path = statePath(projectDir, STATE_FILES.session);
  if (!existsSync(path)) return null;
  return readJson(path, SessionStateSchema, STATE_FILES.session);
}

export function writeSessionState(projectDir: string, session: SessionState): void {
  SessionStateSchema.parse(session);
  writeJson(statePath(projectDir, STATE_FILES.session), session);
}

export function clearSessionState(projectDir: string): void {
  const path = statePath(projectDir, STATE_FILES.session);
  if (existsSync(path)) unlinkSync(path);
}

// ---------------------------------------------------------------------------
// assessment.json
// ---------------------------------------------------------------------------

export function readAssessment(projectDir: string): Assessment | null {
  const path = statePath(projectDir, STATE_FILES.assessment);
  if (!existsSync(path)) return null;
  return readJson(path, AssessmentSchema, STATE_FILES.assessment);
}

// ---------------------------------------------------------------------------
// Initialization helpers
// ---------------------------------------------------------------------------

/** Ensure `.paper-run/` directory exists. */
export function ensurePaperRunDir(projectDir: string): string {
  const dir = join(resolve(projectDir), PAPER_RUN_DIR);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}
