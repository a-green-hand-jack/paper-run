/**
 * The pipeline controller.
 *
 * One loop, thirteen stages, and no special cases per stage:
 *
 *     run -> wait for idle -> validate -> gate -> checkpoint -> advance
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
 * anywhere in the loop, `.paper-run/run.json` plus the git log are enough to
 * work out where to pick up — an interrupted stage simply re-runs, which costs
 * a turn rather than losing work, because no checkpoint was committed for it.
 */

import type { OpencodeClient } from "@opencode-ai/sdk/v2";

import {
  readRunState,
  updateRunState,
  readStageHistory,
  writeStageHistory,
} from "../state/store.js";
import type { GatePolicy, StageHistory, StageRecord } from "../state/schema.js";

import { remainingStages, stageNumber, TOTAL_STAGES } from "../pipeline/stages.js";
import type { Stage } from "../pipeline/stages.js";
import { renderStagePrompt, renderRemediationPrompt } from "../pipeline/prompts.js";
import { validateStage } from "../pipeline/validators.js";
import type { ValidationResult } from "../pipeline/validators.js";
import {
  renderAssessmentPrompt,
  discoverMaterials,
  hasBrief,
  evaluateAssessment,
  formatBlockReport,
  isBlockedByUnusableMaterials,
} from "../pipeline/material-assessment.js";
import type { Verdict } from "../pipeline/material-assessment.js";

import { sendPrompt, abortSession, showToast } from "../opencode/session.js";
import { waitForIdle } from "../opencode/events.js";
import type { RelevantEvent } from "../opencode/events.js";

import { commitCheckpoint, tagCandidate } from "../utils/git.js";
import { StageTimeoutError, PaperRunError } from "../utils/errors.js";
import { log } from "../utils/logger.js";

import { evaluateGate } from "./gate.js";
import type { GateDecision } from "./gate.js";
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

  constructor(opts: ControllerOptions) {
    this.opts = opts;
    this.policy = opts.policy;
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

      const outcome = await this.runStage(stage);

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

      updateRunState(this.opts.projectDir, { stage_status: "validating" });
      validation = await validateStage(stage, this.opts.projectDir);

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
      const stop = await this.applyAssessment(stage, startedAt);
      if (stop) return stop;
    }

    // --- gate ---
    const decision = await this.gate(stage, validation!);

    if (decision.outcome === "stop") {
      await this.markBlocked(stage, decision.reason);
      return { status: "stopped", reason: decision.reason };
    }

    if (decision.outcome === "revise") {
      // The human wants changes: re-run this stage carrying their guidance.
      guidance = decision.guidance;
      log.step(`Revising "${stage.name}" per human guidance`);
      return this.rerunAfterRevision(stage, guidance);
    }

    // --- checkpoint ---
    const sha = await this.checkpoint(stage, "completed");
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

    const validation = await validateStage(stage, this.opts.projectDir);
    if (!validation.passed) {
      const reason = `validation failed after revision: ${validation.failures.join("; ")}`;
      await this.markBlocked(stage, reason);
      return { status: "stopped", reason };
    }

    const decision = await this.gate(stage, validation);

    if (decision.outcome === "stop") {
      await this.markBlocked(stage, decision.reason);
      return { status: "stopped", reason: decision.reason };
    }
    if (decision.outcome === "revise") {
      return this.rerunAfterRevision(stage, decision.guidance, depth + 1);
    }

    const sha = await this.checkpoint(stage, "completed");
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
    await sendPrompt(this.opts.client, {
      sessionId: this.opts.sessionId,
      text: prompt,
      directory: this.opts.projectDir,
      ...(this.opts.agent ? { agent: this.opts.agent } : {}),
    });

    await waitForIdle(this.opts.client, {
      sessionId: this.opts.sessionId,
      directory: this.opts.projectDir,
      timeoutMs: stage.timeoutMs,
      stageId: stage.id,
      ...(this.opts.signal ? { signal: this.opts.signal } : {}),
      onEvent: (event) => this.onEvent(event),
    });
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
    await handlePermissionRequest(this.opts.client, payload, {
      directory: this.opts.projectDir,
    });
  }

  private async gate(stage: Stage, validation: ValidationResult): Promise<GateDecision> {
    return evaluateGate(this.policy, {
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

  private async checkpoint(stage: Stage, status: "completed" | "blocked"): Promise<string> {
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
    await abortSession(this.opts.client, this.opts.sessionId, this.opts.projectDir);
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
