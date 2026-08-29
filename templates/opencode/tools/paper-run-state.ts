/**
 * paper-run state tool.
 *
 * Agents can already `cat .paper-run/*.json`, so why a tool? Two reasons.
 *
 * Reading: the state is spread across three files, and an agent that reads them
 * one at a time tends to act on a stale first read. `read` returns one
 * consistent snapshot with the derived facts (progress, last checkpoint, whether
 * a gate is waiting) already computed, so the agent does not recompute them —
 * and does not get them wrong.
 *
 * Writing: `run.json` is the controller's file. The one write an agent is ever
 * allowed to make is releasing a gate, and expressing that as a narrow tool
 * rather than a free-form file edit means a malformed or over-broad write is
 * refused instead of silently corrupting the run. Every other field is preserved
 * byte-for-byte.
 *
 * Installed by paper-run. Kept dependency-free (node:fs only) so it works in any
 * writing repo without an install step.
 */

import { tool } from "@opencode-ai/plugin"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const PAPER_RUN_DIR = ".paper-run"

const FILES = {
  run: "run.json",
  gatePolicy: "gate-policy.json",
  stageHistory: "stage-history.json",
  assessment: "assessment.json",
} as const

/** The canonical stage order, mirrored from paper-run's own constants. */
const PIPELINE_STAGES = [
  "bootstrap",
  "material_assessment",
  "evidence_inventory",
  "paper_positioning",
  "claim_evidence",
  "story_outline",
  "canonical_drafting",
  "citation_integration",
  "self_review",
  "independent_review",
  "revision",
  "publication_build",
  "paper_candidate",
]

function statePath(directory: string, file: string): string {
  return join(directory, PAPER_RUN_DIR, file)
}

function readJson(path: string): unknown | null {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, "utf-8"))
  } catch {
    return null
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export default tool({
  description:
    "Read paper-run pipeline state (current stage, status, mode, gate policy, progress, " +
    "last checkpoint) as one consistent snapshot, or release a gate that is waiting for " +
    "human approval. Use action 'read' to orient before starting work; use 'gate-response' " +
    "only when the user has explicitly approved the current gate.",
  args: {
    action: tool.schema
      .enum(["read", "gate-response"])
      .describe(
        "'read' returns a snapshot of all paper-run state. 'gate-response' approves or " +
          "rejects a gate, and only works when stage_status is 'gate_waiting'.",
      ),
    response: tool.schema
      .enum(["approve", "reject"])
      .optional()
      .describe(
        "Required for 'gate-response'. 'approve' sets stage_status to 'approved' so the " +
          "controller continues; 'reject' sets it to 'blocked' so the run halts for repair.",
      ),
    note: tool.schema
      .string()
      .optional()
      .describe("Optional reason, recorded on the run when rejecting a gate."),
  },
  async execute(args, context) {
    const directory = context.directory ?? process.cwd()

    if (args.action === "read") {
      return readState(directory)
    }

    return gateResponse(directory, args.response, args.note)
  },
})

// ---------------------------------------------------------------------------
// read
// ---------------------------------------------------------------------------

function readState(directory: string): string {
  const run = asRecord(readJson(statePath(directory, FILES.run)))
  if (!run) {
    return JSON.stringify(
      {
        error: "no_run_state",
        message:
          "No readable .paper-run/run.json in this repository. This is either not a " +
          "paper-run project, or the run has not been initialised yet.",
      },
      null,
      2,
    )
  }

  const gatePolicy = asRecord(readJson(statePath(directory, FILES.gatePolicy)))
  const history = asRecord(readJson(statePath(directory, FILES.stageHistory)))
  const assessment = asRecord(readJson(statePath(directory, FILES.assessment)))

  const stages = Array.isArray(history?.["stages"]) ? (history["stages"] as Record<string, unknown>[]) : []
  const completed = stages.filter((s) => s["status"] === "completed")
  const last = stages.length > 0 ? stages[stages.length - 1] : null

  const currentStage = typeof run["current_stage"] === "string" ? run["current_stage"] : null
  const stageStatus = typeof run["stage_status"] === "string" ? run["stage_status"] : null
  const gates = asRecord(gatePolicy?.["gates"]) ?? {}
  const currentGate = currentStage ? asRecord(gates[currentStage]) : null

  const stageIndex = currentStage ? PIPELINE_STAGES.indexOf(currentStage) : -1

  return JSON.stringify(
    {
      run: {
        run_id: run["run_id"] ?? null,
        run_branch: run["run_branch"] ?? null,
        mode: run["mode"] ?? null,
        current_stage: currentStage,
        stage_status: stageStatus,
        started_at: run["started_at"] ?? null,
        updated_at: run["updated_at"] ?? null,
        template_version: run["template_version"] ?? null,
        error: run["error"] ?? null,
      },
      stage: {
        position: stageIndex >= 0 ? stageIndex + 1 : null,
        total: PIPELINE_STAGES.length,
        gate_policy: currentGate?.["policy"] ?? null,
        awaiting_approval: stageStatus === "gate_waiting",
        blocked: stageStatus === "blocked",
      },
      progress: {
        completed_stages: completed.length,
        total_stages: PIPELINE_STAGES.length,
        completed_stage_ids: completed.map((s) => s["stage_id"]),
        remaining_stage_ids: PIPELINE_STAGES.filter(
          (id) => !completed.some((s) => s["stage_id"] === id),
        ),
      },
      last_checkpoint: last
        ? {
            stage_id: last["stage_id"] ?? null,
            status: last["status"] ?? null,
            completed_at: last["completed_at"] ?? null,
            commit_sha: last["commit_sha"] ?? null,
          }
        : null,
      gate_policy_mode: gatePolicy?.["mode"] ?? null,
      material_assessment: assessment
        ? { verdict: assessment["verdict"] ?? null, summary: assessment["summary"] ?? null }
        : null,
    },
    null,
    2,
  )
}

// ---------------------------------------------------------------------------
// gate-response
// ---------------------------------------------------------------------------

function gateResponse(directory: string, response: string | undefined, note: string | undefined): string {
  if (response !== "approve" && response !== "reject") {
    return JSON.stringify({
      error: "missing_response",
      message: "action 'gate-response' requires response to be 'approve' or 'reject'.",
    })
  }

  const path = statePath(directory, FILES.run)
  const run = asRecord(readJson(path))
  if (!run) {
    return JSON.stringify({
      error: "no_run_state",
      message: "No readable .paper-run/run.json — nothing to approve.",
    })
  }

  if (run["stage_status"] !== "gate_waiting") {
    return JSON.stringify({
      error: "not_at_gate",
      message:
        `The pipeline is not waiting for approval (stage_status is ` +
        `"${String(run["stage_status"])}"). No state was changed.`,
      current_stage: run["current_stage"] ?? null,
      stage_status: run["stage_status"] ?? null,
    })
  }

  const now = new Date().toISOString()
  // Preserve every other field exactly as the controller wrote it.
  const updated: Record<string, unknown> = { ...run }
  updated["stage_status"] = response === "approve" ? "approved" : "blocked"
  updated["updated_at"] = now

  if (response === "reject") {
    updated["error"] = {
      stage: run["current_stage"] ?? "unknown",
      message: note ?? "Gate rejected by the user.",
      at: now,
    }
  }

  writeFileSync(path, `${JSON.stringify(updated, null, 2)}\n`)

  return JSON.stringify(
    {
      ok: true,
      stage: run["current_stage"] ?? null,
      stage_status: updated["stage_status"],
      updated_at: now,
      message:
        response === "approve"
          ? "Gate approved. The paper-run controller will advance at its next poll."
          : "Gate rejected. The run is now blocked and needs the underlying problem fixed.",
    },
    null,
    2,
  )
}
