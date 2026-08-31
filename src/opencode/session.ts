/**
 * Session lifecycle: create, resume, prompt, abort, and TUI attach.
 *
 * Writer stages and human gates use the run's long-lived OpenCode session.
 * Independent reviews use a newly created cold session for every attempt.
 */

import type { OpencodeClient, Message } from "@opencode-ai/sdk/v2";

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
    model?: string;
    variant?: string;
    directory?: string;
  },
): Promise<void> {
  const model = opts.model === undefined ? undefined : parseModelRef(opts.model);
  await unwrap(
    client.session.promptAsync({
      sessionID: opts.sessionId,
      ...(opts.directory !== undefined ? { directory: opts.directory } : {}),
      ...(opts.agent !== undefined ? { agent: opts.agent } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(opts.variant !== undefined ? { variant: opts.variant } : {}),
      parts: [{ type: "text", text: opts.text }],
    }),
    "session prompt",
  );
}

export interface SessionUsageSnapshot {
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number;
  transcriptMessages?: number;
}

/** Aggregate usage without retaining transcript contents. */
export async function getSessionUsage(
  client: OpencodeClient,
  sessionId: string,
  opts: { timeoutMs?: number } = {},
): Promise<SessionUsageSnapshot | null> {
  const timeoutMs = opts.timeoutMs ?? 2_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      client.session.messages({ sessionID: sessionId }),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
    if (result === null) return null;
    if (result.error || !result.data || !Array.isArray(result.data)) return null;
    const projectedMessages = result.data;
    const usage: SessionUsageSnapshot = {
      modelCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cost: 0,
    };
    for (const projected of projectedMessages) {
      if (!("info" in projected)) continue;
      const message = projected.info as Message;
      if (message.role !== "assistant") continue;
      usage.modelCalls += 1;
      usage.inputTokens += message.tokens?.input ?? 0;
      usage.outputTokens += message.tokens?.output ?? 0;
      usage.reasoningTokens += message.tokens?.reasoning ?? 0;
      usage.cacheReadTokens += message.tokens?.cache.read ?? 0;
      usage.cacheWriteTokens += message.tokens?.cache.write ?? 0;
      usage.cost += message.cost ?? 0;
    }
    usage.transcriptMessages = projectedMessages.length;
    return usage;
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function parseModelRef(model: string): { providerID: string; modelID: string } {
  const separator = model.indexOf("/");
  if (separator <= 0 || separator === model.length - 1) {
    throw new OpencodeError(`Invalid model "${model}"; expected provider/model.`);
  }
  return { providerID: model.slice(0, separator), modelID: model.slice(separator + 1) };
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

/** Abort one turn and require that exact session to settle before returning. */
export async function abortAndWaitForIdle(
  client: OpencodeClient,
  sessionId: string,
  directory?: string,
  timeoutMs = 5_000,
): Promise<void> {
  const controller = new AbortController();
  let timedOut = false;
  const deadline = Date.now() + timeoutMs;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    await unwrap(
      client.session.abort({
        sessionID: sessionId,
        ...(directory !== undefined ? { directory } : {}),
      }, { signal: controller.signal }),
      "session abort",
    );

    while (Date.now() < deadline) {
      if (await getSessionStatus(client, sessionId, directory, controller.signal) === "idle") return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  } catch (err) {
    if (!timedOut) throw err;
  } finally {
    clearTimeout(timer);
  }
  throw new OpencodeError(`session ${sessionId} did not become idle after abort`);
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
  signal?: AbortSignal,
): Promise<SessionStatusType> {
  const statuses = await unwrap(
    client.session.status(
      directory !== undefined ? { directory } : {},
      signal ? { signal } : undefined,
    ),
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
