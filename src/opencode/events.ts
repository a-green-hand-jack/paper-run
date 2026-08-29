/**
 * SSE event subscription and idle detection.
 *
 * The controller never decides a stage is finished by reading the agent's
 * text. It watches the event stream for `session.idle`, then runs the
 * harness validators itself. This is what makes stage completion a fact
 * rather than a claim.
 */

import type { OpencodeClient, Event } from "@opencode-ai/sdk/v2";

import { OPENCODE_DEFAULTS } from "../utils/constants.js";
import { OpencodeError, StageTimeoutError } from "../utils/errors.js";
import { log } from "../utils/logger.js";

/** Events the controller acts on. */
export type RelevantEvent =
  | { kind: "idle"; sessionID: string }
  | { kind: "status"; sessionID: string; status: "idle" | "busy" | "retry" }
  | { kind: "question"; sessionID: string; requestID: string; raw: unknown }
  | {
      kind: "question-replied";
      sessionID: string;
      requestID: string;
      /** Selected labels, one array per question in the request. */
      answers: string[][];
    }
  | { kind: "question-rejected"; sessionID: string; requestID: string }
  | { kind: "permission"; sessionID: string; requestID: string; permission: string; raw: unknown }
  | { kind: "error"; sessionID: string; raw: unknown }
  | { kind: "other"; type: string };

/**
 * Normalize a raw SDK event into the small set the controller cares about.
 *
 * OpenCode carries several event generations at once (`question.asked` and
 * `question.v2.asked` both appear). Both map to the same `kind` here so
 * callers do not have to track which generation produced them.
 */
export function classifyEvent(event: Event): RelevantEvent {
  const type = event.type;
  const props = (event as { properties?: Record<string, unknown> }).properties ?? {};
  const sessionID = typeof props["sessionID"] === "string" ? props["sessionID"] : "";

  switch (type) {
    case "session.idle":
      return { kind: "idle", sessionID };

    case "session.status": {
      const status = props["status"] as { type?: string } | undefined;
      const t = status?.type;
      return {
        kind: "status",
        sessionID,
        status: t === "busy" || t === "retry" ? t : "idle",
      };
    }

    case "session.error":
      return { kind: "error", sessionID, raw: props };

    case "question.asked":
    case "question.v2.asked": {
      const requestID = typeof props["id"] === "string" ? props["id"] : "";
      return { kind: "question", sessionID, requestID, raw: props };
    }

    case "question.replied":
    case "question.v2.replied": {
      const requestID =
        typeof props["requestID"] === "string"
          ? props["requestID"]
          : typeof props["id"] === "string"
            ? props["id"]
            : "";
      // The event carries the chosen labels directly — one array per question
      // in the request — so a gate never has to query for the answer.
      const raw = props["answers"];
      const answers: string[][] = Array.isArray(raw)
        ? raw.map((entry) =>
            Array.isArray(entry) ? entry.filter((v): v is string => typeof v === "string") : [],
          )
        : [];
      return { kind: "question-replied", sessionID, requestID, answers };
    }

    case "question.rejected":
    case "question.v2.rejected": {
      const requestID =
        typeof props["requestID"] === "string"
          ? props["requestID"]
          : typeof props["id"] === "string"
            ? props["id"]
            : "";
      return { kind: "question-rejected", sessionID, requestID };
    }

    case "permission.asked":
    case "permission.v2.asked": {
      const requestID = typeof props["id"] === "string" ? props["id"] : "";
      const permission = typeof props["permission"] === "string" ? props["permission"] : "";
      return { kind: "permission", sessionID, requestID, permission, raw: props };
    }

    default:
      return { kind: "other", type };
  }
}

/**
 * Subscribe to the server event stream.
 *
 * Reconnects on drop: a long stage can outlive a transient network blip, and
 * losing the stream would strand the controller waiting for an idle event
 * that already fired.
 */
export async function* subscribeEvents(
  client: OpencodeClient,
  opts: {
    sessionId?: string;
    directory?: string;
    signal?: AbortSignal;
    reconnectDelayMs?: number;
  } = {},
): AsyncGenerator<RelevantEvent> {
  const reconnectDelay = opts.reconnectDelayMs ?? 2_000;

  while (!opts.signal?.aborted) {
    let stream: AsyncIterable<Event>;

    try {
      const result = await client.event.subscribe(
        opts.directory !== undefined ? { directory: opts.directory } : {},
      );
      stream = result.stream as AsyncIterable<Event>;
    } catch (err) {
      if (opts.signal?.aborted) return;
      log.debug(`event subscribe failed, retrying: ${String(err)}`);
      await sleep(reconnectDelay, opts.signal);
      continue;
    }

    try {
      for await (const raw of stream) {
        if (opts.signal?.aborted) return;

        const event = classifyEvent(raw);
        // Session-scoped events from other sessions are not ours; global
        // events (empty sessionID) always pass through.
        if (opts.sessionId && "sessionID" in event && event.sessionID) {
          if (event.sessionID !== opts.sessionId) continue;
        }
        yield event;
      }
    } catch (err) {
      if (opts.signal?.aborted) return;
      log.debug(`event stream dropped, reconnecting: ${String(err)}`);
    }

    if (opts.signal?.aborted) return;
    await sleep(reconnectDelay, opts.signal);
  }
}

/**
 * Wait until the session goes idle.
 *
 * Two races have to be handled, in opposite directions:
 *
 *  - **Missing the transition.** If we checked status before subscribing, a
 *    session that finished in between would leave us waiting for an event
 *    that already passed. So the stream is primed first.
 *
 *  - **Idle because it has not started yet.** `promptAsync` returns as soon
 *    as the prompt is accepted, before the agent begins working, so the
 *    session is still idle for a moment afterwards. Treating that as "the
 *    turn is over" makes the controller skip straight to validation while the
 *    agent has not read a single word — the stage then fails for reasons that
 *    have nothing to do with the work. `startedWithin` waits for the session
 *    to actually pick the prompt up before idle counts as completion.
 */
export async function waitForIdle(
  client: OpencodeClient,
  opts: {
    sessionId: string;
    directory?: string;
    timeoutMs?: number;
    stageId?: string;
    signal?: AbortSignal;
    /**
     * How long to allow for the session to start working before an idle
     * status counts as "already finished". Set to 0 when resuming a turn
     * that was already in flight.
     */
    startedWithinMs?: number;
    /** Called for every event seen while waiting (gates, permissions, …). */
    onEvent?: (event: RelevantEvent) => void | Promise<void>;
  },
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? OPENCODE_DEFAULTS.stageTimeoutMs;
  const stageId = opts.stageId ?? "unknown";
  const startupGrace = opts.startedWithinMs ?? OPENCODE_DEFAULTS.startupGraceMs;

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const events = subscribeEvents(client, {
      sessionId: opts.sessionId,
      ...(opts.directory !== undefined ? { directory: opts.directory } : {}),
      signal: controller.signal,
    });

    // Prime the stream before checking status, so a session that goes idle
    // between subscribe and check does not leave us waiting forever.
    const iterator = events[Symbol.asyncIterator]();
    const firstEvent = iterator.next();

    // Give the session a chance to pick the prompt up. Without this, an idle
    // reading here means "has not started", not "has finished".
    if (startupGrace > 0) {
      const started = await waitForBusy(client, opts.sessionId, opts.directory, startupGrace, controller.signal);
      if (!started) {
        log.debug(
          `session ${opts.sessionId} never became busy within ${startupGrace}ms — treating as no work to do`,
        );
        return;
      }
    }

    const status = await getStatusSafely(client, opts.sessionId, opts.directory);
    if (status === "idle") {
      log.debug(`session ${opts.sessionId} already idle`);
      return;
    }

    for (let next = await firstEvent; !next.done; next = await iterator.next()) {
      const event = next.value;
      if (opts.onEvent) await opts.onEvent(event);

      if (event.kind === "idle") {
        log.debug(`session ${opts.sessionId} idle`);
        return;
      }
      if (event.kind === "status" && event.status === "idle") {
        log.debug(`session ${opts.sessionId} status idle`);
        return;
      }
    }

    // The generator only completes once its signal is aborted.
    if (timedOut) throw new StageTimeoutError(stageId, timeoutMs);
    if (opts.signal?.aborted) return;
    throw new OpencodeError("event stream ended before session went idle");
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
    controller.abort();
  }
}

/**
 * Poll until the session reports busy, or the grace period expires.
 *
 * Returns false when it never started, which means there was nothing to wait
 * for — either the prompt was rejected, or the agent had no work to do.
 */
async function waitForBusy(
  client: OpencodeClient,
  sessionId: string,
  directory: string | undefined,
  graceMs: number,
  signal: AbortSignal,
): Promise<boolean> {
  const deadline = Date.now() + graceMs;
  const interval = 100;

  while (Date.now() < deadline) {
    if (signal.aborted) return false;
    const status = await getStatusSafely(client, sessionId, directory);
    if (status !== "idle") return true;
    await sleep(interval, signal);
  }

  return false;
}

async function getStatusSafely(
  client: OpencodeClient,
  sessionId: string,
  directory?: string,
): Promise<"idle" | "busy" | "retry"> {
  try {
    const result = await client.session.status(directory !== undefined ? { directory } : {});
    const map = (result.data ?? {}) as Record<string, { type?: string } | undefined>;
    const type = map[sessionId]?.type;
    return type === "busy" || type === "retry" ? type : "idle";
  } catch {
    // If status is unavailable, fall back to waiting for the event.
    return "busy";
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
