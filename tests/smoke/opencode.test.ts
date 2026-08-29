/**
 * Smoke tests against a real OpenCode.
 *
 * Everything else in the suite mocks the agent runtime. These do not: they
 * start a real `opencode serve`, create a real session, and drive a real
 * model. That makes them slow, non-deterministic, and dependent on
 * credentials, which is why they are opt-in (`npm run test:smoke`) rather
 * than part of `npm test`.
 *
 * They exist because the mocks encode assumptions about OpenCode's API, and
 * assumptions drift. Three of the bugs found while building paper-run were
 * exactly that: a plugin hook that is never dispatched, an SDK type that no
 * longer matches the runtime, and an event whose payload the mock did not
 * carry. Only real traffic catches that class of problem.
 *
 * They skip rather than fail when OpenCode is missing or unauthenticated, so
 * a contributor without credentials still sees a green suite — but the skip
 * is loud, and PAPER_RUN_REQUIRE_SMOKE=1 turns it into a failure for CI.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execa, execaSync } from "execa";
import { join } from "node:path";

import { startServer, connectToServer } from "../../src/opencode/server.js";
import type { ServerHandle } from "../../src/opencode/server.js";
import {
  createSession,
  sessionExists,
  sendPrompt,
  getSessionStatus,
} from "../../src/opencode/session.js";
import { waitForIdle, subscribeEvents } from "../../src/opencode/events.js";
import { makeTmpDir, cleanupTmp } from "../integration/fixtures.js";

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

/**
 * Detected synchronously at module load, NOT in beforeAll.
 *
 * `describe.skipIf()` is evaluated while vitest collects the file, which
 * happens before any hook runs — a flag assigned in beforeAll would still be
 * false here, silently skipping every test even on a machine where OpenCode
 * works perfectly.
 */
function detectAvailability(): { ok: boolean; why: string } {
  try {
    execaSync("opencode", ["--version"]);
  } catch {
    return { ok: false, why: "opencode is not on PATH" };
  }

  // A model must be reachable, or every prompt fails on send. An empty list
  // means credentials are missing even though the binary is present.
  try {
    const { stdout } = execaSync("opencode", ["models"], { reject: false });
    if (stdout.trim().length === 0) {
      return { ok: false, why: "no models are reachable (not authenticated?)" };
    }
  } catch {
    return { ok: false, why: "could not list models" };
  }

  return { ok: true, why: "" };
}

const availability = detectAvailability();
const available = availability.ok;
const required = process.env["PAPER_RUN_REQUIRE_SMOKE"] === "1";

if (!available) {
  if (required) {
    throw new Error(
      `Smoke tests are required (PAPER_RUN_REQUIRE_SMOKE=1) but ${availability.why}.`,
    );
  }
  // Loud, so a skipped tier is never mistaken for a passing one.
  console.warn(
    `\n  [smoke] SKIPPED: ${availability.why}.\n` +
      `  Run \`opencode auth login\` to enable these tests.\n`,
  );
}

let workspace: string;
let server: ServerHandle | undefined;

beforeAll(() => {
  if (!available) return;
  workspace = makeTmpDir("paper-run-smoke-");
});

afterAll(async () => {
  server?.close();
  if (workspace) cleanupTmp(workspace);
});

// ---------------------------------------------------------------------------
// The API surface the controller depends on
// ---------------------------------------------------------------------------

describe.skipIf(!available)("OpenCode server and session", () => {
  it("starts a server and reports healthy", async () => {
    server = await startServer({ port: 0 });
    expect(server.url).toMatch(/^https?:\/\//);

    const res = await fetch(new URL("/global/health", server.url));
    expect(res.ok).toBe(true);

    const body = (await res.json()) as { healthy?: boolean; version?: string };
    expect(body.healthy).toBe(true);
  }, 60_000);

  it("creates a session that then exists", async () => {
    const client = connectToServer(server!.url, workspace);

    const sessionId = await createSession(client, {
      title: "paper-run smoke",
      directory: workspace,
    });

    expect(sessionId).toMatch(/^ses/);
    expect(await sessionExists(client, sessionId, workspace)).toBe(true);
  }, 60_000);

  it("reports a brand-new session as idle", async () => {
    const client = connectToServer(server!.url, workspace);
    const sessionId = await createSession(client, { title: "idle check", directory: workspace });

    expect(await getSessionStatus(client, sessionId, workspace)).toBe("idle");
  }, 60_000);

  it("delivers events on the stream the controller subscribes to", async () => {
    // The controller's whole notion of "the turn is over" rests on this
    // stream carrying session.idle, so it is worth proving against a real
    // server rather than a generator.
    const client = connectToServer(server!.url, workspace);
    const ac = new AbortController();

    const seen: string[] = [];
    const collector = (async () => {
      for await (const event of subscribeEvents(client, {
        directory: workspace,
        signal: ac.signal,
      })) {
        seen.push(event.kind);
        if (seen.length >= 1) break;
      }
    })();

    // Any activity produces events; creating a session is enough.
    await createSession(client, { title: "event check", directory: workspace });

    await Promise.race([collector, new Promise((r) => setTimeout(r, 15_000))]);
    ac.abort();

    expect(seen.length).toBeGreaterThan(0);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// A real agent turn
// ---------------------------------------------------------------------------

describe.skipIf(!available)("a real agent turn", () => {
  it("completes a prompt and goes idle", async () => {
    // The narrowest possible real turn: prove that sendPrompt followed by
    // waitForIdle terminates, which is the loop the controller runs 13 times.
    const client = connectToServer(server!.url, workspace);
    const sessionId = await createSession(client, {
      title: "smoke turn",
      directory: workspace,
    });

    await sendPrompt(client, {
      sessionId,
      text: "Reply with exactly the word: ready. Do not use any tools.",
      directory: workspace,
    });

    await waitForIdle(client, {
      sessionId,
      directory: workspace,
      timeoutMs: 180_000,
      stageId: "smoke",
    });

    expect(await getSessionStatus(client, sessionId, workspace)).toBe("idle");
  }, 300_000);
});

// ---------------------------------------------------------------------------
// The CLI, installed
// ---------------------------------------------------------------------------

describe("the built CLI", () => {
  const cli = join(process.cwd(), "dist", "cli.js");

  it("reports its version", async () => {
    const result = await execa("node", [cli, "--version"], { reject: false });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("lists the commands a user needs", async () => {
    const result = await execa("node", [cli, "--help"], { reject: false });
    expect(result.exitCode).toBe(0);
    for (const command of ["init", "start", "status", "mode", "resume"]) {
      expect(result.stdout, command).toContain(command);
    }
  });

  it("refuses to run outside a project, with a usable hint", async () => {
    const dir = makeTmpDir("paper-run-outside-");
    try {
      const result = await execa("node", [cli, "status"], { cwd: dir, reject: false });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Not a paper-run project");
      expect(result.stderr).toContain("paper-run init");
    } finally {
      cleanupTmp(dir);
    }
  });
});
