/**
 * Git operations: checkpoint commits, branch/tag management, trailer
 * parsing, and resume detection.
 */

import { execaSync, execa } from "execa";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { GIT, TRAILER_KEYS } from "../utils/constants.js";
import type { Mode, TrailerKey } from "../utils/constants.js";
import type { RunState } from "../state/schema.js";

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
  status: "completed" | "blocked";
  runId: string;
  mode: Mode;
  sessionId?: string;
  templateVersion: string;
  materialHash?: string;
}

/**
 * Create a git checkpoint commit with machine-readable trailers.
 * Stages all tracked changes and commits (allows empty).
 */
export async function commitCheckpoint(opts: CheckpointOpts, cwd: string): Promise<string> {
  const dir = resolve(cwd);

  // Stage all changes
  await execa("git", ["add", "-A"], { cwd: dir });

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
  pairs.push(["Paper-Run-Timestamp", new Date().toISOString()]);

  return pairs.map(([key, value]) => `${key}: ${value}`).join("\n");
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

/** Parse Paper-Run-* trailers from a commit message. */
export function parseTrailers(commitMessage: string): Trailers {
  const trailers: Trailers = {};

  for (const line of commitMessage.split("\n")) {
    for (const key of TRAILER_KEYS) {
      const prefix = `${key}: `;
      if (line.startsWith(prefix)) {
        trailers[key] = line.slice(prefix.length).trim();
      }
    }
  }

  return trailers;
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
}

/** Check if the working tree has uncommitted changes. */
export async function checkDirtyState(cwd: string): Promise<DirtyState> {
  const { stdout } = await execa("git", ["status", "--porcelain"], { cwd });
  const files = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return { clean: files.length === 0, files };
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
): Promise<{ consistent: boolean; headSha: string }> {
  const { stdout } = await execa("git", ["rev-parse", "HEAD"], { cwd });
  const headSha = stdout.trim();

  const branch = await getCurrentBranch(cwd);
  const expectedBranch = state.run_branch;
  const consistent = branch === expectedBranch;

  return { consistent, headSha };
}
