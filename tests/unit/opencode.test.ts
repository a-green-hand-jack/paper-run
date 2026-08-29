import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { classifyEvent, waitForIdle } from "../../src/opencode/events.js";
import type { RelevantEvent } from "../../src/opencode/events.js";
import {
  createSession,
  sessionExists,
  sendPrompt,
  abortSession,
  getSessionStatus,
  showToast,
} from "../../src/opencode/session.js";
import {
  listQuestions,
  replyToQuestion,
  rejectQuestion,
  listPermissions,
  replyToPermission,
} from "../../src/opencode/interaction.js";
import { isProcessAlive, assertNoConcurrentRun } from "../../src/opencode/attach.js";
import { writeSessionState } from "../../src/state/store.js";
import { OpencodeError, ConcurrentRunError } from "../../src/utils/errors.js";

// ---------------------------------------------------------------------------
// Mock client helpers
// ---------------------------------------------------------------------------

function ok<T>(data: T) {
  return Promise.resolve({ data, error: undefined });
}
function fail(error: unknown) {
  return Promise.resolve({ data: undefined, error });
}

/** Build a mock v2 OpencodeClient with only the bits under test. */
function mockClient(overrides: Record<string, unknown> = {}): any {
  return {
    session: {
      create: vi.fn(() => ok({ id: "ses_new" })),
      get: vi.fn(() => ok({ id: "ses_existing" })),
      promptAsync: vi.fn(() => ok({})),
      abort: vi.fn(() => ok({})),
      status: vi.fn(() => ok({})),
      ...(overrides["session"] as object ?? {}),
    },
    event: {
      subscribe: vi.fn(() => Promise.resolve({ stream: emptyStream() })),
      ...(overrides["event"] as object ?? {}),
    },
    question: {
      list: vi.fn(() => ok([])),
      reply: vi.fn(() => ok(true)),
      reject: vi.fn(() => ok(true)),
      ...(overrides["question"] as object ?? {}),
    },
    permission: {
      list: vi.fn(() => ok([])),
      reply: vi.fn(() => ok(true)),
      ...(overrides["permission"] as object ?? {}),
    },
    tui: {
      showToast: vi.fn(() => ok(true)),
      ...(overrides["tui"] as object ?? {}),
    },
  };
}

async function* emptyStream(): AsyncGenerator<never> {
  // Yields nothing and ends immediately.
}

function streamOf(events: unknown[]): () => AsyncGenerator<unknown> {
  return async function* () {
    for (const e of events) yield e;
  };
}

// ---------------------------------------------------------------------------
// classifyEvent
// ---------------------------------------------------------------------------

describe("classifyEvent", () => {
  it("classifies session.idle", () => {
    const e = classifyEvent({ type: "session.idle", properties: { sessionID: "ses_1" } } as any);
    expect(e.kind).toBe("idle");
    expect((e as Extract<RelevantEvent, { kind: "idle" }>).sessionID).toBe("ses_1");
  });

  it("classifies session.status busy", () => {
    const e = classifyEvent({
      type: "session.status",
      properties: { sessionID: "ses_1", status: { type: "busy" } },
    } as any);
    expect(e).toMatchObject({ kind: "status", status: "busy" });
  });

  it("treats unknown status type as idle", () => {
    const e = classifyEvent({
      type: "session.status",
      properties: { sessionID: "ses_1", status: {} },
    } as any);
    expect(e).toMatchObject({ kind: "status", status: "idle" });
  });

  it("classifies question.asked (v1 name)", () => {
    const e = classifyEvent({
      type: "question.asked",
      properties: { id: "que_1", sessionID: "ses_1", questions: [] },
    } as any);
    expect(e).toMatchObject({ kind: "question", requestID: "que_1", sessionID: "ses_1" });
  });

  it("classifies question.v2.asked to the same kind", () => {
    const e = classifyEvent({
      type: "question.v2.asked",
      properties: { id: "que_2", sessionID: "ses_1" },
    } as any);
    expect(e).toMatchObject({ kind: "question", requestID: "que_2" });
  });

  it("classifies question.replied using requestID", () => {
    const e = classifyEvent({
      type: "question.replied",
      properties: { requestID: "que_3", sessionID: "ses_1" },
    } as any);
    expect(e).toMatchObject({ kind: "question-replied", requestID: "que_3" });
  });

  it("classifies question.rejected", () => {
    const e = classifyEvent({
      type: "question.rejected",
      properties: { requestID: "que_4", sessionID: "ses_1" },
    } as any);
    expect(e).toMatchObject({ kind: "question-rejected", requestID: "que_4" });
  });

  it("classifies permission.asked", () => {
    const e = classifyEvent({
      type: "permission.asked",
      properties: { id: "per_1", sessionID: "ses_1", permission: "bash" },
    } as any);
    expect(e).toMatchObject({ kind: "permission", requestID: "per_1", permission: "bash" });
  });

  it("classifies session.error", () => {
    const e = classifyEvent({
      type: "session.error",
      properties: { sessionID: "ses_1", message: "boom" },
    } as any);
    expect(e.kind).toBe("error");
  });

  it("falls through to other", () => {
    const e = classifyEvent({ type: "file.edited", properties: { file: "a.tex" } } as any);
    expect(e).toMatchObject({ kind: "other", type: "file.edited" });
  });
});

// ---------------------------------------------------------------------------
// session helpers
// ---------------------------------------------------------------------------

describe("createSession", () => {
  it("returns the new session id", async () => {
    const client = mockClient();
    const id = await createSession(client, { title: "test", directory: "/tmp/x" });
    expect(id).toBe("ses_new");
    expect(client.session.create).toHaveBeenCalledWith(
      expect.objectContaining({ title: "test", directory: "/tmp/x" }),
    );
  });

  it("throws OpencodeError when the API returns an error", async () => {
    const client = mockClient({ session: { create: vi.fn(() => fail({ message: "nope" })) } });
    await expect(createSession(client, { title: "t" })).rejects.toThrow(OpencodeError);
  });

  it("throws when no id comes back", async () => {
    const client = mockClient({ session: { create: vi.fn(() => ok({})) } });
    await expect(createSession(client, { title: "t" })).rejects.toThrow(OpencodeError);
  });
});

describe("sessionExists", () => {
  it("is true when get succeeds", async () => {
    const client = mockClient();
    expect(await sessionExists(client, "ses_1")).toBe(true);
  });

  it("is false when get errors", async () => {
    const client = mockClient({ session: { get: vi.fn(() => fail({ code: 404 })) } });
    expect(await sessionExists(client, "ses_1")).toBe(false);
  });

  it("is false when get throws", async () => {
    const client = mockClient({
      session: { get: vi.fn(() => Promise.reject(new Error("network"))) },
    });
    expect(await sessionExists(client, "ses_1")).toBe(false);
  });
});

describe("sendPrompt", () => {
  it("sends a text part to the session", async () => {
    const client = mockClient();
    await sendPrompt(client, { sessionId: "ses_1", text: "do the thing", agent: "paper-writer" });
    expect(client.session.promptAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionID: "ses_1",
        agent: "paper-writer",
        parts: [{ type: "text", text: "do the thing" }],
      }),
    );
  });

  it("throws on API error", async () => {
    const client = mockClient({ session: { promptAsync: vi.fn(() => fail({ m: 1 })) } });
    await expect(sendPrompt(client, { sessionId: "s", text: "t" })).rejects.toThrow(OpencodeError);
  });
});

describe("abortSession", () => {
  it("swallows errors so the interrupt path stays clean", async () => {
    const client = mockClient({
      session: { abort: vi.fn(() => Promise.reject(new Error("gone"))) },
    });
    await expect(abortSession(client, "ses_1")).resolves.toBeUndefined();
  });
});

describe("getSessionStatus", () => {
  it("reports busy when the map says so", async () => {
    const client = mockClient({
      session: { status: vi.fn(() => ok({ ses_1: { type: "busy" } })) },
    });
    expect(await getSessionStatus(client, "ses_1")).toBe("busy");
  });

  it("reports idle when the session is absent from the map", async () => {
    const client = mockClient({ session: { status: vi.fn(() => ok({})) } });
    expect(await getSessionStatus(client, "ses_1")).toBe("idle");
  });
});

describe("showToast", () => {
  it("never throws when no TUI is attached", async () => {
    const client = mockClient({
      tui: { showToast: vi.fn(() => Promise.reject(new Error("no tui"))) },
    });
    await expect(showToast(client, { message: "hi" })).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// waitForIdle
// ---------------------------------------------------------------------------

describe("waitForIdle", () => {
  it("returns immediately when the session is already idle", async () => {
    const client = mockClient({ session: { status: vi.fn(() => ok({})) } });
    await expect(
      waitForIdle(client, { sessionId: "ses_1", timeoutMs: 1000 }),
    ).resolves.toBeUndefined();
  });

  it("resolves when an idle event arrives", async () => {
    const client = mockClient({
      session: { status: vi.fn(() => ok({ ses_1: { type: "busy" } })) },
      event: {
        subscribe: vi.fn(() =>
          Promise.resolve({
            stream: streamOf([
              { type: "session.status", properties: { sessionID: "ses_1", status: { type: "busy" } } },
              { type: "session.idle", properties: { sessionID: "ses_1" } },
            ])(),
          }),
        ),
      },
    });

    await expect(
      waitForIdle(client, { sessionId: "ses_1", timeoutMs: 2000 }),
    ).resolves.toBeUndefined();
  });

  it("invokes onEvent for events seen while waiting", async () => {
    const seen: RelevantEvent[] = [];
    const client = mockClient({
      session: { status: vi.fn(() => ok({ ses_1: { type: "busy" } })) },
      event: {
        subscribe: vi.fn(() =>
          Promise.resolve({
            stream: streamOf([
              { type: "question.asked", properties: { id: "que_1", sessionID: "ses_1" } },
              { type: "session.idle", properties: { sessionID: "ses_1" } },
            ])(),
          }),
        ),
      },
    });

    await waitForIdle(client, {
      sessionId: "ses_1",
      timeoutMs: 2000,
      onEvent: (e) => {
        seen.push(e);
      },
    });

    expect(seen.some((e) => e.kind === "question")).toBe(true);
  });

  it("ignores events from other sessions", async () => {
    const seen: RelevantEvent[] = [];
    const client = mockClient({
      session: { status: vi.fn(() => ok({ ses_1: { type: "busy" } })) },
      event: {
        subscribe: vi.fn(() =>
          Promise.resolve({
            stream: streamOf([
              { type: "question.asked", properties: { id: "que_OTHER", sessionID: "ses_OTHER" } },
              { type: "session.idle", properties: { sessionID: "ses_OTHER" } },
              { type: "question.asked", properties: { id: "que_MINE", sessionID: "ses_1" } },
              { type: "session.idle", properties: { sessionID: "ses_1" } },
            ])(),
          }),
        ),
      },
    });

    await waitForIdle(client, {
      sessionId: "ses_1",
      timeoutMs: 2000,
      onEvent: (e) => {
        seen.push(e);
      },
    });

    // Only our session's events are delivered. The foreign question and the
    // foreign idle are both filtered out — the latter would otherwise have
    // ended the wait before our own events arrived.
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({ kind: "question", requestID: "que_MINE" });
    expect(seen[1]).toMatchObject({ kind: "idle", sessionID: "ses_1" });
  });
});

// ---------------------------------------------------------------------------
// interaction
// ---------------------------------------------------------------------------

describe("questions", () => {
  it("lists pending questions", async () => {
    const client = mockClient({
      question: { list: vi.fn(() => ok([{ requestID: "que_1", sessionID: "s", questions: [] }])) },
    });
    const qs = await listQuestions(client);
    expect(qs).toHaveLength(1);
  });

  it("returns empty list when the call fails", async () => {
    const client = mockClient({
      question: { list: vi.fn(() => Promise.reject(new Error("down"))) },
    });
    expect(await listQuestions(client)).toEqual([]);
  });

  it("replies with per-question answer arrays", async () => {
    const client = mockClient();
    const okReply = await replyToQuestion(client, {
      requestID: "que_1",
      answers: [["Approve and continue"]],
    });
    expect(okReply).toBe(true);
    expect(client.question.reply).toHaveBeenCalledWith(
      expect.objectContaining({ requestID: "que_1", answers: [["Approve and continue"]] }),
    );
  });

  it("returns false when the human already answered", async () => {
    const client = mockClient({
      question: { reply: vi.fn(() => fail({ _tag: "QuestionNotFoundError" })) },
    });
    expect(await replyToQuestion(client, { requestID: "que_1", answers: [["x"]] })).toBe(false);
  });

  it("rejects a question", async () => {
    const client = mockClient();
    expect(await rejectQuestion(client, { requestID: "que_1" })).toBe(true);
  });
});

describe("permissions", () => {
  it("lists pending permissions", async () => {
    const client = mockClient({
      permission: {
        list: vi.fn(() => ok([{ requestID: "per_1", sessionID: "s", permission: "bash" }])),
      },
    });
    expect(await listPermissions(client)).toHaveLength(1);
  });

  it("replies once", async () => {
    const client = mockClient();
    await replyToPermission(client, { requestID: "per_1", reply: "once" });
    expect(client.permission.reply).toHaveBeenCalledWith(
      expect.objectContaining({ requestID: "per_1", reply: "once" }),
    );
  });

  it("throws when the reply is refused", async () => {
    const client = mockClient({ permission: { reply: vi.fn(() => fail({ code: 404 })) } });
    await expect(
      replyToPermission(client, { requestID: "per_1", reply: "once" }),
    ).rejects.toThrow(OpencodeError);
  });
});

// ---------------------------------------------------------------------------
// concurrency guard
// ---------------------------------------------------------------------------

describe("isProcessAlive", () => {
  it("is true for the current process", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it("is false for an unused PID", () => {
    // PIDs are recycled, but this one is reserved-ish and reliably absent.
    expect(isProcessAlive(0x7fffffff)).toBe(false);
  });
});

describe("assertNoConcurrentRun", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "paper-run-attach-"));
    mkdirSync(join(tmpDir, ".paper-run"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("passes when there is no session record", () => {
    expect(() => assertNoConcurrentRun(tmpDir)).not.toThrow();
  });

  it("passes when the recorded PID is our own", () => {
    writeSessionState(tmpDir, {
      schema_version: "paper-run-session-v1",
      server_url: "http://127.0.0.1:4096",
      session_id: "ses_1",
      created_at: new Date().toISOString(),
      pid: process.pid,
    });
    expect(() => assertNoConcurrentRun(tmpDir)).not.toThrow();
  });

  it("throws when another live process owns the project", () => {
    writeSessionState(tmpDir, {
      schema_version: "paper-run-session-v1",
      server_url: "http://127.0.0.1:4096",
      session_id: "ses_1",
      created_at: new Date().toISOString(),
      // Our parent is alive and is not us.
      pid: process.ppid,
    });
    expect(() => assertNoConcurrentRun(tmpDir)).toThrow(ConcurrentRunError);
  });

  it("clears a stale record left by a dead process", () => {
    writeSessionState(tmpDir, {
      schema_version: "paper-run-session-v1",
      server_url: "http://127.0.0.1:4096",
      session_id: "ses_1",
      created_at: new Date().toISOString(),
      pid: 0x7fffffff,
    });
    expect(() => assertNoConcurrentRun(tmpDir)).not.toThrow();
    // Record is gone, so a second call is also fine.
    expect(() => assertNoConcurrentRun(tmpDir)).not.toThrow();
  });
});
