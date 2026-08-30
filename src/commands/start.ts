/**
 * `paper-run start` — attach the TUI and drive the pipeline behind it.
 *
 * Two things run at once and neither owns the other:
 *
 *  - The **TUI** holds the terminal. The user reads the transcript, talks to
 *    the agent, and answers gates there.
 *  - The **controller** drives the pipeline over the same session, so what it
 *    does shows up in that transcript rather than somewhere the user cannot
 *    see.
 *
 * Whichever finishes first ends the run: quitting the TUI stops the
 * controller, and a pipeline that blocks or completes closes the TUI. The
 * alternative — a controller still prompting an agent whose terminal is gone,
 * or a TUI sitting in front of a finished run — is worse than ending both.
 *
 * Every exit path writes state before returning, so `paper-run start` is
 * always safe to run again.
 */

import { readRunState, readGatePolicy, updateRunState } from "../state/store.js";
import type { RunState } from "../state/schema.js";
import { generateGatePreset } from "../state/gate-presets.js";
import { writeGatePolicy } from "../state/store.js";
import { switchOperatingMode } from "../state/mode.js";
import { prepareRunResume } from "./checkpoint.js";

import { assertNoConcurrentRun, attachRun, detachRun } from "../opencode/attach.js";
import { launchTui, hasOpencodeCli } from "../opencode/tui.js";
import { showToast } from "../opencode/session.js";

import { PipelineController } from "../controller/controller.js";
import type { PipelineResult } from "../controller/controller.js";

import { detectHarness } from "../harness/harness.js";
import { isAdapterInstalled, installAdapter } from "../adapter/install.js";

import { getStage, stageNumber, TOTAL_STAGES } from "../pipeline/stages.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { MODES, OPENCODE_CONFIG, PAPER_RUN_DIR } from "../utils/constants.js";
import type { Mode } from "../utils/constants.js";
import { PaperRunError, EXIT_CODES } from "../utils/errors.js";
import { requireProjectRoot } from "../utils/paths.js";
import { getCurrentBranch } from "../utils/git.js";
import { log, setLogFile } from "../utils/logger.js";

export interface StartOptions {
  mode?: string;
  stage?: string;
  port?: number;
  session?: string;
  /** Run the pipeline without attaching a TUI. */
  headless?: boolean;
  model?: string;
}

export async function startCommand(opts: StartOptions): Promise<void> {
  const projectDir = requireProjectRoot();

  // Mirror everything to a file, so a run that is killed, backgrounded, or
  // left overnight still leaves a readable trace of where it got to.
  setLogFile(join(projectDir, PAPER_RUN_DIR, "run.log"));

  assertNoConcurrentRun(projectDir);
  let state = await prepareRunResume(projectDir);
  await assertRunnable(projectDir);

  // --- state ---
  let policy = readGatePolicy(projectDir);

  if (opts.mode) {
    const mode = parseMode(opts.mode);
    const result = switchOperatingMode(projectDir, mode);
    policy = result.policy;
    state = readRunState(projectDir);
    if (result.previousMode !== mode) {
      log.info(`Mode set to ${mode} for this run.`);
    }
  }

  if (opts.stage) {
    state = jumpToStage(projectDir, opts.stage);
  }

  reportResumePoint(state, projectDir);

  // --- server + session ---
  const run = await attachRun({
    projectDir,
    runId: state.run_id,
    mode: state.mode,
    port: opts.port,
    sessionIdOverride: resolveResumeSession(opts.session, state.session_id),
  });

  // Record the session on the run so checkpoints can carry it.
  updateRunState(projectDir, { session_id: run.sessionId });

  log.debug(`session ${run.sessionId} on ${run.server.url}`);

  // --- controller ---
  const abort = new AbortController();
  const controller = new PipelineController({
    client: run.client,
    sessionId: run.sessionId,
    projectDir,
    policy,
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    signal: abort.signal,
  });

  const onSignal = () => {
    log.blank();
    log.warn("Interrupted — finishing the current step and saving state.");
    abort.abort();
    void controller.abort();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  let result: PipelineResult | undefined;

  try {
    if (opts.headless) {
      result = await controller.run();
    } else {
      result = await runWithTui({
        controller,
        abort,
        serverUrl: run.server.url,
        sessionId: run.sessionId,
        projectDir,
      });
    }
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    detachRun({ projectDir, server: run.server });
  }

  applyExitCode(result);
}

export function resolveResumeSession(explicit: string | undefined, reconciled: string | undefined): string | undefined {
  return explicit ?? reconciled;
}

// ---------------------------------------------------------------------------
// TUI + controller
// ---------------------------------------------------------------------------

async function runWithTui(args: {
  controller: PipelineController;
  abort: AbortController;
  serverUrl: string;
  sessionId: string;
  projectDir: string;
}): Promise<PipelineResult> {
  const tui = launchTui({
    serverUrl: args.serverUrl,
    sessionId: args.sessionId,
    projectDir: args.projectDir,
  });

  // The controller runs behind the TUI. Its rejection is captured rather than
  // left floating: an unhandled rejection here would take down the process
  // while the user is still in the TUI.
  let controllerError: unknown;
  const pipeline = args.controller.run().catch((err: unknown) => {
    controllerError = err;
    return undefined;
  });

  // Whichever ends first ends the run.
  const finishedBy = await Promise.race([
    pipeline.then(() => "pipeline" as const),
    tui.exited.then(() => "tui" as const),
  ]);

  if (finishedBy === "tui") {
    // The user quit: stop the pipeline and let it unwind cleanly.
    log.debug("TUI exited; stopping the controller");
    args.abort.abort();
    await args.controller.abort();
    await pipeline;
  } else {
    // The pipeline ended. Give the user a beat to read the final toast
    // before the terminal is taken back.
    await settle(1_500);
    if (!tui.closed) tui.close();
  }

  if (controllerError) throw controllerError;

  const result = await pipeline;
  return result ?? { status: "interrupted", stageId: "unknown" };
}

// ---------------------------------------------------------------------------
// Preconditions
// ---------------------------------------------------------------------------

async function assertRunnable(projectDir: string): Promise<void> {
  if (!(await hasOpencodeCli())) {
    throw new PaperRunError("OpenCode is not installed, or not on PATH.", {
      hint: "Install it from https://opencode.ai, then run `opencode --version` to confirm.",
    });
  }

  if (!detectHarness(projectDir)) {
    throw new PaperRunError("This project does not contain the writing harness.", {
      hint: "The repository may be incomplete. Re-create it with `paper-run init`.",
    });
  }

  // The adapter is what puts /status, /mode and /approve in the TUI. A repo
  // created by an older paper-run may predate it, so repair rather than fail.
  if (!isAdapterInstalled(projectDir)) {
    log.step("Installing the OpenCode adapter");
    await installAdapter(projectDir);
  }

  await assertModelAvailable(projectDir);
}

/**
 * Fail early when the configured model cannot be reached.
 *
 * OpenCode accepts a prompt for an unavailable model and queues it silently:
 * the message lands in the session, no assistant reply ever comes, and the
 * cost stays zero. From the controller's side that is indistinguishable from
 * an agent that did nothing, so every stage fails validation for a reason
 * that has nothing to do with the writing. Catching it here turns a baffling
 * stall into one clear sentence.
 */
async function assertModelAvailable(projectDir: string): Promise<void> {
  const configured = readConfiguredModel(projectDir);
  if (!configured) return;

  let available: string[];
  try {
    const { execa } = await import("execa");
    const { stdout } = await execa("opencode", ["models"], { reject: false });
    available = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  } catch {
    // If the model list cannot be read, do not block the run on it.
    return;
  }

  if (available.length === 0 || available.includes(configured)) return;

  const provider = configured.split("/")[0] ?? configured;
  const alternatives = available.slice(0, 5);

  throw new PaperRunError(`The configured model is not available: ${configured}`, {
    hint:
      `No models from "${provider}" are reachable with your current OpenCode auth.\n` +
      `  Available models include:\n${alternatives.map((m) => `    ${m}`).join("\n")}\n` +
      `  Fix by either:\n` +
      `    • authenticating that provider:  opencode auth login\n` +
      `    • or setting "model" in ${projectDir}/opencode.json to one of the above`,
  });
}

/** Read the `model` field from the project's opencode.json, if any. */
export function readConfiguredModel(projectDir: string): string | null {
  const path = join(projectDir, OPENCODE_CONFIG);
  if (!existsSync(path)) return null;
  try {
    const config = JSON.parse(readFileSync(path, "utf-8")) as { model?: unknown };
    return typeof config.model === "string" ? config.model : null;
  } catch {
    return null;
  }
}

function parseMode(value: string): Mode {
  if ((MODES as readonly string[]).includes(value)) return value as Mode;
  throw new PaperRunError(`Invalid mode "${value}".`, {
    hint: `Must be one of: ${MODES.join(", ")}`,
  });
}

/**
 * Move the run to a specific stage.
 *
 * Marked pending rather than completed, so the stage actually runs instead of
 * being skipped over.
 */
function jumpToStage(projectDir: string, stageId: string): RunState {
  // Throws for an unknown id, which is the right response to a typo here.
  const stage = getStage(stageId);
  log.warn(`Starting at "${stage.name}" (${stageNumber(stage.id)}/${TOTAL_STAGES}).`);
  return updateRunState(projectDir, {
    current_stage: stage.id,
    stage_status: "pending",
  });
}

function reportResumePoint(state: RunState, projectDir: string): void {
  const stage = getStage(state.current_stage);
  const position = `${stageNumber(stage.id)}/${TOTAL_STAGES}`;

  switch (state.stage_status) {
    case "completed":
    case "approved":
      log.step(`Continuing after ${stage.name} (${position})`);
      break;
    case "blocked":
      log.warn(`This run is blocked at ${stage.name}: ${state.error?.message ?? "unknown reason"}`);
      log.hint("Resolve the problem, then start again — the stage will be retried.");
      break;
    case "gate_waiting":
      log.step(`Resuming at the gate after ${stage.name} (${position})`);
      break;
    default:
      log.step(`Running ${stage.name} (${position})`);
  }

  void projectDir;
}

// ---------------------------------------------------------------------------
// Exit
// ---------------------------------------------------------------------------

function applyExitCode(result: PipelineResult | undefined): void {
  if (!result) return;

  switch (result.status) {
    case "completed":
      // Success is the default exit code.
      break;
    case "stopped":
      process.exitCode = EXIT_CODES.BLOCKED;
      break;
    case "interrupted":
      process.exitCode = EXIT_CODES.INTERRUPTED;
      break;
  }
}

function settle(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// status / mode, which share this module's state handling
// ---------------------------------------------------------------------------

export interface StatusOptions {
  json?: boolean;
}

export async function statusCommand(opts: StatusOptions): Promise<void> {
  const projectDir = requireProjectRoot();
  const state = readRunState(projectDir);
  const policy = readGatePolicy(projectDir);

  let history: { stages: Array<{ stage_id: string; status: string }> };
  try {
    const { readStageHistory } = await import("../state/store.js");
    history = readStageHistory(projectDir);
  } catch {
    history = { stages: [] };
  }

  if (opts.json) {
    // stdout, so it can be piped. Everything else in the CLI goes to stderr.
    process.stdout.write(
      JSON.stringify(
        {
          run_id: state.run_id,
          branch: state.run_branch,
          mode: state.mode,
          current_stage: state.current_stage,
          stage_status: state.stage_status,
          completed: history.stages.filter((s) => s.status === "completed").length,
          total: TOTAL_STAGES,
          template_version: state.template_version,
          ...(state.error ? { error: state.error } : {}),
        },
        null,
        2,
      ) + "\n",
    );
    return;
  }

  const stage = getStage(state.current_stage);
  const completed = history.stages.filter((s) => s.status === "completed").length;
  const branch = await getCurrentBranch(projectDir).catch(() => state.run_branch);

  const { printKeyValues } = await import("../utils/logger.js");

  log.blank();
  printKeyValues([
    ["Run", state.run_id],
    ["Mode", state.mode],
    ["Stage", `${stage.name} (${stageNumber(stage.id)}/${TOTAL_STAGES}) — ${state.stage_status}`],
    ["Progress", `${completed}/${TOTAL_STAGES} complete`],
    ["Branch", branch],
    ["Template", state.template_version],
    ["Gate here", policy.gates[state.current_stage]?.policy ?? "await_human"],
  ]);

  if (state.error) {
    log.blank();
    log.error(`Blocked at ${state.error.stage}: ${state.error.message}`);
  }
  log.blank();
}

export async function modeCommand(target?: string): Promise<void> {
  const projectDir = requireProjectRoot();

  if (!target) {
    const state = readRunState(projectDir);
    log.info(`Mode: ${state.mode}`);
    return;
  }

  const mode = parseMode(target);
  const result = switchOperatingMode(projectDir, mode);
  if (result.previousMode === mode) {
    log.info(`Mode is ${mode}; state files are aligned.`);
  } else {
    log.success(`Mode switched to ${mode}.`);
  }
  log.hint("Takes effect at the next gate; a stage already running is unaffected.");
}

/** Reset a project's gate policy to its mode's preset, discarding overrides. */
export function resetGatePolicy(projectDir: string, mode: Mode): void {
  writeGatePolicy(projectDir, generateGatePreset(mode));
}

/** Best-effort toast, used by callers that already hold a client. */
export { showToast };
