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
  readPerformance,
  writePerformance,
} from "../state/store.js";
import {
  RunStateSchema,
  type GatePolicy,
  type RunState,
  type StageHistory,
  type StageRecord,
} from "../state/schema.js";
import { planStages } from "../state/plans.js";
import { resolveStageTimeoutMultiplier } from "../state/timeout.js";

import { remainingStages, stageNumber, TOTAL_STAGES } from "../pipeline/stages.js";
import type { Stage } from "../pipeline/stages.js";
import { renderStagePrompt, renderRemediationPrompt } from "../pipeline/prompts.js";
import {
  buildPublicationArtifacts,
  capturePublicationBaseline,
  validateStage,
} from "../pipeline/validators.js";
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
  getSessionUsage,
} from "../opencode/session.js";
import type { SessionUsageSnapshot } from "../opencode/session.js";
import { waitForIdle } from "../opencode/events.js";
import type { RelevantEvent } from "../opencode/events.js";

import {
  checkDirtyState,
  commitCheckpoint,
  tagCandidate,
  worktreeFileDigest,
} from "../utils/git.js";
import { StageTimeoutError, PaperRunError } from "../utils/errors.js";
import { log } from "../utils/logger.js";
import { PAPER_RUN_DIR, STATE_FILES } from "../utils/constants.js";

import { evaluateGate } from "./gate.js";
import { gateActionFor, type GateDecision, type ResolvedGate } from "./gate.js";
import { commandFromPayload, handlePermissionRequest } from "./permissions.js";
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
  /** Run-wide multiplier applied to declarative stage timeout budgets. */
  stageTimeoutMultiplier?: number;
  /** No TUI is attached, so an unanswered permission must fail fast. */
  unattended?: boolean;
  signal?: AbortSignal;
}

interface TurnTelemetry {
  sessionId: string;
  startedAt: string;
  completedAt: string;
  turnMs: number;
  validatorMs?: number;
  usage: SessionUsageSnapshot;
  telemetryAvailable: boolean;
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
  /** Stage associated with the turn currently being driven. */
  private currentStageId = "unknown";
  private stageTimeoutMultiplier = 1;
  private turnTelemetry: TurnTelemetry | undefined;

  constructor(opts: ControllerOptions) {
    this.opts = opts;
    this.policy = opts.policy;
    this.activeSessionId = opts.sessionId;
  }

  /** Run the pipeline from wherever the recorded state left off. */
  async run(): Promise<PipelineResult> {
    let state = readRunState(this.opts.projectDir);
    this.stageTimeoutMultiplier = resolveStageTimeoutMultiplier(
      state.stage_timeout_multiplier,
      this.opts.stageTimeoutMultiplier,
    );
    if (state.stage_timeout_multiplier === undefined) {
      state = updateRunState(this.opts.projectDir, {
        stage_timeout_multiplier: this.stageTimeoutMultiplier,
      });
    }
    this.materialVerdict = this.recoverVerdict();

    const plannedStages = state.plan ? planStages(state.plan) : undefined;
    const stages = remainingStages(
      state.current_stage,
      state.stage_status === "completed" || state.stage_status === "approved",
    ).filter((stage) => plannedStages?.includes(stage.id) ?? true);

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

    return this.finish(Boolean(state.plan?.stages.includes("paper_candidate")));
  }


  // -------------------------------------------------------------------------
  // One stage
  // -------------------------------------------------------------------------

  private async runStage(
    stage: Stage,
  ): Promise<{ status: "advanced" } | { status: "stopped"; reason: string } | { status: "interrupted" }> {
    this.currentStageId = stage.id;
    log.step(`Stage ${stageNumber(stage.id)}/${TOTAL_STAGES}: ${stage.name}`);

    updateRunState(this.opts.projectDir, {
      current_stage: stage.id,
      stage_status: "running",
      error: undefined,
      timeout_recovery: undefined,
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
      if (this.aborted()) {
        this.recordPerformance(stage, {});
        return { status: "interrupted" };
      }

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
        this.recordPerformance(stage, {});
        if (err instanceof StageTimeoutError) {
          // A timed-out stage has no checkpoint, so leaving it pending means a
          // resume simply re-runs it.
          const reason = `stage timed out after ${this.stageTimeoutMs(stage) / 60000}min`;
          const timeoutRecovery = await this.captureTimeoutRecovery(stage);
          updateRunState(this.opts.projectDir, {
            stage_status: "pending",
            timeout_recovery: timeoutRecovery,
            error: { stage: stage.id, message: reason, at: new Date().toISOString() },
          });
          log.error(`${stage.name} ${reason}.`);
          log.hint("Resume this run to retry the stage with the recorded timeout configuration.");
          return {
            status: "stopped",
            reason,
          };
        }
        if (this.aborted()) return { status: "interrupted" };
        throw err;
      }

      if (this.aborted()) {
        this.recordPerformance(stage, {});
        return { status: "interrupted" };
      }

      const contractStop = await this.enforceLockedContracts(stage, contractBaseline);
      if (contractStop) {
        this.recordPerformance(stage, {});
        return contractStop;
      }

      updateRunState(this.opts.projectDir, { stage_status: "validating" });
      const validatorStartedAt = Date.now();
      validation = await this.validateStageAttempt(stage, publicationBaseline);
      const validatorMs = Date.now() - validatorStartedAt;
      if (this.aborted()) {
        this.recordPerformance(stage, { validatorMs });
        return { status: "interrupted" };
      }

      if (validation.passed) {
        if (this.turnTelemetry) this.turnTelemetry = { ...this.turnTelemetry, validatorMs };
        break;
      }
      this.recordPerformance(stage, { validatorMs });

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
      if (stop) {
        this.recordPerformance(stage, { validatorMs: this.turnTelemetry?.validatorMs });
        return stop;
      }
    }

    // --- gate ---
    const gateBoundary = await this.resolveGateBoundary(stage, contractBaseline);
    if (gateBoundary.stop) {
      this.recordPerformance(stage, { validatorMs: this.turnTelemetry?.validatorMs });
      return gateBoundary.stop;
    }
    const decision = await this.gate(stage, validation!, gateBoundary.resolved);

    if (decision.outcome === "stop") {
      this.recordPerformance(stage, { validatorMs: this.turnTelemetry?.validatorMs });
      await this.markBlocked(stage, decision.reason);
      return { status: "stopped", reason: decision.reason };
    }

    if (decision.outcome === "revise") {
      this.recordPerformance(stage, { validatorMs: this.turnTelemetry?.validatorMs });
      // The human wants changes: re-run this stage carrying their guidance.
      guidance = decision.guidance;
      log.step(`Revising "${stage.name}" per human guidance`);
      return this.rerunAfterRevision(stage, guidance, contractBaseline, publicationBaseline);
    }

    // --- checkpoint ---
    const contractStop = await this.enforceLockedContracts(stage, contractBaseline);
    if (contractStop) {
      this.recordPerformance(stage, {});
      return contractStop;
    }
    if (gateBoundary.resolved.action === "await_human") {
      const mutationStop = await this.enforceNoPostGateMutation(stage);
      if (mutationStop) {
        this.recordPerformance(stage, {});
        return mutationStop;
      }
    }
    const checkpointStartedAt = Date.now();
    let sha: string;
    try {
      sha = await this.checkpoint(
        stage,
        "completed",
        gateBoundary.resolved.action === "await_human",
      );
    } catch (error) {
      this.recordPerformance(stage, { checkpointMs: Date.now() - checkpointStartedAt });
      throw error;
    }
    this.recordPerformance(stage, { checkpointMs: Date.now() - checkpointStartedAt });
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

    if (this.aborted()) {
      return { status: "interrupted" };
    }

    updateRunState(this.opts.projectDir, { stage_status: "running" });
    const startedAt = new Date().toISOString();

    try {
      await this.takeTurn(stage, this.buildStagePrompt(stage, guidance));
    } catch (err) {
      this.recordPerformance(stage, {});
      if (err instanceof StageTimeoutError) {
        const reason = `stage timed out during revision after ${this.stageTimeoutMs(stage) / 60000}min`;
        const timeoutRecovery = await this.captureTimeoutRecovery(stage);
        updateRunState(this.opts.projectDir, {
          stage_status: "pending",
          timeout_recovery: timeoutRecovery,
          error: { stage: stage.id, message: reason, at: new Date().toISOString() },
        });
        log.error(`${stage.name} ${reason}.`);
        log.hint("Resume this run to retry the stage with the recorded timeout configuration.");
        return { status: "stopped", reason };
      }
      if (this.aborted()) return { status: "interrupted" };
      throw err;
    }

    const contractStop = await this.enforceLockedContracts(stage, contractBaseline);
    if (contractStop) {
      this.recordPerformance(stage, {});
      return contractStop;
    }

    const validatorStartedAt = Date.now();
    const validation = await this.validateStageAttempt(stage, publicationBaseline);
    const validatorMs = Date.now() - validatorStartedAt;
    if (this.aborted()) {
      this.recordPerformance(stage, { validatorMs });
      return { status: "interrupted" };
    }
    if (!validation.passed) {
      this.recordPerformance(stage, { validatorMs });
      const reason = `validation failed after revision: ${validation.failures.join("; ")}`;
      await this.markBlocked(stage, reason);
      return { status: "stopped", reason };
    }

    const gateBoundary = await this.resolveGateBoundary(stage, contractBaseline, true);
    if (gateBoundary.stop) {
      this.recordPerformance(stage, { validatorMs });
      return gateBoundary.stop;
    }
    const decision = await this.gate(stage, validation, gateBoundary.resolved);

    if (decision.outcome === "stop") {
      this.recordPerformance(stage, { validatorMs });
      await this.markBlocked(stage, decision.reason);
      return { status: "stopped", reason: decision.reason };
    }
    if (decision.outcome === "revise") {
      this.recordPerformance(stage, { validatorMs });
      return this.rerunAfterRevision(
        stage,
        decision.guidance,
        contractBaseline,
        publicationBaseline,
        depth + 1,
      );
    }

    const contractStopBeforeCheckpoint = await this.enforceLockedContracts(stage, contractBaseline);
    if (contractStopBeforeCheckpoint) {
      this.recordPerformance(stage, { validatorMs });
      return contractStopBeforeCheckpoint;
    }
    const mutationStop = await this.enforceNoPostGateMutation(stage);
    if (mutationStop) {
      this.recordPerformance(stage, { validatorMs });
      return mutationStop;
    }

    if (this.turnTelemetry) this.turnTelemetry = { ...this.turnTelemetry, validatorMs };
    const checkpointStartedAt = Date.now();
    let sha: string;
    try {
      sha = await this.checkpoint(stage, "completed", true);
    } catch (error) {
      this.recordPerformance(stage, { checkpointMs: Date.now() - checkpointStartedAt });
      throw error;
    }
    this.recordPerformance(stage, { checkpointMs: Date.now() - checkpointStartedAt });
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
    let publicationBaseline: PublicationBaseline | undefined;
    try {
      contractBaseline = await captureLockedContractBaseline(this.opts.projectDir);
      if (stage.id === "publication_build") {
        publicationBaseline = capturePublicationBaseline(this.opts.projectDir);
      }
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
      return this.rerunAfterRevision(
        stage,
        decision.guidance,
        contractBaseline,
        publicationBaseline,
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
        ...(baseline.stage_timeout_multiplier === undefined
          ? { stage_timeout_multiplier: current.stage_timeout_multiplier }
          : {}),
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
    this.currentStageId = stage.id;
    const review = stage.id === "independent_review";
    const sessionId = review
      ? await createSession(this.opts.client, {
          title: `paper-run independent review: ${stage.id}`,
          directory: this.opts.projectDir,
        })
      : this.opts.sessionId;
    this.activeSessionId = sessionId;
    const before = await getSessionUsage(this.opts.client, sessionId);
    const startedAt = Date.now();

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
        timeoutMs: this.stageTimeoutMs(stage),
        stageId: stage.id,
        ...(this.opts.signal ? { signal: this.opts.signal } : {}),
        onEvent: (event) => this.onEvent(event),
      });
    } catch (error) {
      if (error instanceof StageTimeoutError) {
        try {
          await abortAndWaitForIdle(this.opts.client, sessionId, this.opts.projectDir);
        } catch (cleanupError) {
          throw new PaperRunError(
            `${error.message} The OpenCode session did not settle after abort: ${describeError(cleanupError)}`,
            { hint: "Stop the OpenCode server before retrying so it cannot continue modifying the project." },
          );
        }
      }
      throw error;
    } finally {
      const after = await getSessionUsage(this.opts.client, sessionId);
      this.turnTelemetry = {
        sessionId,
        startedAt: new Date(startedAt).toISOString(),
        completedAt: new Date().toISOString(),
        turnMs: Date.now() - startedAt,
        usage: usageDelta(before, after),
        telemetryAvailable: before !== null && after !== null,
      };
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
      const command = commandFromPayload(payload);
      const patterns = Array.isArray(payload.patterns) ? JSON.stringify(payload.patterns) : "<unavailable>";
      const childSessionId = payload.sessionID && payload.sessionID !== this.activeSessionId
        ? payload.sessionID
        : undefined;
      const source = childSessionId
        ? " requested by a child session"
        : "";
      const diagnostic = [
        `Headless run requires approval for the ${payload.permission} permission${source}.`,
        `Stage: ${this.currentStageId}`,
        `Session: ${payload.sessionID || "<unknown>"}`,
        `Request: ${payload.id || "<unknown>"}`,
        `Command: ${JSON.stringify(command || "<unavailable>")}`,
        `Patterns: ${patterns}`,
      ].join("\n");
      updateRunState(this.opts.projectDir, {
        stage_status: "pending",
        error: { stage: this.currentStageId, message: diagnostic, at: new Date().toISOString() },
      });
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
        diagnostic,
        { hint: "Add a narrow project permission rule, or rerun without --headless and approve it in the TUI." },
      );
    }
  }

  private async validateStageAttempt(
    stage: Stage,
    publicationBaseline?: PublicationBaseline,
  ): Promise<ValidationResult> {
    const options = { publicationBaseline };
    if (stage.id !== "publication_build") {
      return validateStage(stage, this.opts.projectDir, options);
    }

    const preflight = await validateStage(stage, this.opts.projectDir, options);
    const prerequisiteFailures = preflight.checks.filter(
      (check) => check.required && !check.passed && check.name !== "publication-build",
    );
    if (prerequisiteFailures.length > 0) return preflight;

    const publicationBuild = await buildPublicationArtifacts(this.opts.projectDir, {
      ...(publicationBaseline ? { baseline: publicationBaseline } : {}),
      timeoutMs: this.stageTimeoutMs(stage),
      ...(this.opts.signal ? { signal: this.opts.signal } : {}),
    });
    if (this.aborted()) {
      return {
        passed: false,
        checks: [],
        failures: [publicationBuild.diagnostic || "publication build canceled"],
      };
    }
    const validation = await validateStage(stage, this.opts.projectDir, options);
    if (publicationBuild.passed) return validation;

    return {
      passed: false,
      checks: [
        ...validation.checks,
        {
          name: "publication-build-execution",
          passed: false,
          required: true,
          message: publicationBuild.diagnostic,
        },
      ],
      failures: [...validation.failures, publicationBuild.diagnostic],
    };
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
        stageTimeoutMultiplier:
          state.stage_timeout_multiplier ?? this.stageTimeoutMultiplier,
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

  private async finish(withCandidate: boolean): Promise<PipelineResult> {
    const state = readRunState(this.opts.projectDir);

    let tag = "";
    if (withCandidate) {
      try {
        tag = await tagCandidate(state.run_id, this.opts.projectDir);
      } catch (err) {
        // A duplicate tag on a re-run is not worth failing the pipeline over.
        log.warn(`Could not tag candidate: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    updateRunState(this.opts.projectDir, { stage_status: "completed" });

    await showToast(this.opts.client, {
      message: withCandidate ? "paper-run: paper candidate ready for review" : "paper-run: selected pipeline complete",
      variant: "success",
      directory: this.opts.projectDir,
    });

    log.blank();
    log.success(withCandidate ? "Paper candidate complete." : "Selected pipeline complete.");
    if (tag) log.info(`  Tagged ${tag}`);
    if (withCandidate) log.info("  Review the candidate before treating it as submission-ready.");

    return { status: "completed", runId: state.run_id, tag };
  }

  private stageTimeoutMs(stage: Stage): number {
    return Math.ceil(stage.timeoutMs * this.stageTimeoutMultiplier);
  }

  private async captureTimeoutRecovery(stage: Stage): Promise<RunState["timeout_recovery"]> {
    const dirty = await checkDirtyState(this.opts.projectDir);
    const generated = new Set([
      `${PAPER_RUN_DIR}/${STATE_FILES.run}`,
      `${PAPER_RUN_DIR}/${STATE_FILES.stageHistory}`,
    ]);
    const paths = [...new Set([
      ...dirty.stagedFiles,
      ...dirty.unstagedFiles,
      ...dirty.untrackedFiles,
    ])].filter((path) => !generated.has(path));
    return {
      stage: stage.id,
      files: Object.fromEntries(
        paths.map((path) => [path, worktreeFileDigest(this.opts.projectDir, path)]),
      ),
    };
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

  private recordPerformance(stage: Stage, timing: { validatorMs?: number; checkpointMs?: number }): void {
    const turn = this.turnTelemetry;
    if (!turn) return;
    const state = readRunState(this.opts.projectDir);
    let current;
    try {
      current = readPerformance(this.opts.projectDir);
    } catch {
      current = null;
      log.warn("Ignoring unreadable performance telemetry; starting a fresh record.");
    }
    const performance = current ?? {
      schema_version: "paper-run-performance-v1" as const,
      run_id: state.run_id,
      session_id: this.opts.sessionId,
      started_at: turn.startedAt,
      updated_at: turn.completedAt,
      attempts: [],
    };
    performance.updated_at = new Date().toISOString();
    performance.attempts.push({
      stage_id: stage.id,
      attempt: performance.attempts.filter((item) => item.stage_id === stage.id).length,
      session_id: turn.sessionId,
      started_at: turn.startedAt,
      completed_at: turn.completedAt,
      turn_ms: turn.turnMs,
      ...(timing.validatorMs ?? turn.validatorMs) !== undefined
        ? { validator_ms: timing.validatorMs ?? turn.validatorMs }
        : {},
      ...(timing.checkpointMs !== undefined ? { checkpoint_ms: timing.checkpointMs } : {}),
      usage: {
        model_calls: turn.usage.modelCalls,
        input_tokens: turn.usage.inputTokens,
        output_tokens: turn.usage.outputTokens,
        reasoning_tokens: turn.usage.reasoningTokens,
        cache_read_tokens: turn.usage.cacheReadTokens,
        cache_write_tokens: turn.usage.cacheWriteTokens,
        cost: turn.usage.cost,
      },
      ...(turn.usage.transcriptMessages !== undefined ? { transcript_messages: turn.usage.transcriptMessages } : {}),
      telemetry_available: turn.telemetryAvailable,
    });
    try {
      writePerformance(this.opts.projectDir, performance);
    } catch (error) {
      log.warn(`Could not persist performance telemetry: ${describeError(error)}`);
    }
    this.turnTelemetry = undefined;
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

function usageDelta(before: SessionUsageSnapshot | null, after: SessionUsageSnapshot | null): SessionUsageSnapshot {
  if (before === null || after === null) {
    return {
      modelCalls: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0,
      cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0,
      ...(after?.transcriptMessages !== undefined ? { transcriptMessages: after.transcriptMessages } : {}),
    };
  }
  const current = after ?? {
    modelCalls: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0,
    cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0,
  };
  const prior = before ?? {
    modelCalls: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0,
    cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0,
  };
  return {
    modelCalls: Math.max(0, current.modelCalls - prior.modelCalls),
    inputTokens: Math.max(0, current.inputTokens - prior.inputTokens),
    outputTokens: Math.max(0, current.outputTokens - prior.outputTokens),
    reasoningTokens: Math.max(0, current.reasoningTokens - prior.reasoningTokens),
    cacheReadTokens: Math.max(0, current.cacheReadTokens - prior.cacheReadTokens),
    cacheWriteTokens: Math.max(0, current.cacheWriteTokens - prior.cacheWriteTokens),
    cost: Math.max(0, current.cost - prior.cost),
    ...(current.transcriptMessages !== undefined ? { transcriptMessages: current.transcriptMessages } : {}),
  };
}

/** Narrow an unknown error for reporting. */
export function describeError(err: unknown): string {
  if (err instanceof PaperRunError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}
