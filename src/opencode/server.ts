/**
 * OpenCode server lifecycle and client construction.
 *
 * paper-run drives OpenCode as an agent runtime while the user works in
 * OpenCode's own TUI. Both attach to the same server and the same session,
 * so the controller's prompts and the user's messages land in one transcript.
 *
 * We use the **v2 client** throughout. v1 and v2 both expose session CRUD,
 * but only the v2 event stream carries `question.asked` — the event the gate
 * mechanism (M1-6) depends on for human-in-the-loop approval.
 */

import { createOpencodeClient, createOpencodeServer } from "@opencode-ai/sdk/v2";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";

import { OPENCODE_DEFAULTS } from "../utils/constants.js";
import { OpencodeError } from "../utils/errors.js";
import { log } from "../utils/logger.js";

/** A running OpenCode server owned by this process. */
export interface ServerHandle {
  url: string;
  /** Shuts the server down. Safe to call more than once. */
  close(): void;
  /** True when paper-run started this server (and must therefore stop it). */
  owned: boolean;
}

/**
 * Start an OpenCode server.
 *
 * The SDK spawns the process and resolves once it is listening, so no
 * additional health polling is needed here.
 */
export async function startServer(opts: {
  port?: number;
  hostname?: string;
  timeoutMs?: number;
} = {}): Promise<ServerHandle> {
  const port = opts.port ?? OPENCODE_DEFAULTS.port;
  const hostname = opts.hostname ?? OPENCODE_DEFAULTS.hostname;
  const timeout = opts.timeoutMs ?? OPENCODE_DEFAULTS.startupTimeoutMs;

  log.debug(`starting opencode server on ${hostname}:${port || "(auto)"}`);

  try {
    const server = await createOpencodeServer({ hostname, port, timeout });
    log.debug(`opencode server listening at ${server.url}`);
    return { url: server.url, close: () => server.close(), owned: true };
  } catch (err) {
    throw new OpencodeError("failed to start server", {
      hint: "Check that `opencode` is installed and on PATH (`opencode --version`).",
      cause: err,
    });
  }
}

/** Build a client for a server that is already running. */
export function connectToServer(baseUrl: string, directory: string): OpencodeClient {
  return createOpencodeClient({ baseUrl, directory });
}

/**
 * Probe a server URL. Used to decide whether a recorded session can be
 * reused or whether its `session.json` is stale and should be discarded.
 */
export async function isServerAlive(baseUrl: string, timeoutMs = 2_000): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(new URL("/global/health", baseUrl), {
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Attach to an existing server, or start a new one if none is reachable. */
export async function connectOrStart(opts: {
  directory: string;
  existingUrl?: string | undefined;
  port?: number | undefined;
}): Promise<{ client: OpencodeClient; server: ServerHandle }> {
  if (opts.existingUrl && (await isServerAlive(opts.existingUrl))) {
    log.debug(`reusing opencode server at ${opts.existingUrl}`);
    return {
      client: connectToServer(opts.existingUrl, opts.directory),
      // Not ours: never shut it down on exit.
      server: { url: opts.existingUrl, close: () => {}, owned: false },
    };
  }

  const server = await startServer(opts.port !== undefined ? { port: opts.port } : {});
  return { client: connectToServer(server.url, opts.directory), server };
}
