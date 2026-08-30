/**
 * Git operations: checkpoint commits, branch/tag management, trailer
 * parsing, and resume detection.
 */

import { execaSync, execa } from "execa";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { GIT, TRAILER_KEYS } from "../utils/constants.js";
import { MODES } from "../utils/constants.js";
import type { Mode, TrailerKey } from "../utils/constants.js";
import { StageStatusSchema, type RunState } from "../state/schema.js";
import { PIPELINE_STAGES } from "../state/gate-presets.js";
import { PaperRunError } from "../utils/errors.js";

// ---------------------------------------------------------------------------
// Run ID generation
// ---------------------------------------------------------------------------

/** Generate a short (8 char) run identifier. */
export function generateRunId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 8);
}

// ---------------------------------------------------------------------------
// Branch management
// ---------------------------------------------------------------------------

export async function createRunBranch(runId: string, cwd: string): Promise<string> {
  const branch = `${GIT.runBranchPrefix}${runId}`;
  await execa("git", ["checkout", "-b", branch], { cwd });
  return branch;
}

export async function getCurrentBranch(cwd: string): Promise<string> {
  const { stdout } = await execa("git", ["branch", "--show-current"], { cwd });
  return stdout.trim();
}

export function isOnRunBranch(branch: string): boolean {
  return branch.startsWith(GIT.runBranchPrefix);
}

// ---------------------------------------------------------------------------
// Checkpoint commit
// ---------------------------------------------------------------------------

export interface CheckpointOpts {
  stageId: string;
  status: RunState["stage_status"];
  runId: string;
  mode: Mode;
  sessionId?: string;
  templateVersion: string;
  materialHash?: string;
  lockedAuthorization?: string;
  kind?: "automatic" | "manual";
  /** Automatic stage checkpoints own all stage output; manual ones do not. */
  stageAll?: boolean;
  /** Paths owned by a non-stage-all checkpoint. The whole tree is verified. */
  stagePaths?: readonly string[];
}

/**
 * Create a git checkpoint commit with machine-readable trailers.
 * Stages all tracked changes and commits (allows empty).
 */
export async function commitCheckpoint(opts: CheckpointOpts, cwd: string): Promise<string> {
  const dir = resolve(cwd);

  if (opts.stageAll !== false) {
    await execa("git", ["add", "-A"], { cwd: dir });
  } else if (opts.stagePaths?.length) {
    await execa("git", ["add", "--", ...opts.stagePaths], { cwd: dir });
    await verifyExplicitCheckpointPaths(opts.stagePaths, dir);
  }

  // Build commit message
  const subject = `Stage: ${opts.stageId} — ${opts.status}`;
  const trailers = buildTrailers(opts);
  const message = `${subject}\n\n${trailers}`;

  // Commit (allow empty so checkpoints are always recorded)
  await execa("git", ["commit", "--allow-empty", "-m", message], { cwd: dir });

  // Get the resulting SHA
  const { stdout } = await execa("git", ["rev-parse", "HEAD"], { cwd: dir });
  return stdout.trim();
}

async function verifyExplicitCheckpointPaths(paths: readonly string[], cwd: string): Promise<void> {
  const allowed = new Set(paths);
  const dirty = await checkDirtyState(cwd);
  const unexpected = [...new Set([
    ...dirty.stagedFiles,
    ...dirty.unstagedFiles,
    ...dirty.untrackedFiles,
  ])].filter((path) => !allowed.has(path));
  if (unexpected.length > 0) {
    throw new PaperRunError(
      `Checkpoint refused unexpected project changes:\n${unexpected.sort().map((path) => `  ${path}`).join("\n")}`,
    );
  }

  const unstagedOwned = dirty.unstagedFiles.filter((path) => allowed.has(path));
  if (unstagedOwned.length > 0) {
    throw new PaperRunError(
      `Checkpoint refused controller state that changed after staging:\n${unstagedOwned.map((path) => `  ${path}`).join("\n")}`,
    );
  }
}

function buildTrailers(opts: CheckpointOpts): string {
  const pairs: Array<[string, string]> = [
    ["Paper-Run-Stage", opts.stageId],
    ["Paper-Run-Status", opts.status],
    ["Paper-Run-Run", opts.runId],
    ["Paper-Run-Mode", opts.mode],
  ];

  if (opts.sessionId) pairs.push(["Paper-Run-Session", opts.sessionId]);
  pairs.push(["Paper-Run-Template", opts.templateVersion]);
  if (opts.materialHash) pairs.push(["Paper-Run-Material-Hash", opts.materialHash]);
  if (opts.lockedAuthorization) pairs.push(["Paper-Run-Locked-Authorization", opts.lockedAuthorization]);
  pairs.push(["Paper-Run-Kind", opts.kind ?? "automatic"]);
  pairs.push(["Paper-Run-Timestamp", new Date().toISOString()]);

  return pairs.map(([key, value]) => `${key}: ${safeTrailerValue(key, value)}`).join("\n");
}

function safeTrailerValue(key: string, value: string): string {
  if (value.length < 1 || value.length > 256 || /\p{Cc}/u.test(value)) {
    throw new PaperRunError(`Invalid ${key} checkpoint trailer value.`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Tag
// ---------------------------------------------------------------------------

export async function tagCandidate(runId: string, cwd: string): Promise<string> {
  const tag = `${GIT.candidateTagPrefix}${runId}`;
  await execa("git", ["tag", tag, "-m", `Paper candidate from run ${runId}`], { cwd });
  return tag;
}

// ---------------------------------------------------------------------------
// Trailer parsing
// ---------------------------------------------------------------------------

export type Trailers = Partial<Record<TrailerKey, string>>;

const REQUIRED_TRAILERS: readonly TrailerKey[] = [
  "Paper-Run-Stage",
  "Paper-Run-Status",
  "Paper-Run-Run",
  "Paper-Run-Mode",
  "Paper-Run-Template",
  "Paper-Run-Kind",
  "Paper-Run-Timestamp",
];

/** Parse one strictly formed terminal Paper-Run trailer block. */
export function parseTrailers(commitMessage: string): Trailers {
  if (!commitMessage.includes(`${GIT.trailerPrefix}`)) return {};
  if (/\r|\0/.test(commitMessage)) throw invalidTrailers("contains an injected control character");

  const lines = commitMessage.replace(/\n+$/, "").split("\n");
  let blockStart = lines.length - 1;
  while (blockStart >= 0 && lines[blockStart]!.startsWith(GIT.trailerPrefix)) blockStart--;
  blockStart++;
  if (blockStart === lines.length || blockStart === 0 || lines[blockStart - 1] !== "") {
    throw invalidTrailers("must be a single terminal block separated from the commit body");
  }
  if (lines.slice(0, blockStart).some((line) => line.startsWith(GIT.trailerPrefix))) {
    throw invalidTrailers("contains a duplicate or non-terminal Paper-Run trailer");
  }

  const trailers: Trailers = {};
  for (const line of lines.slice(blockStart)) {
    const separator = line.indexOf(": ");
    const key = line.slice(0, separator) as TrailerKey;
    const value = line.slice(separator + 2);
    if (separator < 0 || !(TRAILER_KEYS as readonly string[]).includes(key)) {
      throw invalidTrailers(`contains unknown key ${line.split(":", 1)[0] || "<empty>"}`);
    }
    if (trailers[key] !== undefined) throw invalidTrailers(`contains duplicate key ${key}`);
    safeTrailerValue(key, value);
    trailers[key] = value;
  }

  for (const key of REQUIRED_TRAILERS) {
    if (trailers[key] === undefined) throw invalidTrailers(`is missing mandatory key ${key}`);
  }
  if (!PIPELINE_STAGES.includes(trailers["Paper-Run-Stage"] as never)) throw invalidTrailers("has an unknown stage");
  if (!StageStatusSchema.safeParse(trailers["Paper-Run-Status"]).success) throw invalidTrailers("has an unknown status");
  if (!(MODES as readonly string[]).includes(trailers["Paper-Run-Mode"]!)) throw invalidTrailers("has an unknown mode");
  if (!(["automatic", "manual"] as const).includes(trailers["Paper-Run-Kind"] as never)) throw invalidTrailers("has an unknown kind");
  const lockedAuthorization = trailers["Paper-Run-Locked-Authorization"];
  if (lockedAuthorization && !/^[0-9a-f]{40}:[0-9a-f]{64}$/.test(lockedAuthorization)) {
    throw invalidTrailers("has an invalid locked-contract authorization");
  }
  if (lockedAuthorization && trailers["Paper-Run-Kind"] !== "manual") {
    throw invalidTrailers("has a locked-contract authorization on a non-manual checkpoint");
  }
  const timestamp = trailers["Paper-Run-Timestamp"]!;
  const timestampMs = Date.parse(timestamp);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(timestamp) || Number.isNaN(timestampMs) || new Date(timestampMs).toISOString() !== timestamp) {
    throw invalidTrailers("has an invalid timestamp");
  }
  const subject = lines[0];
  if (subject !== `Stage: ${trailers["Paper-Run-Stage"]} — ${trailers["Paper-Run-Status"]}`) {
    throw invalidTrailers("does not match the checkpoint commit subject");
  }

  return trailers;
}

function invalidTrailers(reason: string): PaperRunError {
  return new PaperRunError(`Invalid Paper-Run checkpoint trailers: ${reason}.`);
}

export function validateCheckpointIdentity(
  trailers: Trailers,
  expected: { runId: string; branch: string; templateVersion: string },
): void {
  const runId = trailers["Paper-Run-Run"];
  if (runId !== expected.runId) throw invalidTrailers(`run ID ${runId ?? "<missing>"} does not match ${expected.runId}`);
  const trailerBranch = `${GIT.runBranchPrefix}${runId}`;
  if (expected.branch !== trailerBranch) throw invalidTrailers(`run branch ${expected.branch} does not match ${trailerBranch}`);
  if (trailers["Paper-Run-Template"] !== expected.templateVersion) {
    throw invalidTrailers(`template ${trailers["Paper-Run-Template"]} does not match ${expected.templateVersion}`);
  }
}

/** Get trailers from a specific commit (by sha or ref). */
export async function getTrailersFromCommit(ref: string, cwd: string): Promise<Trailers> {
  const { stdout } = await execa("git", ["log", "-1", "--format=%B", ref], { cwd });
  return parseTrailers(stdout);
}

// ---------------------------------------------------------------------------
// Resume detection
// ---------------------------------------------------------------------------

/**
 * Find the most recent Paper-Run checkpoint commit on the current branch.
 * Returns the SHA and parsed trailers, or null if none found.
 */
export async function findLastCheckpoint(
  cwd: string,
  runId?: string,
): Promise<{ sha: string; trailers: Trailers } | null> {
  // Search the last 100 commits for a Paper-Run-Stage trailer.
  const { stdout } = await execa(
    "git",
    ["log", "--oneline", "--format=%H %s", "-100"],
    { cwd },
  );

  for (const line of stdout.split("\n")) {
    const sha = line.split(" ")[0];
    if (!sha) continue;

    const trailers = await getTrailersFromCommit(sha, cwd);
    if (!trailers["Paper-Run-Stage"]) continue;

    // If a runId filter is specified, must match.
    if (runId && trailers["Paper-Run-Run"] !== runId) continue;

    return { sha, trailers };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Working tree state
// ---------------------------------------------------------------------------

export interface DirtyState {
  clean: boolean;
  files: string[];
  stagedFiles: string[];
  unstagedFiles: string[];
  untrackedFiles: string[];
}

/** Check if the working tree has uncommitted changes. */
export async function checkDirtyState(cwd: string): Promise<DirtyState> {
  const [{ stdout }, staged, unstaged, untracked] = await Promise.all([
    execa("git", ["status", "--porcelain"], { cwd }),
    execa("git", ["diff", "--cached", "--name-only"], { cwd }),
    execa("git", ["diff", "--name-only"], { cwd }),
    execa("git", ["ls-files", "--others", "--exclude-standard"], { cwd }),
  ]);
  const files = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const names = (value: string): string[] => value.split("\n").map((line) => line.trim()).filter(Boolean);
  return {
    clean: files.length === 0,
    files,
    stagedFiles: names(staged.stdout),
    unstagedFiles: names(unstaged.stdout),
    untrackedFiles: names(untracked.stdout),
  };
}

/** True if the directory is a git repository. */
export function isGitRepo(cwd: string): boolean {
  try {
    execaSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd });
    return true;
  } catch {
    return false;
  }
}

/**
 * Verify that HEAD matches the expected state — used for resume safety.
 */
export async function verifyHeadConsistency(
  state: RunState,
  cwd: string,
): Promise<{ consistent: boolean; headSha: string; checkpointSha?: string }> {
  const { stdout } = await execa("git", ["rev-parse", "HEAD"], { cwd });
  const headSha = stdout.trim();

  const branch = await getCurrentBranch(cwd);
  const expectedBranch = state.run_branch;
  let checkpoint: Awaited<ReturnType<typeof findLastCheckpoint>> = null;
  if (branch === expectedBranch) {
    const trailers = await getTrailersFromCommit(headSha, cwd);
    if (trailers["Paper-Run-Stage"]) {
      validateCheckpointIdentity(trailers, {
        runId: state.run_id,
        branch,
        templateVersion: state.template_version,
      });
      checkpoint = { sha: headSha, trailers };
    }
  }
  const consistent = checkpoint?.sha === headSha;

  return {
    consistent,
    headSha,
    ...(checkpoint ? { checkpointSha: checkpoint.sha } : {}),
  };
}
