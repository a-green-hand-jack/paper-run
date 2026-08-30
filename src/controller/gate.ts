/**
 * Gate evaluation — where the two operating modes actually differ.
 *
 * There is one pipeline. `autonomous` and `collaborative` are not separate code
 * paths; they are presets over a per-stage policy table, read here at the
 * boundary between stages:
 *
 *     run stage -> validate -> checkpoint waiting output -> GATE -> proceed
 *
 * That is what makes switching modes mid-run cheap: the mode is a value, not
 * control flow, so a change takes effect at the next gate without disturbing
 * the stage in flight.
 *
 * ## Two ways a gate opens
 *
 * A waiting gate can be released from either side, and both must work:
 *
 *  - The human answers the `question` picker in the TUI. The controller sees
 *    `question.replied` and reads the chosen label.
 *  - The human runs `/approve`, which writes `stage_status: "approved"` into
 *    `run.json`. The controller polls for that.
 *
 * Whichever happens first wins, and the other is cleaned up: an `/approve`
 * leaves a question dangling in the session, so we answer it ourselves to
 * unblock the agent.
 *
 * ## Hard stops outrank policy
 *
 * Unusable materials and locked-contract violations stop the run even in
 * autonomous mode. `evaluateGate` is only consulted for the ordinary case;
 * callers pass a hard stop in explicitly.
 */

import type { OpencodeClient } from "@opencode-ai/sdk/v2";

import { readRunState, updateRunState } from "../state/store.js";
import type { GatePolicy } from "../state/schema.js";
import { log } from "../utils/logger.js";
import {
  abortAndWaitForIdle,
  sendPrompt,
  showToast,
} from "../opencode/session.js";
import {
  listQuestions,
  replyToQuestion,
} from "../opencode/interaction.js";
import { subscribeEvents } from "../opencode/events.js";

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

/** What the controller should do once a gate resolves. */
export type GateDecision =
  /** Continue to the next stage. */
  | { outcome: "proceed"; reason: string }
  /** Redo the current stage — the human asked for changes. */
  | { outcome: "revise"; reason: string; guidance?: string }
  /** Stop the pipeline. */
  | { outcome: "stop"; reason: string };

/** The choices offered at a gate, in the order they appear in the picker. */
export const GATE_CHOICES = {
  approve: "Approve and continue",
  revise: "Request changes",
  stop: "Stop the run",
} as const;

/** Map a chosen label back to a decision. Unknown labels are treated as revise. */
export function decisionFromLabel(label: string): GateDecision {
  const normalized = label.trim().toLowerCase();

  if (normalized === GATE_CHOICES.approve.toLowerCase()) {
    return { outcome: "proceed", reason: "human approved" };
  }
  if (normalized === GATE_CHOICES.stop.toLowerCase()) {
    return { outcome: "stop", reason: "human stopped the run" };
  }
  if (normalized === GATE_CHOICES.revise.toLowerCase()) {
    return { outcome: "revise", reason: "human requested changes" };
  }

  // A custom answer is guidance, not approval: re-run the stage with it.
  return {
    outcome: "revise",
    reason: "human answered with guidance",
    guidance: label,
  };
}

// ---------------------------------------------------------------------------
// Policy lookup
// ---------------------------------------------------------------------------

export type GateAction = "auto" | "await_human" | "skip";

/** Immutable policy result captured once at the controller's gate boundary. */
export interface ResolvedGate {
  policy: GatePolicy;
  action: GateAction;
}

/**
 * The configured action for a stage.
 *
 * An unknown stage defaults to `await_human` rather than `auto`: a stage the
 * policy has never heard of is more likely a version skew than something safe
 * to wave through unattended.
 */
export function gateActionFor(policy: GatePolicy, stageId: string): GateAction {
  return policy.gates[stageId]?.policy ?? "await_human";
}

// ---------------------------------------------------------------------------
// Asking the human
// ---------------------------------------------------------------------------

/**
 * Ask the agent to put a gate question to the user.
 *
 * We do not fabricate a question request over the API — the `question` tool is
 * the agent's to call, and routing through it means the picker appears in the
 * TUI exactly as any other agent question would, in the same transcript the
 * user is already reading.
 */
function buildGatePrompt(stageId: string, summary?: string): string {
  const context = summary ? `\n\nWhat happened in this stage:\n${summary}` : "";

  return [
    `The pipeline has reached the gate after stage "${stageId}".${context}`,
    "",
    "Use the `question` tool to ask the user how to proceed. Use exactly these options, in this order:",
    `  1. "${GATE_CHOICES.approve}" — the stage output is acceptable; continue to the next stage.`,
    `  2. "${GATE_CHOICES.revise}" — something needs changing before continuing.`,
    `  3. "${GATE_CHOICES.stop}" — stop the run here.`,
    "",
    `Set the question header to "Gate: ${stageId}". Do not do any other work in this turn — ask, and wait.`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Gate evaluation
// ---------------------------------------------------------------------------

export interface GateContext {
  client: OpencodeClient;
  sessionId: string;
  projectDir: string;
  stageId: string;
  /** Short description of what the stage produced, shown to the human. */
  summary?: string;
  /** How often to check run.json for an `/approve`. */
  pollIntervalMs?: number;
  /** Give up waiting after this long. Defaults to no limit. */
  timeoutMs?: number;
  /** Maximum wait for the gate prompt to go idle after its question resolves. */
  settleTimeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Evaluate the gate for a stage and, when required, wait for a human.
 *
 * Returns as soon as the gate resolves by either route.
 */
export async function evaluateGate(
  resolved: ResolvedGate,
  ctx: GateContext,
): Promise<GateDecision> {
  const { action } = resolved;

  if (action === "auto" || action === "skip") {
    log.debug(`gate ${ctx.stageId}: ${action} -> proceed`);
    return { outcome: "proceed", reason: `gate policy is "${action}"` };
  }

  log.step(`Gate reached at "${ctx.stageId}" — waiting for approval`);

  await showToast(ctx.client, {
    message: `paper-run: waiting for approval at "${ctx.stageId}"`,
    variant: "warning",
    directory: ctx.projectDir,
  });

  await sendPrompt(ctx.client, {
    sessionId: ctx.sessionId,
    text: buildGatePrompt(ctx.stageId, ctx.summary),
    directory: ctx.projectDir,
  });

  const decision = await waitForGateRelease(ctx);

  // Record the live outcome. Until the completed checkpoint is committed, a
  // crash resumes from the gate_waiting checkpoint at HEAD and asks again.
  updateRunState(ctx.projectDir, {
    stage_status: decision.outcome === "proceed" ? "approved" : "gate_waiting",
  });

  log.debug(`gate ${ctx.stageId} resolved: ${decision.outcome} (${decision.reason})`);
  return decision;
}

/**
 * Wait for either route to open the gate.
 *
 * Races the event stream (TUI picker) against a poll of `run.json`
 * (`/approve`). Whichever resolves first wins; the loser is cleaned up.
 */
async function waitForGateRelease(ctx: GateContext): Promise<GateDecision> {
  const pollInterval = ctx.pollIntervalMs ?? 1_000;
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  ctx.signal?.addEventListener("abort", onAbort, { once: true });

  const timer =
    ctx.timeoutMs !== undefined
      ? setTimeout(() => controller.abort(), ctx.timeoutMs)
      : undefined;

  try {
    const released = await Promise.race([
      watchForQuestionReply(ctx, controller.signal).then((decision) => ({ source: "question" as const, decision })),
      pollForApproval(ctx, pollInterval, controller.signal).then((decision) => ({ source: "state" as const, decision })),
    ]);

    // An `/approve` leaves the agent's question unanswered, which would keep
    // the session blocked. Answer it, then abort that exact prompt turn so it
    // cannot continue doing work after the externally resolved gate.
    if (released.source === "state") {
      if (released.decision.outcome === "proceed") {
        await settlePendingQuestions(ctx, GATE_CHOICES.approve);
      }
      await abortAndWaitForIdle(ctx.client, ctx.sessionId, ctx.projectDir, ctx.settleTimeoutMs);
    }

    // Stop the losing watcher only after the gate prompt is idle or aborted.
    controller.abort();
    return released.decision;
  } finally {
    if (timer) clearTimeout(timer);
    ctx.signal?.removeEventListener("abort", onAbort);
    controller.abort();
  }
}

/** Resolve when the human answers the picker in the TUI. */
async function watchForQuestionReply(
  ctx: GateContext,
  signal: AbortSignal,
): Promise<GateDecision> {
  // Track questions raised during this gate so a stale one from an earlier
  // turn cannot be mistaken for this gate's answer.
  const ours = new Set<string>();
  let decision: GateDecision | undefined;

  const events = subscribeEvents(ctx.client, {
    sessionId: ctx.sessionId,
    directory: ctx.projectDir,
    signal,
  });

  const iterator = events[Symbol.asyncIterator]();
  for (;;) {
    const next = decision
      ? await nextWithTimeout(iterator, ctx.settleTimeoutMs ?? 5_000)
      : await iterator.next();
    if (next === "timeout") {
      await abortAndWaitForIdle(ctx.client, ctx.sessionId, ctx.projectDir, ctx.settleTimeoutMs);
      return decision!;
    }
    if (next.done) break;
    const event = next.value;
    if (signal.aborted) break;

    if (decision && (event.kind === "idle" || (event.kind === "status" && event.status === "idle"))) {
      return decision;
    }

    if (event.kind === "question") {
      ours.add(event.requestID);
      continue;
    }

    if (event.kind === "question-rejected" && ours.has(event.requestID)) {
      decision = { outcome: "stop", reason: "question was rejected" };
      continue;
    }

    if (event.kind === "question-replied" && ours.has(event.requestID)) {
      // The event carries the chosen labels, so there is nothing to look up.
      const label = event.answers[0]?.[0];
      if (label === undefined) {
        // Answered with nothing selected. Treat an empty answer as needing
        // another look rather than as approval.
        decision = { outcome: "revise", reason: "gate answered with no selection" };
        continue;
      }
      decision = decisionFromLabel(label);
    }
  }

  return { outcome: "stop", reason: "aborted while waiting at gate" };
}

async function nextWithTimeout<T>(
  iterator: AsyncIterator<T>,
  timeoutMs: number,
): Promise<IteratorResult<T> | "timeout"> {
  return Promise.race([
    iterator.next(),
    new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), timeoutMs)),
  ]);
}

/** Resolve when `/approve` (or a reject) lands in run.json. */
async function pollForApproval(
  ctx: GateContext,
  intervalMs: number,
  signal: AbortSignal,
): Promise<GateDecision> {
  for (;;) {
    if (signal.aborted) return { outcome: "stop", reason: "aborted while waiting at gate" };

    try {
      const state = readRunState(ctx.projectDir);

      if (state.stage_status === "approved") {
        return { outcome: "proceed", reason: "approved via /approve" };
      }
      if (state.stage_status === "blocked") {
        return {
          outcome: "stop",
          reason: state.error?.message ?? "blocked via /approve reject",
        };
      }
    } catch (err) {
      // A half-written run.json during a concurrent write is expected.
      log.debug(`gate poll skipped a read: ${String(err)}`);
    }

    await sleep(intervalMs, signal);
  }
}

/**
 * Answer any question this gate raised that is still pending.
 *
 * Called after the gate opened by another route, so the agent is not left
 * blocked on a picker nobody is going to touch.
 */
async function settlePendingQuestions(ctx: GateContext, label: string): Promise<void> {
  const pending = await listQuestions(ctx.client, ctx.projectDir);
  for (const question of pending) {
    if (question.sessionID !== ctx.sessionId) continue;
    const answered = await replyToQuestion(ctx.client, {
      requestID: question.requestID,
      answers: [[label]],
      directory: ctx.projectDir,
    });
    if (answered) log.debug(`settled pending question ${question.requestID}`);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
