/**
 * Attaching a run to a server + session, including reuse and concurrency.
 *
 * `.paper-run/session.json` records the server URL, session id, and owning
 * PID. It is the handshake that lets a second `paper-run start` reuse a live
 * run instead of starting a competing one — and lets us detect a stale record
 * left behind by a crash.
 */

import type { OpencodeClient } from "@opencode-ai/sdk/v2";

import { readSessionState, writeSessionState, clearSessionState } from "../state/store.js";
import type { SessionState } from "../state/schema.js";
import { ConcurrentRunError } from "../utils/errors.js";
import { log } from "../utils/logger.js";

import { connectOrStart, isServerAlive } from "./server.js";
import type { ServerHandle } from "./server.js";
import { createSession, sessionExists } from "./session.js";

/** True when a process with this PID is running. */
export function isProcessAlive(pid: number): boolean {
  try {
    // Signal 0 performs permission/existence checks without delivering.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but belongs to another user.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Refuse to start when another live paper-run process owns this project.
 *
 * A record whose PID is dead is stale (previous crash) and gets cleared.
 */
export function assertNoConcurrentRun(projectDir: string): void {
  const existing = readSessionState(projectDir);
  if (!existing?.pid) return;

  if (existing.pid === process.pid) return;

  if (isProcessAlive(existing.pid)) {
    throw new ConcurrentRunError(existing.pid);
  }

  log.debug(`clearing stale session.json from dead PID ${existing.pid}`);
  clearSessionState(projectDir);
}

export interface AttachedRun {
  client: OpencodeClient;
  server: ServerHandle;
  sessionId: string;
  /** True when this invocation created the session (rather than resuming one). */
  fresh: boolean;
}

/**
 * Connect a project to an OpenCode session, reusing what is still alive.
 *
 * Order of preference:
 *   1. recorded server + recorded session, both still valid  → resume
 *   2. recorded/new server, session gone                     → new session
 *   3. no server reachable                                   → start one
 */
export async function attachRun(opts: {
  projectDir: string;
  runId: string;
  mode: string;
  port?: number | undefined;
  sessionIdOverride?: string | undefined;
}): Promise<AttachedRun> {
  assertNoConcurrentRun(opts.projectDir);

  const recorded = readSessionState(opts.projectDir);
  const recordedUrl =
    recorded && (await isServerAlive(recorded.server_url)) ? recorded.server_url : undefined;

  const { client, server } = await connectOrStart({
    directory: opts.projectDir,
    existingUrl: recordedUrl,
    port: opts.port,
  });

  const candidateId = opts.sessionIdOverride ?? recorded?.session_id;
  let sessionId: string;
  let fresh: boolean;

  if (candidateId && (await sessionExists(client, candidateId, opts.projectDir))) {
    sessionId = candidateId;
    fresh = false;
    log.debug(`resuming session ${sessionId}`);
  } else {
    if (candidateId) log.debug(`session ${candidateId} is gone; creating a new one`);
    sessionId = await createSession(client, {
      title: `paper-run [${opts.mode}] ${opts.runId}`,
      directory: opts.projectDir,
    });
    fresh = true;
  }

  const state: SessionState = {
    schema_version: "paper-run-session-v1",
    server_url: server.url,
    session_id: sessionId,
    created_at: recorded?.created_at ?? new Date().toISOString(),
    pid: process.pid,
  };
  writeSessionState(opts.projectDir, state);

  return { client, server, sessionId, fresh };
}

/**
 * Release a run's hold on the project.
 *
 * Servers we started are stopped. Servers we merely attached to are left
 * running, and the session record is kept so the next invocation can resume.
 */
export function detachRun(opts: { projectDir: string; server: ServerHandle }): void {
  if (opts.server.owned) {
    log.debug("stopping opencode server owned by this run");
    opts.server.close();
    clearSessionState(opts.projectDir);
  }
}
