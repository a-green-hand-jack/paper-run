/**
 * The pipeline controller.
 *
 * One loop, thirteen stages, and no special cases per stage:
 *
 *     run -> wait for idle -> validate -> checkpoint waiting gates -> gate
 *         -> checkpoint completion -> advance
 *
 * Everything stage-specific lives in the stage table; everything mode-specific
 * lives in the gate policy. What is left here is the part that has to be right
 * regardless of either: knowing when a turn is actually over, refusing to take
 * the agent's word for completion, and leaving the repository in a state that
 * can be resumed after any interruption.
 *
 * ## Completion is observed, never claimed
 *
 * The controller does not read the agent's prose for a done signal. It waits
 * for `session.idle` on the event stream, then runs the harness validators
 * itself. A stage is complete when the repository says so.
 *
 * ## Every exit is resumable
 *
 * State is written before each risky step, not after it. If the process dies
 * anywhere in the loop, the checkpoint at HEAD is enough to work out where to
 * pick up. A validated stage waiting at a human gate resumes at that gate;
 * other interrupted stages re-run because no checkpoint was committed for them.
 */

import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import { isDeepStrictEqual } from "node:util";
import { execa } from "execa";

import {
  readRunState,
  readGatePolicy,
  updateRunState,
  withStateLock,
  readStageHistory,
  writeStageHistory,
} from "../state/store.js";
import { RunStateSchema, type GatePolicy, type StageHistory, type StageRecord } from "../state/schema.js";

import { remainingStages, stageNumber, TOTAL_STAGES } from "../pipeline/stages.js";
import type { Stage } from "../pipeline/stages.js";
import { renderStagePrompt, renderRemediationPrompt } from "../pipeline/prompts.js";
import { capturePublicationBaseline, validateStage } from "../pipeline/validators.js";
import type { PublicationBaseline, ValidationResult } from "../pipeline/validators.js";
import {
  captureLockedContractBaseline,
  checkLockedContracts,
  formatLockedContractFailure,
} from "../pipeline/locked-contract.js";
import type { LockedContractBaseline } from "../pipeline/locked-contract.js";
import {
  renderAssessmentPrompt,
  discoverMaterials,
  hasBrief,
  evaluateAssessment,
  formatBlockReport,
  isBlockedByUnusableMaterials,
} from "../pipeline/material-assessment.js";
import type { Verdict } from "../pipeline/material-assessment.js";

import {
  createSession,
  sendPrompt,
  abortSession,
  abortAndWaitForIdle,
  showToast,
} from "../opencode/session.js";
import { waitForIdle } from "../opencode/events.js";
import type { RelevantEvent } from "../opencode/events.js";

import { checkDirtyState, commitCheckpoint, tagCandidate } from "../utils/git.js";
import { StageTimeoutError, PaperRunError } from "../utils/errors.js";
import { log } from "../utils/logger.js";
import { PAPER_RUN_DIR, STATE_FILES } from "../utils/constants.js";

import { evaluateGate } from "./gate.js";
import { gateActionFor, type GateDecision, type ResolvedGate } from "./gate.js";
import { handlePermissionRequest } from "./permissions.js";
import type { PermissionAskedPayload } from "./permissions.js";

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export type PipelineResult =
  /** Every stage ran; a candidate tag was created. */
  | { status: "completed"; runId: string; tag: string }
  /** Stopped at a stage — blocked materials, failed validation, or a human. */
  | { status: "stopped"; stageId: string; reason: string }
  /** The process was asked to stop. State is safe to resume. */
  | { status: "interrupted"; stageId: string };

export interface ControllerOptions {
  client: OpencodeClient;
  sessionId: string;
  projectDir: string;
  policy: GatePolicy;
  /** Agent to address stage prompts to. Defaults to the project's primary. */
  agent?: string;
  /** Fully-qualified model override for stage prompts. */
  model?: string;
  /** Provider-specific reasoning variant for stage prompts. */
  variant?: string;
  /** No TUI is attached, so an unanswered permission must fail fast. */
  unattended?: boolean;
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

export class PipelineController {
  private readonly opts: ControllerOptions;
  private policy: GatePolicy;
  /** Verdict from the material assessment, once it has run. */
  private materialVerdict: Verdict | undefined;
  /** Session currently running a turn, so an interrupt reaches cold reviews too. */
  private activeSessionId: string;

  constructor(opts: ControllerOptions) {
    this.opts = opts;
    this.policy = opts.policy;
    this.activeSessionId = opts.sessionId;
  }

  /** Run the pipeline from wherever the recorded state left off. */
  async run(): Promise<PipelineResult> {
    const state = readRunState(this.opts.projectDir);
    this.materialVerdict = this.recoverVerdict();

    const stages = remainingStages(
      state.current_stage,
      state.stage_status === "completed" || state.stage_status === "approved",
    );

    if (stages.length === 0) {
      log.success("Pipeline already complete.");
      return { status: "completed", runId: state.run_id, tag: "" };
    }

    log.step(
      `Resuming at ${stages[0]!.name} (${stageNumber(stages[0]!.id)}/${TOTAL_STAGES})`,
    );

    for (const stage of stages) {
      if (this.aborted()) return { status: "interrupted", stageId: stage.id };

      // Unusable materials stop the run regardless of mode. This is checked
      // per stage rather than once, so a resume cannot walk past it either.
      if (isBlockedByUnusableMaterials(stage.id, this.materialVerdict)) {
        const reason = "materials were judged unusable";
        await this.markBlocked(stage, reason);
        return { status: "stopped", stageId: stage.id, reason };
      }

      const outcome =
        stage.id === state.current_stage && state.stage_status === "gate_waiting"
          ? await this.resumeAtGate(stage)
          : await this.runStage(stage);

      if (outcome.status === "interrupted") {
        return { status: "interrupted", stageId: stage.id };
      }
      if (outcome.status === "stopped") {
        return { status: "stopped", stageId: stage.id, reason: outcome.reason };
      }
    }

    return this.finish();
  }

  // -------------------------------------------------------------------------
  // One stage
  // -------------------------------------------------------------------------

  private async runStage(
    stage: Stage,
  ): Promise<{ status: "advanced" } | { status: "stopped"; reason: string } | { status: "interrupted" }> {
    log.step(`Stage ${stageNumber(stage.id)}/${TOTAL_STAGES}: ${stage.name}`);

    updateRunState(this.opts.projectDir, {
      current_stage: stage.id,
      stage_status: "running",
    });

    const startedAt = new Date().toISOString();
    let contractBaseline: LockedContractBaseline;
    let publicationBaseline: PublicationBaseline | undefined;
    try {
      contractBaseline = await captureLockedContractBaseline(this.opts.projectDir);
      if (stage.id === "publication_build") {
        publicationBaseline = capturePublicationBaseline(this.opts.projectDir);
      }
    } catch (err) {
      const reason = `stage baseline unavailable at HEAD: ${describeError(err)}`;
      await this.markBlocked(stage, reason);
      return { status: "stopped", reason };
    }

    // --- the agent's turn, plus any remediation rounds ---
    let validation: ValidationResult;
    let attempt = 0;
    let guidance: string | undefined;

    for (;;) {
      if (this.aborted()) return { status: "interrupted" };

      const prompt =
        attempt === 0
          ? this.buildStagePrompt(stage, guidance)
          : renderRemediationPrompt(stage, {
              mode: this.policy.mode,
              history: this.history().stages,
              validationFailures: validation!.failures,
            });

      try {
        await this.takeTurn(stage, prompt);
      } catch (err) {
        if (err instanceof StageTimeoutError) {
          // A timed-out stage has no checkpoint, so leaving it pending means a
          // resume simply re-runs it.
          updateRunState(this.opts.projectDir, { stage_status: "pending" });
          return { status: "stopped", reason: `stage timed out after ${stage.timeoutMs / 60000}min` };
        }
        if (this.aborted()) return { status: "interrupted" };
        throw err;
      }

      if (this.aborted()) return { status: "interrupted" };

      const contractStop = await this.enforceLockedContracts(stage, contractBaseline);
      if (contractStop) return contractStop;

      updateRunState(this.opts.projectDir, { stage_status: "validating" });
      validation = await validateStage(stage, this.opts.projectDir, { publicationBaseline });

      if (validation.passed) break;

      attempt += 1;
      if (attempt > stage.retries) {
        const reason = `validation failed after ${stage.retries} remediation attempt(s): ${validation.failures.join("; ")}`;
        await this.markBlocked(stage, reason);
        return { status: "stopped", reason };
      }

      log.warn(
        `Validation failed (attempt ${attempt}/${stage.retries}): ${validation.failures.join("; ")}`,
      );
    }

    // --- stage-specific post-processing ---
    if (stage.id === "material_assessment") {
      const stop = await this.applyAssessment(stage, startedAt, contractBaseline);
      if (stop) return stop;
    }

    // --- gate ---
    const gateBoundary = await this.resolveGateBoundary(stage, contractBaseline);
    if (gateBoundary.stop) return gateBoundary.stop;
    const decision = await this.gate(stage, validation!, gateBoundary.resolved);

    if (decision.outcome === "stop") {
      await this.markBlocked(stage, decision.reason);
      return { status: "stopped", reason: decision.reason };
    }

    if (decision.outcome === "revise") {
      // The human wants changes: re-run this stage carrying their guidance.
      guidance = decision.guidance;
      log.step(`Revising "${stage.name}" per human guidance`);
      return this.rerunAfterRevision(stage, guidance, contractBaseline, publicationBaseline);
    }

    // --- checkpoint ---
    const contractStop = await this.enforceLockedContracts(stage, contractBaseline);
    if (contractStop) return contractStop;
    if (gateBoundary.resolved.action === "await_human") {
      const mutationStop = await this.enforceNoPostGateMutation(stage);
      if (mutationStop) return mutationStop;
    }
    const sha = await this.checkpoint(
      stage,
      "completed",
      gateBoundary.resolved.action === "await_human",
    );
    this.recordStage(stage, {
      status: "completed",
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      commit_sha: sha,
      validation_result: { passed: true, checks: validation!.checks.map(toRecordCheck) },
      ...(stage.id === "material_assessment" && this.materialVerdict
        ? { material_verdict: this.materialVerdict }
        : {}),
    });

    updateRunState(this.opts.projectDir, { stage_status: "completed" });
    log.success(`${stage.name} complete (${sha.slice(0, 8)})`);

    return { status: "advanced" };
  }

  /**
   * Re-run a stage after the human asked for changes.
   *
   * Bounded: a gate that keeps returning "revise" would otherwise loop
   * forever. After the limit the run stops and says why, rather than
   * silently continuing to burn turns.
   */
  private async rerunAfterRevision(
    stage: Stage,
    guidance: string | undefined,
    contractBaseline: LockedContractBaseline,
    publicationBaseline?: PublicationBaseline,
    depth = 1,
  ): Promise<{ status: "advanced" } | { status: "stopped"; reason: string } | { status: "interrupted" }> {
    const MAX_REVISIONS = 3;
    if (depth > MAX_REVISIONS) {
      const reason = `stage revised ${MAX_REVISIONS} times without approval`;
      await this.markBlocked(stage, reason);
      return { status: "stopped", reason };
    }

    if (this.aborted()) return { status: "interrupted" };

    updateRunState(this.opts.projectDir, { stage_status: "running" });
    const startedAt = new Date().toISOString();

    try {
      await this.takeTurn(stage, this.buildStagePrompt(stage, guidance));
    } catch (err) {
      if (err instanceof StageTimeoutError) {
        updateRunState(this.opts.projectDir, { stage_status: "pending" });
        return { status: "stopped", reason: "stage timed out during revision" };
      }
      if (this.aborted()) return { status: "interrupted" };
      throw err;
    }

    const contractStop = await this.enforceLockedContracts(stage, contractBaseline);
    if (contractStop) return contractStop;

    const validation = await validateStage(stage, this.opts.projectDir, { publicationBaseline });
    if (!validation.passed) {
      const reason = `validation failed after revision: ${validation.failures.join("; ")}`;
      await this.markBlocked(stage, reason);
      return { status: "stopped", reason };
    }

    const gateBoundary = await this.resolveGateBoundary(stage, contractBaseline, true);
    if (gateBoundary.stop) return gateBoundary.stop;
    const decision = await this.gate(stage, validation, gateBoundary.resolved);

    if (decision.outcome === "stop") {
      await this.markBlocked(stage, decision.reason);
      return { status: "stopped", reason: decision.reason };
    }
    if (decision.outcome === "revise") {
      return this.rerunAfterRevision(
        stage,
        decision.guidance,
        contractBaseline,
        publicationBaseline,
        depth + 1,
      );
    }

    const contractStopBeforeCheckpoint = await this.enforceLockedContracts(stage, contractBaseline);
    if (contractStopBeforeCheckpoint) return contractStopBeforeCheckpoint;
    const mutationStop = await this.enforceNoPostGateMutation(stage);
    if (mutationStop) return mutationStop;

    const sha = await this.checkpoint(stage, "completed", true);
    this.recordStage(stage, {
      status: "completed",
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      commit_sha: sha,
      validation_result: { passed: true, checks: validation.checks.map(toRecordCheck) },
    });
    updateRunState(this.opts.projectDir, { stage_status: "completed" });
    log.success(`${stage.name} complete after revision (${sha.slice(0, 8)})`);

    return { status: "advanced" };
  }

  // -------------------------------------------------------------------------
  // Pieces
  // -------------------------------------------------------------------------

  /**
   * Resume a validated output committed at a human gate without asking the
   * writer to produce the stage again. HEAD is both the output and contract
   * baseline; mutable run state and history are not evidence of advancement.
   */
  private async resumeAtGate(
    stage: Stage,
  ): Promise<{ status: "advanced" } | { status: "stopped"; reason: string } | { status: "interrupted" }> {
    log.step(`Revalidating checkpoint before gate at "${stage.name}"`);
    const startedAt = new Date().toISOString();
    let contractBaseline: LockedContractBaseline;
    try {
      contractBaseline = await captureLockedContractBaseline(this.opts.projectDir);
    } catch (err) {
      const reason = `locked-contract baseline unavailable at HEAD: ${describeError(err)}`;
      await this.markBlocked(stage, reason);
      return { status: "stopped", reason };
    }

    updateRunState(this.opts.projectDir, { stage_status: "validating" });
    const validation = await validateStage(stage, this.opts.projectDir);
    if (!validation.passed) {
      const reason = `checkpoint validation failed on resume: ${validation.failures.join("; ")}`;
      await this.markBlocked(stage, reason);
      return { status: "stopped", reason };
    }

    const contractStop = await this.enforceLockedContracts(stage, contractBaseline);
    if (contractStop) return contractStop;
    if (this.aborted()) return { status: "interrupted" };

    // A gate_waiting checkpoint is authoritative. A later mode switch may
    // affect future gates, but can never release this one.
    const gateBoundary = await this.resolveGateBoundary(stage, contractBaseline, true, false);
    if (gateBoundary.stop) return gateBoundary.stop;
    const decision = await this.gate(stage, validation, gateBoundary.resolved);
    if (decision.outcome === "stop") {
      await this.markBlocked(stage, decision.reason);
      return { status: "stopped", reason: decision.reason };
    }
    if (decision.outcome === "revise") {
      log.step(`Revising "${stage.name}" per human guidance`);
      return this.rerunAfterRevision(stage, decision.guidance, contractBaseline);
    }

    const contractStopBeforeCheckpoint = await this.enforceLockedContracts(stage, contractBaseline);
    if (contractStopBeforeCheckpoint) return contractStopBeforeCheckpoint;
    const mutationStop = await this.enforceNoPostGateMutation(stage);
    if (mutationStop) return mutationStop;
    const sha = await this.checkpoint(stage, "completed", true);
    this.recordStage(stage, {
      status: "completed",
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      commit_sha: sha,
      validation_result: { passed: true, checks: validation.checks.map(toRecordCheck) },
      ...(stage.id === "material_assessment" && this.materialVerdict
        ? { material_verdict: this.materialVerdict }
        : {}),
    });
    updateRunState(this.opts.projectDir, { stage_status: "completed" });
    log.success(`${stage.name} complete (${sha.slice(0, 8)})`);
    return { status: "advanced" };
  }

  /** Resolve policy/action once, checkpointing before an await_human gate. */
  private async resolveGateBoundary(
    stage: Stage,
    contractBaseline: LockedContractBaseline,
    forceHuman = false,
    checkpoint = true,
  ): Promise<{
    resolved: ResolvedGate;
    stop: { status: "stopped"; reason: string } | null;
  }> {
    const contractStop = await this.enforceLockedContracts(stage, contractBaseline);
    if (contractStop) {
      const policy = readGatePolicy(this.opts.projectDir);
      return {
        resolved: { policy, action: gateActionFor(policy, stage.id) },
        stop: contractStop,
      };
    }

    const resolved = await withStateLock(this.opts.projectDir, async (store) => {
      const current = readGatePolicy(this.opts.projectDir);
      const policy = forceHuman
        ? {
            ...current,
            gates: { ...current.gates, [stage.id]: { policy: "await_human" as const } },
          }
        : current;
      const boundary: ResolvedGate = { policy, action: gateActionFor(policy, stage.id) };

      if (boundary.action === "await_human") {
        store.updateRunState({ stage_status: "gate_waiting" });
        if (checkpoint) await this.checkpoint(stage, "gate_waiting");
      }
      return boundary;
    });
    this.policy = resolved.policy;
    return { resolved, stop: null };
  }

  private async enforceLockedContracts(
    stage: Stage,
    baseline: LockedContractBaseline,
  ): Promise<{ status: "stopped"; reason: string } | null> {
    const result = checkLockedContracts(this.opts.projectDir, baseline);
    if (result.passed) return null;

    const reason = formatLockedContractFailure(result);
    await this.markBlocked(stage, reason);
    return { status: "stopped", reason };
  }

  /** Refuse to sweep edits made after the validated waiting checkpoint. */
  private async enforceNoPostGateMutation(
    stage: Stage,
  ): Promise<{ status: "stopped"; reason: string } | null> {
    const dirty = await checkDirtyState(this.opts.projectDir);
    const runPath = `${PAPER_RUN_DIR}/${STATE_FILES.run}`;
    const changed = new Set([
      ...dirty.stagedFiles,
      ...dirty.unstagedFiles,
      ...dirty.untrackedFiles,
    ]);
    changed.delete(runPath);
    const runTransitionIsExact = await this.isExpectedPostGateRunTransition(runPath);
    if (changed.size === 0 && runTransitionIsExact) return null;

    if (!runTransitionIsExact) changed.add(runPath);

    const reason =
      "project changed after the validated gate checkpoint; refusing to commit without revalidation: " +
      [...changed].sort().join(", ");
    await this.markBlocked(stage, reason);
    return { status: "stopped", reason };
  }

  private async isExpectedPostGateRunTransition(path: string): Promise<boolean> {
    try {
      const { stdout } = await execa("git", ["show", `HEAD:${path}`], {
        cwd: this.opts.projectDir,
      });
      const baseline = RunStateSchema.parse(JSON.parse(stdout));
      const current = readRunState(this.opts.projectDir);
      if (baseline.stage_status !== "gate_waiting" || current.stage_status !== "approved") return false;
      return isDeepStrictEqual(current, {
        ...baseline,
        stage_status: "approved",
        updated_at: current.updated_at,
      });
    } catch {
      return false;
    }
  }

  private buildStagePrompt(stage: Stage, guidance: string | undefined): string {
    if (stage.id === "material_assessment") {
      return renderAssessmentPrompt({
        materialFiles: discoverMaterials(this.opts.projectDir),
        briefPresent: hasBrief(this.opts.projectDir),
      });
    }

    return renderStagePrompt(stage, {
      mode: this.policy.mode,
      history: this.history().stages,
      ...(this.materialVerdict ? { materialVerdict: this.materialVerdict } : {}),
      ...(guidance ? { humanGuidance: guidance } : {}),
    });
  }

  /** Send a prompt and wait for the agent to finish, answering permissions meanwhile. */
  private async takeTurn(stage: Stage, prompt: string): Promise<void> {
    const review = stage.id === "independent_review";
    const sessionId = review
      ? await createSession(this.opts.client, {
          title: `paper-run independent review: ${stage.id}`,
          directory: this.opts.projectDir,
        })
      : this.opts.sessionId;
    this.activeSessionId = sessionId;

    try {
      await sendPrompt(this.opts.client, {
        sessionId,
        text: prompt,
        directory: this.opts.projectDir,
        ...(review ? { agent: "paper-reviewer" } : this.opts.agent ? { agent: this.opts.agent } : {}),
        ...(this.opts.model ? { model: this.opts.model } : {}),
        ...(this.opts.variant ? { variant: this.opts.variant } : {}),
      });

      await waitForIdle(this.opts.client, {
        sessionId,
        directory: this.opts.projectDir,
        timeoutMs: stage.timeoutMs,
        stageId: stage.id,
        ...(this.opts.signal ? { signal: this.opts.signal } : {}),
        onEvent: (event) => this.onEvent(event),
      });
    } finally {
      this.activeSessionId = this.opts.sessionId;
    }
  }

  /**
   * React to events seen while a stage runs.
   *
   * Permission requests are the only thing acted on: an unattended run that
   * blocks on a validator prompt is a run that never finishes.
   */
  private async onEvent(event: RelevantEvent): Promise<void> {
    if (event.kind !== "permission") return;

    const payload = event.raw as PermissionAskedPayload;
    const approved = await handlePermissionRequest(this.opts.client, payload, {
      directory: this.opts.projectDir,
    });
    if (!approved && this.opts.unattended) {
      updateRunState(this.opts.projectDir, { stage_status: "pending" });
      const childSessionId = payload.sessionID && payload.sessionID !== this.activeSessionId
        ? payload.sessionID
        : undefined;
      const source = childSessionId
        ? " requested by a child session"
        : "";
      const sessions = childSessionId
        ? [childSessionId, this.activeSessionId]
        : [this.activeSessionId];
      for (const sessionId of sessions) {
        try {
          await abortAndWaitForIdle(this.opts.client, sessionId, this.opts.projectDir);
        } catch (err) {
          log.warn(`Permission cleanup for session ${sessionId} did not settle: ${String(err)}`);
        }
      }
      throw new PaperRunError(
        `Headless run requires approval for the ${payload.permission} permission${source}.`,
        { hint: "Add a narrow project permission rule, or rerun without --headless and approve it in the TUI." },
      );
    }
  }

  private async gate(
    stage: Stage,
    validation: ValidationResult,
    resolved: ResolvedGate,
  ): Promise<GateDecision> {
    return evaluateGate(resolved, {
      client: this.opts.client,
      sessionId: this.opts.sessionId,
      projectDir: this.opts.projectDir,
      stageId: stage.id,
      summary: summarizeValidation(validation),
      ...(this.opts.signal ? { signal: this.opts.signal } : {}),
    });
  }

  /**
   * Apply the material assessment's verdict.
   *
   * Returns a stop when the materials cannot support a paper. This runs before
   * the gate, so an unusable verdict halts even in autonomous mode where the
   * gate would have waved the stage through.
   */
  private async applyAssessment(
    stage: Stage,
    startedAt: string,
    contractBaseline: LockedContractBaseline,
  ): Promise<{ status: "stopped"; reason: string } | null> {
    const outcome = evaluateAssessment(this.opts.projectDir);
    this.materialVerdict = outcome.verdict;

    if (outcome.downgradedFrom && outcome.verdict) {
      await showToast(this.opts.client, {
        message: `paper-run: material verdict corrected from "${outcome.downgradedFrom}" to "${outcome.verdict}"`,
        variant: "warning",
        directory: this.opts.projectDir,
      });
    }

    if (!outcome.blocked) {
      if (outcome.verdict === "partial") {
        log.warn("Materials are partial — unsupported claims will be carried as TODOs.");
      }
      return null;
    }

    const report = outcome.assessment
      ? formatBlockReport(outcome.assessment)
      : (outcome.reason ?? "materials are unusable");

    log.blank();
    log.error(report);
    log.blank();

    await showToast(this.opts.client, {
      message: "paper-run: materials are unusable — writing did not begin",
      variant: "error",
      directory: this.opts.projectDir,
    });

    // Checkpoint the assessment itself: the judgement is part of the record
    // even though no manuscript work followed it.
    const contractStop = await this.enforceLockedContracts(stage, contractBaseline);
    if (contractStop) return contractStop;
    const sha = await this.checkpoint(stage, "blocked");
    this.recordStage(stage, {
      status: "blocked",
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      commit_sha: sha,
      material_verdict: "unusable",
    });

    updateRunState(this.opts.projectDir, {
      stage_status: "blocked",
      error: {
        stage: stage.id,
        message: outcome.reason ?? "materials are unusable",
        at: new Date().toISOString(),
      },
    });

    return { status: "stopped", reason: outcome.reason ?? "materials are unusable" };
  }

  private async checkpoint(
    stage: Stage,
    status: "completed" | "blocked" | "gate_waiting",
    postHumanGate = false,
  ): Promise<string> {
    const state = readRunState(this.opts.projectDir);

    return commitCheckpoint(
      {
        stageId: stage.id,
        status,
        runId: state.run_id,
        mode: state.mode,
        templateVersion: state.template_version,
        ...(state.session_id ? { sessionId: state.session_id } : {}),
        ...(state.material_hash ? { materialHash: state.material_hash } : {}),
        ...(postHumanGate
          ? {
              stageAll: false,
              stagePaths: [`${PAPER_RUN_DIR}/${STATE_FILES.run}`],
            }
          : {}),
      },
      this.opts.projectDir,
    );
  }

  private async markBlocked(stage: Stage, reason: string): Promise<void> {
    log.error(`Blocked at "${stage.name}": ${reason}`);

    updateRunState(this.opts.projectDir, {
      stage_status: "blocked",
      error: { stage: stage.id, message: reason, at: new Date().toISOString() },
    });

    await showToast(this.opts.client, {
      message: `paper-run: blocked at "${stage.name}"`,
      variant: "error",
      directory: this.opts.projectDir,
    });
  }

  private async finish(): Promise<PipelineResult> {
    const state = readRunState(this.opts.projectDir);

    let tag = "";
    try {
      tag = await tagCandidate(state.run_id, this.opts.projectDir);
    } catch (err) {
      // A duplicate tag on a re-run is not worth failing the pipeline over.
      log.warn(`Could not tag candidate: ${err instanceof Error ? err.message : String(err)}`);
    }

    updateRunState(this.opts.projectDir, { stage_status: "completed" });

    await showToast(this.opts.client, {
      message: "paper-run: paper candidate ready for review",
      variant: "success",
      directory: this.opts.projectDir,
    });

    log.blank();
    log.success("Paper candidate complete.");
    if (tag) log.info(`  Tagged ${tag}`);
    log.info("  Review the candidate before treating it as submission-ready.");

    return { status: "completed", runId: state.run_id, tag };
  }

  // -------------------------------------------------------------------------
  // State helpers
  // -------------------------------------------------------------------------

  private history(): StageHistory {
    try {
      return readStageHistory(this.opts.projectDir);
    } catch {
      return { schema_version: "paper-run-stage-history-v1", stages: [] };
    }
  }

  private recordStage(stage: Stage, record: Omit<StageRecord, "stage_id">): void {
    const history = this.history();
    // Replace any earlier record for this stage: a re-run supersedes it.
    const stages = history.stages.filter((s) => s.stage_id !== stage.id);
    stages.push({ stage_id: stage.id, ...record });
    writeStageHistory(this.opts.projectDir, { ...history, stages });
  }

  /** Recover the material verdict from history when resuming a run. */
  private recoverVerdict(): Verdict | undefined {
    const record = this.history().stages.find((s) => s.stage_id === "material_assessment");
    if (record?.material_verdict) return record.material_verdict;

    // History may predate the record; fall back to the assessment file.
    const outcome = evaluateAssessment(this.opts.projectDir);
    return outcome.verdict;
  }

  private aborted(): boolean {
    return this.opts.signal?.aborted ?? false;
  }

  /** Stop the agent mid-turn. Used on the interrupt path. */
  async abort(): Promise<void> {
    await abortSession(this.opts.client, this.activeSessionId, this.opts.projectDir);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toRecordCheck(check: {
  name: string;
  passed: boolean;
  message?: string;
}): { name: string; passed: boolean; message?: string } {
  return check.message !== undefined
    ? { name: check.name, passed: check.passed, message: check.message }
    : { name: check.name, passed: check.passed };
}

/** One line per failed check, for the gate's summary. */
function summarizeValidation(validation: ValidationResult): string {
  const failed = validation.checks.filter((c) => !c.passed);
  if (failed.length === 0) return "All checks passed.";
  return [
    "All required checks passed. Advisory checks still reporting:",
    ...failed.map((c) => `  - ${c.name}`),
  ].join("\n");
}

/** Narrow an unknown error for reporting. */
export function describeError(err: unknown): string {
  if (err instanceof PaperRunError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}
