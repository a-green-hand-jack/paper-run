/**
 * Launching the native OpenCode TUI attached to a run's session.
 *
 * This is the whole premise of paper-run: the user works in OpenCode's own
 * interface, watching the same session the controller is driving. We never
 * render a second chat UI.
 *
 * The SDK ships `createOpencodeTui`, but it is not usable here for two
 * reasons, both verified against @opencode-ai/sdk 1.18.11:
 *
 *  1. It injects `OPENCODE_CONFIG_CONTENT` unconditionally — `"{}"` when no
 *     config is passed. That env var sits at the top of OpenCode's config
 *     precedence, so it would shadow the writing repo's `opencode.json`,
 *     which is exactly the file the adapter installs to register the
 *     paper-writer agent and the /status, /mode, /approve commands.
 *  2. Its handle exposes only `close()`. There is no exit event, so the
 *     controller could not tell when the user quit and would keep running
 *     against a terminal nobody is watching.
 *
 * Spawning `opencode attach` directly solves both and has the additional
 * benefit of joining the server the controller already started, rather than
 * standing up a second one.
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

import { log } from "../utils/logger.js";

export interface TuiHandle {
  /** Resolves with the TUI's exit code when the user quits. */
  readonly exited: Promise<number>;
  /** Ask the TUI to close. */
  close(): void;
  /** True once the process has exited. */
  readonly closed: boolean;
}

export interface LaunchTuiOptions {
  serverUrl: string;
  sessionId: string;
  projectDir: string;
}

/**
 * Attach the TUI to an existing server and session.
 *
 * stdio is inherited: the TUI owns the terminal from here until the user
 * quits, so anything paper-run writes must go to stderr and stay brief.
 */
export function launchTui(opts: LaunchTuiOptions): TuiHandle {
  const args = buildTuiArgs(opts);

  log.debug(`launching TUI: opencode ${args.join(" ")}`);

  const child = spawn("opencode", args, {
    stdio: "inherit",
    // Deliberately not setting OPENCODE_CONFIG_CONTENT: the writing repo's
    // own opencode.json must win.
    env: process.env,
  });

  return makeHandle(child);
}

/** Build only arguments supported by `opencode attach` in OpenCode 1.18.25. */
export function buildTuiArgs(opts: LaunchTuiOptions): string[] {
  return [
    "attach",
    opts.serverUrl,
    "--session",
    opts.sessionId,
    "--dir",
    opts.projectDir,
  ];
}

function makeHandle(child: ChildProcess): TuiHandle {
  let closed = false;

  const exited = new Promise<number>((resolve) => {
    child.on("exit", (code, signal) => {
      closed = true;
      // A signalled exit reports null; normalise so callers can just compare.
      resolve(code ?? (signal ? 130 : 0));
    });
    child.on("error", (err) => {
      closed = true;
      log.debug(`TUI failed to start: ${err.message}`);
      resolve(127);
    });
  });

  return {
    exited,
    get closed() {
      return closed;
    },
    close() {
      if (closed) return;
      child.kill("SIGTERM");
    },
  };
}

/** True when the `opencode` binary is on PATH. */
export async function hasOpencodeCli(): Promise<boolean> {
  const { execa } = await import("execa");
  try {
    await execa("opencode", ["--version"]);
    return true;
  } catch {
    return false;
  }
}
