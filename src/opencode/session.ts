/**
 * Session lifecycle: create, resume, prompt, abort, and TUI attach.
 *
 * Writer stages and human gates use the run's long-lived OpenCode session.
 * Independent reviews use a newly created cold session for every attempt.
 */

import { isAbsolute, join, relative, resolve, sep } from "node:path";

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

// ---------------------------------------------------------------------------
// What the turn actually read
// ---------------------------------------------------------------------------

/** Tools whose input names a file the agent opened. */
const READ_TOOLS = new Set(["read", "view", "cat", "readfile", "read_file"]);

/** Input keys OpenCode tools use for the path they operate on. */
const PATH_KEYS = ["filePath", "file_path", "path", "file"] as const;

/**
 * Collect the project files an agent read during a session.
 *
 * paper-run points every stage at an owner skill and lets the skill point on
 * to its own references. Nothing verified that the chain was ever walked: a
 * turn that ignored `section-writing` and wrote from the model's priors looked
 * exactly like one that followed it. Reading the transcript back is the
 * cheapest way to tell the difference, and `session.messages` is already
 * fetched for token accounting.
 *
 * Best-effort by construction. The transcript shape is OpenCode's, not ours,
 * so every access is defensive and an unrecognised part is skipped rather than
 * throwing — a telemetry gap must never fail a stage.
 */
export async function getSessionReads(
  client: OpencodeClient,
  sessionId: string,
  opts: { timeoutMs?: number } = {},
): Promise<string[]> {
  const timeoutMs = opts.timeoutMs ?? 2_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      client.session.messages({ sessionID: sessionId }),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
    if (result === null || result.error || !result.data || !Array.isArray(result.data)) return [];

    const paths = new Set<string>();
    for (const projected of result.data) {
      const parts = (projected as { parts?: unknown }).parts;
      if (!Array.isArray(parts)) continue;
      for (const part of parts) {
        const path = readPathFromPart(part);
        if (path) paths.add(path);
      }
    }
    return [...paths].sort();
  } catch {
    return [];
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Pull the file path out of one transcript part, when it is a read call. */
function readPathFromPart(part: unknown): string | null {
  if (typeof part !== "object" || part === null) return null;
  const record = part as Record<string, unknown>;

  const tool = typeof record["tool"] === "string" ? record["tool"].toLowerCase() : undefined;
  if (!tool || !READ_TOOLS.has(tool)) return null;

  const state = record["state"];
  const input =
    typeof state === "object" && state !== null
      ? (state as Record<string, unknown>)["input"]
      : record["input"];
  if (typeof input !== "object" || input === null) return null;

  for (const key of PATH_KEYS) {
    const value = (input as Record<string, unknown>)[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return null;
}

/**
 * Narrow a read list to the project-relative paths inside it.
 *
 * Absolute paths under the project root become relative; anything outside the
 * project is dropped, both to keep the record portable across machines and to
 * avoid writing a user's home directory layout into a committed state file.
 */
export function relativizeReads(paths: readonly string[], projectDir: string): string[] {
  const root = resolve(projectDir);
  const out = new Set<string>();

  for (const path of paths) {
    const absolute = isAbsolute(path) ? path : join(root, path);
    const rel = relative(root, absolute);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) continue;
    out.add(rel.split(sep).join("/"));
  }

  return [...out].sort();
}

/** Prefixes that hold the harness's writing guidance rather than the paper. */
const GUIDANCE_PREFIXES = [".agents/skills/", ".agents/knowledge/", ".agents/vendor/"];

/** The guidance subset of a read list — the files a stage was pointed at. */
export function guidanceReads(paths: readonly string[]): string[] {
  return paths.filter((path) => GUIDANCE_PREFIXES.some((prefix) => path.startsWith(prefix)));
}
