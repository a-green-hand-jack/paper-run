/**
 * paper-run gate plugin.
 *
 * Three small jobs that the agent markdown files cannot do on their own, because
 * they need to run at moments between turns rather than inside a prompt.
 *
 * 1. **Shell environment.** Harness scripts want to know which stage and mode
 *    they are running under. Threading that through every bash invocation is
 *    fragile; injecting it once here means `.agents/tools/*` can just read
 *    `$PAPER_RUN_STAGE`.
 *
 * 2. **Permission auto-approval.** The writing pipeline runs the same handful of
 *    harness validators dozens of times per run. Prompting for each one trains
 *    the user to approve reflexively, which is worse for safety than approving
 *    the narrow, known-safe set automatically. Everything outside that set is
 *    left alone and still asks. Note the deliberate asymmetry: this plugin only
 *    ever *allows* — it never denies, so it cannot silently tighten a permission
 *    the user configured.
 *
 * 3. **Gate visibility.** When the controller parks the run at a gate, the TUI
 *    has no reason to surface it. A toast on session idle is the difference
 *    between a run that is waiting for you and a run that looks hung.
 *
 * Installed by paper-run. Kept dependency-free (node:fs only).
 */

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

/**
 * Bash commands safe to run unattended in a writing repo.
 *
 * Read-only inspection plus the harness's own validators and build. Deliberately
 * excludes anything that rewrites history, moves refs, or reaches the network:
 * `git commit`, `git push`, `git checkout`, `rm`, `curl`, and friends keep
 * asking.
 */
const AUTO_APPROVED_BASH = [
  /^python3\s+\.agents\/tools\/(check|paper)-[\w-]+\.py\b/,
  /^bash\s+\.agents\/tools\/verify\.sh\b/,
  /^\.\/\.agents\/tools\/verify\.sh\b/,
  /^make\s+(pdf|diff|clean|check)\b/,
  /^git\s+(status|diff|log|show|ls-files)\b/,
]

function isAutoApproved(command: string): boolean {
  const normalized = command.trim()
  // Only judge single commands. A chained, substituted, or multi-line command
  // could smuggle anything past a prefix match — `git status\nrm -rf /` matches
  // the git pattern but is two commands — so anything with a shell separator or
  // a line break falls through to the normal prompt.
  if (/[;&|`\n\r]|\$\(/.test(normalized)) return false
  return AUTO_APPROVED_BASH.some((pattern) => pattern.test(normalized))
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
     * Auto-approve the harness's own read-only and validation commands.
     * Never denies — anything unrecognised falls through to the user.
     */
    "permission.ask": async (input, output) => {
      if (input.type !== "bash") return

      // `metadata.command` is the command actually about to run; `pattern` is
      // only the config glob that matched it, and may be an array. Judge the
      // real command whenever it is available.
      const meta = input.metadata as { command?: unknown } | undefined
      const command =
        typeof meta?.command === "string"
          ? meta.command
          : typeof input.pattern === "string"
            ? input.pattern
            : ""

      if (command !== "" && isAutoApproved(command)) {
        output.status = "allow"
      }
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
