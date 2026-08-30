import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { join } from "node:path";
import { execa } from "execa";

import { readRunState, readStageHistory, updateRunState, writeStageHistory } from "../state/store.js";
import { replacePaperMode, switchOperatingMode } from "../state/mode.js";
import { GatePolicySchema, type RunState, type StageHistory, type StageRecord } from "../state/schema.js";
import { switchGatePreset } from "../state/gate-presets.js";
import { getCurrentBranch, findLastCheckpoint, verifyHeadConsistency, checkDirtyState, commitCheckpoint } from "../utils/git.js";
import { PAPER_RUN_DIR, STATE_FILES } from "../utils/constants.js";
import { PaperRunError } from "../utils/errors.js";
import { requireProjectRoot } from "../utils/paths.js";
import { getStage, stageNumber } from "../pipeline/stages.js";
import { log } from "../utils/logger.js";
import {
  authorizesLockedContract,
  checkStagedLockedContracts,
  formatLockedContractFailure,
  parseLockedContractAuthorization,
} from "../pipeline/locked-contract.js";

const GENERATED_RESUME_CHANGES = new Set([
  `${PAPER_RUN_DIR}/${STATE_FILES.run}`,
  `${PAPER_RUN_DIR}/${STATE_FILES.stageHistory}`,
]);

/** Verify Git provenance and align mutable state with the checkpoint at HEAD. */
export async function prepareRunResume(projectDir: string): Promise<RunState> {
  const state = readRunState(projectDir);
  const branch = await getCurrentBranch(projectDir);
  if (branch !== state.run_branch) {
    throw new PaperRunError(`Run ${state.run_id} belongs to branch ${state.run_branch}, not ${branch || "detached HEAD"}.`, {
      hint: `Switch to ${state.run_branch} without discarding any work, then retry.`,
    });
  }

  const head = await verifyHeadConsistency(state, projectDir);
  if (!head.consistent) {
    const detail = head.checkpointSha
      ? `latest checkpoint ${head.checkpointSha.slice(0, 8)} is not HEAD ${head.headSha.slice(0, 8)}`
      : `HEAD ${head.headSha.slice(0, 8)} is not a valid checkpoint for this run`;
    throw new PaperRunError(`Cannot resume safely: ${detail}.`, {
      hint: "Run `paper-run checkpoint` to mark the current committed point, or return to the run checkpoint without resetting or discarding work.",
    });
  }

  const dirty = await checkDirtyState(projectDir);
  const changed = [...new Set([...dirty.stagedFiles, ...dirty.unstagedFiles, ...dirty.untrackedFiles])];
  const paperModeOnly = changed.includes("PAPER.md")
    ? await isPaperModeOnlyChange(projectDir, state.mode)
    : false;
  const gatePolicyModeOnly = changed.includes(`${PAPER_RUN_DIR}/${STATE_FILES.gatePolicy}`)
    ? await isGatePolicyModeOnlyChange(projectDir, state.mode)
    : false;
  const unsafe = changed.filter(
    (file) =>
      !GENERATED_RESUME_CHANGES.has(file) &&
      !(file === "PAPER.md" && paperModeOnly) &&
      !(file === `${PAPER_RUN_DIR}/${STATE_FILES.gatePolicy}` && gatePolicyModeOnly),
  );
  if (unsafe.length > 0) {
    throw new PaperRunError(`Cannot resume with uncheckpointed project changes:\n${unsafe.map((file) => `  ${file}`).join("\n")}`, {
      hint: "Preserve intended work with `git add <files>` followed by `paper-run checkpoint`; otherwise commit it separately. Paper-Run will not stage it automatically on resume.",
    });
  }

  const checkpoint = await findLastCheckpoint(projectDir, state.run_id);
  if (!checkpoint) throw new PaperRunError(`No checkpoint found for run ${state.run_id}.`);
  return reconcileCheckpoint(projectDir, state, checkpoint);
}

async function isPaperModeOnlyChange(projectDir: string, mode: RunState["mode"]): Promise<boolean> {
  try {
    const { stdout: baseline } = await execa("git", ["show", "HEAD:PAPER.md"], {
      cwd: projectDir,
      stripFinalNewline: false,
    });
    const candidate = readFileSync(join(projectDir, "PAPER.md"), "utf-8");
    return replacePaperMode(baseline, mode) === candidate;
  } catch {
    return false;
  }
}

async function isGatePolicyModeOnlyChange(
  projectDir: string,
  mode: RunState["mode"],
): Promise<boolean> {
  try {
    const path = `${PAPER_RUN_DIR}/${STATE_FILES.gatePolicy}`;
    const { stdout: baseline } = await execa("git", ["show", `HEAD:${path}`], {
      cwd: projectDir,
    });
    const headPolicy = GatePolicySchema.parse(JSON.parse(baseline));
    const candidate: unknown = JSON.parse(readFileSync(join(projectDir, path), "utf-8"));
    return isDeepStrictEqual(candidate, switchGatePreset(headPolicy, mode));
  } catch {
    return false;
  }
}

export interface CheckpointOptions {
  authorizeLockedChange?: string;
}

export async function checkpointCommand(opts: CheckpointOptions = {}): Promise<void> {
  const projectDir = requireProjectRoot();
  const state = readRunState(projectDir);
  const branch = await getCurrentBranch(projectDir);
  if (branch !== state.run_branch) {
    throw new PaperRunError(`Run ${state.run_id} belongs to branch ${state.run_branch}, not ${branch || "detached HEAD"}.`, {
      hint: `Switch to ${state.run_branch} without discarding any work, then retry.`,
    });
  }

  const dirty = await checkDirtyState(projectDir);
  const unstaged = [...new Set([...dirty.unstagedFiles, ...dirty.untrackedFiles])];
  if (unstaged.length > 0) {
    throw new PaperRunError(`Manual checkpoint refused unstaged changes:\n${unstaged.map((file) => `  ${file}`).join("\n")}`, {
      hint: "Review and explicitly stage every file to include with `git add <files>`. Nothing was staged or committed.",
    });
  }

  const locked = await checkStagedLockedContracts(projectDir);
  let lockedAuthorization: string | undefined;
  if (opts.authorizeLockedChange !== undefined) {
    let authorization;
    try {
      authorization = parseLockedContractAuthorization(opts.authorizeLockedChange);
    } catch (err) {
      throw new PaperRunError(err instanceof Error ? err.message : String(err));
    }
    if (locked.passed) {
      throw new PaperRunError("Locked-change authorization was supplied, but the staged contracts contain no locked change.");
    }
    if (!authorizesLockedContract(locked, authorization)) {
      throw new PaperRunError(
        "Locked-change authorization does not match the current HEAD and staged contract candidate.",
        { hint: formatLockedContractFailure(locked) },
      );
    }
    lockedAuthorization = opts.authorizeLockedChange;
  } else if (!locked.passed) {
    throw new PaperRunError(`Manual checkpoint refused: ${formatLockedContractFailure(locked)}`, {
      hint: "Restore the staged locked commitments, or review the exact bound authorization command above.",
    });
  }

  const sha = await commitCheckpoint({
    stageId: state.current_stage,
    status: "pending",
    runId: state.run_id,
    mode: state.mode,
    templateVersion: state.template_version,
    kind: "manual",
    stageAll: false,
    ...(state.session_id ? { sessionId: state.session_id } : {}),
    ...(state.material_hash ? { materialHash: state.material_hash } : {}),
    ...(lockedAuthorization ? { lockedAuthorization } : {}),
  }, projectDir);
  if (lockedAuthorization) log.warn("Checkpoint includes an explicit digest-bound locked-contract authorization.");
  log.success(`Manual checkpoint created (${sha.slice(0, 8)}).`);
}

function reconcileCheckpoint(
  projectDir: string,
  state: RunState,
  checkpoint: Awaited<ReturnType<typeof findLastCheckpoint>> & {},
): RunState {
  const stageId = checkpoint.trailers["Paper-Run-Stage"]!;
  getStage(stageId);
  const status = checkpoint.trailers["Paper-Run-Status"] as RunState["stage_status"];
  const manual = checkpoint.trailers["Paper-Run-Kind"] === "manual";
  const terminal = !manual && (status === "completed" || status === "blocked");
  const stageStatus: RunState["stage_status"] =
    !manual && (status === "completed" || status === "blocked" || status === "gate_waiting")
      ? status
      : "pending";
  const checkpointMode = checkpoint.trailers["Paper-Run-Mode"] as RunState["mode"];

  reconcileHistory(projectDir, checkpoint.sha, stageId, terminal ? status : undefined);
  switchOperatingMode(projectDir, checkpointMode);
  return updateRunState(projectDir, {
    current_stage: stageId,
    stage_status: stageStatus,
    mode: checkpointMode,
    template_version: checkpoint.trailers["Paper-Run-Template"]!,
    session_id: checkpoint.trailers["Paper-Run-Session"],
    material_hash: checkpoint.trailers["Paper-Run-Material-Hash"],
    error: stageStatus === "blocked" && state.current_stage === stageId ? state.error : undefined,
  });
}

function reconcileHistory(
  projectDir: string,
  sha: string,
  checkpointStage: string,
  status: "completed" | "blocked" | undefined,
): void {
  let history: StageHistory;
  try {
    history = readStageHistory(projectDir);
  } catch {
    history = { schema_version: "paper-run-stage-history-v1", stages: [] };
  }

  const limit = stageNumber(checkpointStage);
  const stages = history.stages.filter((record) => {
    const position = stageNumber(record.stage_id);
    return position < limit || (position === limit && status !== undefined);
  }).map((record) =>
    record.stage_id === checkpointStage && status
      ? { ...record, status, commit_sha: sha }
      : record,
  );
  if (status && !stages.some((record) => record.stage_id === checkpointStage)) {
    const timestamp = new Date().toISOString();
    const record: StageRecord = {
      stage_id: checkpointStage,
      status,
      started_at: timestamp,
      completed_at: timestamp,
      commit_sha: sha,
    };
    stages.push(record);
  }
  writeStageHistory(projectDir, { ...history, stages });
}
