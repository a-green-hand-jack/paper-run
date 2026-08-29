/**
 * Session lifecycle: create, resume, prompt, abort, and TUI attach.
 *
 * A paper-run run maps to one long-lived OpenCode session. The controller
 * sends stage prompts into it; the user attaches the TUI to the same session
 * and sees exactly what the controller is doing.
 */

import { createOpencodeTui } from "@opencode-ai/sdk/v2";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";

import { OpencodeError } from "../utils/errors.js";
import { log } from "../utils/logger.js";

/** Unwrap a heyapi RequestResult, turning transport/API errors into ours. */
async function unwrap<T>(
  promise: PromiseLike<{ data?: T | undefined; error?: unknown }>,
  what: string,
): Promise<T> {
  let result: { data?: T | undefined; error?: unknown };
  try {
    result = await promise;
  } catch (err) {
    throw new OpencodeError(`${what} failed`, { cause: err });
  }

  if (result.error !== undefined && result.error !== null) {
    throw new OpencodeError(`${what} failed: ${JSON.stringify(result.error)}`);
  }
  if (result.data === undefined) {
    throw new OpencodeError(`${what} returned no data`);
  }
  return result.data;
}

/** Create a new session and return its id. */
export async function createSession(
  client: OpencodeClient,
  opts: { title: string; directory?: string },
): Promise<string> {
  const session = await unwrap(
    client.session.create({
      ...(opts.directory !== undefined ? { directory: opts.directory } : {}),
      title: opts.title,
    }),
    "session create",
  );

  const id = (session as { id?: string }).id;
  if (!id) throw new OpencodeError("session create returned no id");
  log.debug(`created session ${id}`);
  return id;
}

/** True when the session still exists on the server. */
export async function sessionExists(
  client: OpencodeClient,
  sessionId: string,
  directory?: string,
): Promise<boolean> {
  try {
    const result = await client.session.get({
      sessionID: sessionId,
      ...(directory !== undefined ? { directory } : {}),
    });
    return result.error === undefined && result.data !== undefined;
  } catch {
    return false;
  }
}

/**
 * Send a prompt into a session without waiting for the reply.
 *
 * Pair with {@link waitForIdle}: the controller only learns that a stage
 * finished by observing the event stream, never by parsing the agent's prose.
 */
export async function sendPrompt(
  client: OpencodeClient,
  opts: {
    sessionId: string;
    text: string;
    agent?: string;
    directory?: string;
  },
): Promise<void> {
  await unwrap(
    client.session.promptAsync({
      sessionID: opts.sessionId,
      ...(opts.directory !== undefined ? { directory: opts.directory } : {}),
      ...(opts.agent !== undefined ? { agent: opts.agent } : {}),
      parts: [{ type: "text", text: opts.text }],
    }),
    "session prompt",
  );
}

/** Abort whatever the session is currently doing. */
export async function abortSession(
  client: OpencodeClient,
  sessionId: string,
  directory?: string,
): Promise<void> {
  try {
    await client.session.abort({
      sessionID: sessionId,
      ...(directory !== undefined ? { directory } : {}),
    });
  } catch (err) {
    // Aborting is best-effort — it runs on the Ctrl+C path, where throwing
    // would mask the interrupt itself.
    log.debug(`abort failed (ignored): ${String(err)}`);
  }
}

export type SessionStatusType = "idle" | "busy" | "retry";

/**
 * Current status of one session.
 *
 * The status map omits idle sessions, so "absent" means idle.
 */
export async function getSessionStatus(
  client: OpencodeClient,
  sessionId: string,
  directory?: string,
): Promise<SessionStatusType> {
  const statuses = await unwrap(
    client.session.status(directory !== undefined ? { directory } : {}),
    "session status",
  );

  const entry = (statuses as Record<string, { type?: string } | undefined>)[sessionId];
  const type = entry?.type;
  if (type === "busy" || type === "retry") return type;
  return "idle";
}

/** Show a toast in the attached TUI. Best-effort: never throws. */
export async function showToast(
  client: OpencodeClient,
  opts: {
    message: string;
    variant?: "info" | "success" | "warning" | "error";
    title?: string;
    directory?: string;
  },
): Promise<void> {
  try {
    await client.tui.showToast({
      ...(opts.directory !== undefined ? { directory: opts.directory } : {}),
      message: opts.message,
      variant: opts.variant ?? "info",
      ...(opts.title !== undefined ? { title: opts.title } : {}),
    });
  } catch (err) {
    // No TUI attached is the normal case for a headless run.
    log.debug(`toast not delivered: ${String(err)}`);
  }
}

/** A running TUI process. */
export interface TuiHandle {
  close(): void;
}

/**
 * Launch the native OpenCode TUI attached to `sessionId`.
 *
 * This is the whole point of the design: paper-run never renders a second
 * chat UI. The user reads and steers the run in OpenCode itself.
 */
export function launchTui(opts: {
  sessionId: string;
  projectDir: string;
  model?: string;
  agent?: string;
}): TuiHandle {
  log.debug(`launching TUI for session ${opts.sessionId}`);
  return createOpencodeTui({
    project: opts.projectDir,
    session: opts.sessionId,
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    ...(opts.agent !== undefined ? { agent: opts.agent } : {}),
  });
}
