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
 * Installed by paper-run. Kept dependency-free (node:fs only) so it works in any
 * writing repo without an install step.
 */

import { tool } from "@opencode-ai/plugin"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

const PAPER_RUN_DIR = ".paper-run"

const FILES = {
  run: "run.json",
  gatePolicy: "gate-policy.json",
  stageHistory: "stage-history.json",
  assessment: "assessment.json",
} as const

/**
 * The canonical stage order, substituted at install time.
 *
 * This used to be a hand-maintained copy of paper-run's own list, which is a
 * second source of truth that nothing type-checks and nothing tests. The
 * installer fills it in instead, so the two can no longer disagree.
 */
const PIPELINE_STAGES: string[] = {{PIPELINE_STAGES}}

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
    "last checkpoint) as one consistent snapshot. This tool never mutates state.",
  args: {
    action: tool.schema
      .enum(["read"])
      .describe("'read' returns a snapshot without changing any state."),
  },
  async execute(_args, context) {
    const directory = context.directory ?? process.cwd()
    return readState(directory)
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
