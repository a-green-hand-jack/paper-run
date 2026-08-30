/**
 * Read/write helpers for `.paper-run/` state files.
 *
 * All writes are atomic (write to .tmp, then rename) to avoid corruption when
 * the process is killed mid-write. Reads validate against Zod schemas and
 * throw StateSchemaError on mismatch.
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
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

const STATE_LOCK_FILE = "state.lock";
const STATE_LOCK_TIMEOUT_MS = 5_000;
const STATE_LOCK_RETRY_MS = 10;
const INCOMPLETE_LOCK_GRACE_MS = 1_000;

type RunStateUpdate = Partial<RunState> | ((current: RunState) => Partial<RunState>);

interface LockOwner {
  pid: number;
  started: string;
  token: string;
}

export interface LockedStateStore {
  updateRunState(update: RunStateUpdate): RunState;
}

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
 * Serialize state transitions that read and then mutate run.json.
 *
 * The lock lives under Git's common directory, outside every tracked worktree.
 * Its PID and process-start identity allow a caller to reclaim it after the
 * owner dies without mistaking a reused PID for the original owner.
 */
export function withStateLock<T>(
  projectDir: string,
  callback: (store: LockedStateStore) => T,
  timeoutMs = STATE_LOCK_TIMEOUT_MS,
): T {
  const lockPath = stateLockPath(projectDir);
  const dir = dirname(lockPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const owner: LockOwner = {
    pid: process.pid,
    started: processStartIdentity(process.pid) ?? `process-${process.pid}`,
    token: randomUUID(),
  };
  const deadline = Date.now() + timeoutMs;
  let descriptor: number | undefined;
  while (descriptor === undefined) {
    try {
      descriptor = openSync(lockPath, "wx");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      if (!lockOwnerIsAlive(lockPath)) {
        reclaimLock(lockPath);
        continue;
      }
      if (Date.now() >= deadline) {
        throw new StateSchemaError(STATE_LOCK_FILE, `state mutation lock is held at ${lockPath}`);
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, STATE_LOCK_RETRY_MS);
    }
  }

  writeFileSync(descriptor, `${JSON.stringify(owner)}\n`, "utf-8");
  const store: LockedStateStore = {
    updateRunState: (update) => updateRunStateWithoutLock(projectDir, update),
  };

  const release = () => {
    closeSync(descriptor);
    if (readLockOwner(lockPath)?.token === owner.token) unlinkSync(lockPath);
  };

  let result: T;
  try {
    result = callback(store);
  } catch (error) {
    release();
    throw error;
  }

  if (isPromiseLike(result)) {
    return result.finally(release) as T;
  }
  release();
  return result;
}

function isPromiseLike(value: unknown): value is Promise<unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { finally?: unknown }).finally === "function"
  );
}

/** Resolve the untracked, per-worktree state lock location. */
export function stateLockPath(projectDir: string): string {
  const root = resolve(projectDir);
  const key = createHash("sha256").update(root).digest("hex").slice(0, 16);
  try {
    const output = execFileSync(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { cwd: root, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    return join(output, "paper-run", "locks", `${key}.lock`);
  } catch {
    return join(tmpdir(), "paper-run-locks", `${key}.lock`);
  }
}

function readLockOwner(path: string): LockOwner | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf-8")) as Partial<LockOwner>;
    return typeof value.pid === "number" && typeof value.started === "string" && typeof value.token === "string"
      ? value as LockOwner
      : null;
  } catch {
    return null;
  }
}

function lockOwnerIsAlive(path: string): boolean {
  const owner = readLockOwner(path);
  if (!owner) {
    try {
      return Date.now() - statSync(path).mtimeMs < INCOMPLETE_LOCK_GRACE_MS;
    } catch {
      return false;
    }
  }

  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }

  const actualStart = processStartIdentity(owner.pid);
  return actualStart === undefined || actualStart === owner.started;
}

function processStartIdentity(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
    const closeParen = stat.lastIndexOf(")");
    const fields = stat.slice(closeParen + 2).split(" ");
    const startTicks = fields[19];
    if (startTicks) return `proc:${startTicks}`;
  } catch {
    // Non-Linux hosts fall back to ps below.
  }

  try {
    const started = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return started ? `ps:${started}` : undefined;
  } catch {
    return undefined;
  }
}

function reclaimLock(path: string): void {
  const stalePath = `${path}.${randomUUID()}.stale`;
  try {
    renameSync(path, stalePath);
    unlinkSync(stalePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
  }
}

/**
 * Partially update run state. Reads current, merges, writes.
 * Automatically updates `updated_at`.
 */
export function updateRunState(projectDir: string, update: RunStateUpdate): RunState {
  return withStateLock(projectDir, (store) => store.updateRunState(update));
}

function updateRunStateWithoutLock(projectDir: string, update: RunStateUpdate): RunState {
  const current = readRunState(projectDir);
  const patch = typeof update === "function" ? update(current) : update;
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
