/**
 * Question and permission requests — the human-in-the-loop primitives.
 *
 * A collaborative gate is implemented by asking the agent to use OpenCode's
 * built-in `question` tool: the session blocks, the TUI shows a picker, and
 * the human answers there. The controller watches the same request so it can
 * act on the answer — and, when a gate is released another way (the
 * `/approve` command), answer the pending question itself so the session does
 * not stay blocked.
 */

import type { OpencodeClient } from "@opencode-ai/sdk/v2";

import { OpencodeError } from "../utils/errors.js";
import { log } from "../utils/logger.js";

export interface PendingQuestion {
  requestID: string;
  sessionID: string;
  questions: Array<{
    question: string;
    header: string;
    options: Array<{ label: string; description?: string }>;
    multiple?: boolean;
  }>;
}

/** List questions currently awaiting an answer. */
export async function listQuestions(
  client: OpencodeClient,
  directory?: string,
): Promise<PendingQuestion[]> {
  try {
    const result = await client.question.list(directory !== undefined ? { directory } : {});
    const data = result.data;
    if (!Array.isArray(data)) return [];
    return data as unknown as PendingQuestion[];
  } catch (err) {
    log.debug(`question list failed: ${String(err)}`);
    return [];
  }
}

/**
 * Answer a question.
 *
 * `answers` is one array of selected labels per question in the request.
 * First responder wins: if the human already answered in the TUI, this call
 * fails harmlessly and we treat it as already-handled.
 */
export async function replyToQuestion(
  client: OpencodeClient,
  opts: { requestID: string; answers: string[][]; directory?: string },
): Promise<boolean> {
  try {
    const result = await client.question.reply({
      requestID: opts.requestID,
      ...(opts.directory !== undefined ? { directory: opts.directory } : {}),
      answers: opts.answers,
    });
    if (result.error) {
      log.debug(`question reply rejected: ${JSON.stringify(result.error)}`);
      return false;
    }
    return true;
  } catch (err) {
    log.debug(`question reply failed: ${String(err)}`);
    return false;
  }
}

/** Reject a question outright. */
export async function rejectQuestion(
  client: OpencodeClient,
  opts: { requestID: string; directory?: string },
): Promise<boolean> {
  try {
    const result = await client.question.reject({
      requestID: opts.requestID,
      ...(opts.directory !== undefined ? { directory: opts.directory } : {}),
    });
    return !result.error;
  } catch (err) {
    log.debug(`question reject failed: ${String(err)}`);
    return false;
  }
}

export interface PendingPermission {
  requestID: string;
  sessionID: string;
  permission: string;
  patterns?: string[];
}

/** List permission requests currently awaiting a decision. */
export async function listPermissions(
  client: OpencodeClient,
  directory?: string,
): Promise<PendingPermission[]> {
  try {
    const result = await client.permission.list(directory !== undefined ? { directory } : {});
    const data = result.data;
    if (!Array.isArray(data)) return [];
    return data as unknown as PendingPermission[];
  } catch (err) {
    log.debug(`permission list failed: ${String(err)}`);
    return [];
  }
}

/**
 * Respond to a permission request.
 *
 * Autonomous mode uses this to keep a run moving without a human present.
 * It is deliberately explicit rather than a blanket `--auto`: the caller
 * decides which permissions are safe to grant.
 */
export async function replyToPermission(
  client: OpencodeClient,
  opts: {
    requestID: string;
    reply: "once" | "always" | "reject";
    message?: string;
    directory?: string;
  },
): Promise<void> {
  const result = await client.permission.reply({
    requestID: opts.requestID,
    ...(opts.directory !== undefined ? { directory: opts.directory } : {}),
    reply: opts.reply,
    ...(opts.message !== undefined ? { message: opts.message } : {}),
  });

  if (result.error) {
    throw new OpencodeError(`permission reply failed: ${JSON.stringify(result.error)}`);
  }
}
