/**
 * paper-run gate plugin.
 *
 * Two small jobs that the agent markdown files cannot do on their own, because
 * they need to run at moments between turns rather than inside a prompt.
 *
 * 1. **Shell environment.** Harness scripts want to know which stage and mode
 *    they are running under. Threading that through every bash invocation is
 *    fragile; injecting it once here means `.agents/tools/*` can just read
 *    `$PAPER_RUN_STAGE`.
 *
 * 2. **Gate visibility.** When the controller parks the run at a gate, the TUI
 *    has no reason to surface it. A toast on session idle is the difference
 *    between a run that is waiting for you and a run that looks hung.
 *
 * Permission auto-approval deliberately does NOT live here. The `permission.ask`
 * hook is declared in @opencode-ai/plugin but never dispatched by the runtime
 * (verified against opencode 1.18.25: the hook name appears once, in its own
 * type declaration, while every live hook such as `tool.execute.before` and
 * `shell.env` appears at multiple dispatch sites). A handler here would
 * type-check and silently never fire — the worst possible shape for a security
 * control, since it looks like a guard while granting nothing.
 *
 * The controller does this instead, over the `permission.asked` *event*, which
 * is real: see `src/controller/permissions.ts`.
 *
 * Installed by paper-run. Kept dependency-free (node:fs only).
 */

// paper-run-adapter-revision: 2

import type { Plugin } from "@opencode-ai/plugin"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

const PAPER_RUN_DIR = ".paper-run"
const RUN_FILE = "run.json"

interface RunSnapshot {
  stage: string
  status: string
  mode: string
  runId: string
}

function readRun(directory: string): RunSnapshot | null {
  const path = join(directory, PAPER_RUN_DIR, RUN_FILE)
  if (!existsSync(path)) return null

  try {
    const data = JSON.parse(readFileSync(path, "utf-8"))
    if (typeof data !== "object" || data === null) return null
    return {
      stage: typeof data.current_stage === "string" ? data.current_stage : "",
      status: typeof data.stage_status === "string" ? data.stage_status : "",
      mode: typeof data.mode === "string" ? data.mode : "",
      runId: typeof data.run_id === "string" ? data.run_id : "",
    }
  } catch {
    // A half-written run.json during a controller write is expected and harmless.
    return null
  }
}

export const PaperRunGate: Plugin = async ({ client, directory }) => {
  // Toast once per gate, not once per idle event.
  let lastNotifiedGate = ""

  /**
   * Show a TUI toast across SDK generations.
   *
   * Older clients take `{ body: { message, variant } }`; newer ones take the
   * fields flat. A plugin ships into whatever OpenCode version the writing repo
   * has, so try both and stay silent if neither works — a missing toast must
   * never break the session.
   */
  const toast = async (message: string, variant: "warning" | "error"): Promise<void> => {
    const tui = (client as { tui?: { showToast?: (arg: unknown) => Promise<unknown> } }).tui
    if (!tui?.showToast) return

    try {
      await tui.showToast({ body: { message, variant } })
    } catch {
      try {
        await tui.showToast({ message, variant })
      } catch {
        // No TUI attached (headless run), or an incompatible client. Nothing to surface to.
      }
    }
  }

  return {
    /**
     * Surface a waiting gate when the session goes quiet.
     */
    event: async ({ event }) => {
      if (event.type !== "session.idle") return

      const run = readRun(directory)
      if (!run) return

      const gateKey = `${run.runId}:${run.stage}:${run.status}`

      if (run.status === "gate_waiting") {
        if (gateKey === lastNotifiedGate) return
        lastNotifiedGate = gateKey
        await toast(`paper-run: gate waiting at "${run.stage}" — /approve to continue`, "warning")
        return
      }

      if (run.status === "blocked") {
        if (gateKey === lastNotifiedGate) return
        lastNotifiedGate = gateKey
        await toast(`paper-run: blocked at "${run.stage}" — see /status`, "error")
        return
      }

      lastNotifiedGate = ""
    },

    /**
     * Let harness scripts see the run they are part of.
     */
    "shell.env": async (_input, output) => {
      const run = readRun(directory)
      if (!run || !output.env) return

      if (run.stage !== "") output.env["PAPER_RUN_STAGE"] = run.stage
      if (run.status !== "") output.env["PAPER_RUN_STAGE_STATUS"] = run.status
      if (run.mode !== "") output.env["PAPER_RUN_MODE"] = run.mode
      if (run.runId !== "") output.env["PAPER_RUN_ID"] = run.runId
      output.env["PAPER_RUN_ACTIVE"] = "1"
    },
  }
}
