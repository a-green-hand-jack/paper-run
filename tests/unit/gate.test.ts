/**
 * Gate mechanism tests.
 *
 * The gate is where the two operating modes differ, so these cover both that
 * the policy is honoured and that a waiting gate can be released from either
 * side — the TUI picker or the `/approve` command — without stranding the
 * agent on an unanswered question.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  evaluateGate,
  gateActionFor,
  decisionFromLabel,
  switchMode,
  GATE_CHOICES,
} from "../../src/controller/gate.js";
import { generateGatePreset } from "../../src/state/gate-presets.js";
import { writeRunState, readRunState, writeGatePolicy, readGatePolicy } from "../../src/state/store.js";
import type { RunState } from "../../src/state/schema.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeRunState(overrides: Partial<RunState> = {}): RunState {
  return {
    schema_version: "paper-run-v1",
    run_id: "abcd1234",
    run_branch: "paper-run/abcd1234",
    mode: "collaborative",
    current_stage: "paper_positioning",
    stage_status: "running",
    started_at: "2026-08-29T10:00:00.000Z",
    updated_at: "2026-08-29T10:00:00.000Z",
    template_version: "v0.3.0",
    ...overrides,
  };
}

function ok<T>(data: T) {
  return Promise.resolve({ data, error: undefined });
}

/** Mock client whose event stream yields a scripted sequence. */
function mockClient(events: unknown[] = [], overrides: Record<string, unknown> = {}): any {
  return {
    session: {
      promptAsync: vi.fn(() => ok({})),
      status: vi.fn(() => ok({})),
      ...(overrides["session"] as object ?? {}),
    },
    event: {
      subscribe: vi.fn(() =>
        Promise.resolve({
          stream: (async function* () {
            for (const e of events) {
              // Let the racing poller run between events.
              await new Promise((r) => setTimeout(r, 5));
              yield e;
            }
            // Then idle forever so the race is decided by the other side.
            await new Promise(() => {});
          })(),
        }),
      ),
      ...(overrides["event"] as object ?? {}),
    },
    question: {
      list: vi.fn(() => ok([])),
      reply: vi.fn(() => ok(true)),
      ...(overrides["question"] as object ?? {}),
    },
    tui: {
      showToast: vi.fn(() => ok(true)),
      ...(overrides["tui"] as object ?? {}),
    },
  };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "paper-run-gate-"));
  mkdirSync(join(tmpDir, ".paper-run"), { recursive: true });
  writeRunState(tmpDir, makeRunState());
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Policy lookup
// ---------------------------------------------------------------------------

describe("gateActionFor", () => {
  it("reads the configured action", () => {
    const policy = generateGatePreset("collaborative");
    expect(gateActionFor(policy, "paper_positioning")).toBe("await_human");
    expect(gateActionFor(policy, "evidence_inventory")).toBe("auto");
  });

  it("defaults an unknown stage to await_human, not auto", () => {
    // A stage the policy has never heard of is more likely version skew than
    // something safe to wave through unattended.
    const policy = generateGatePreset("autonomous");
    expect(gateActionFor(policy, "stage_from_the_future")).toBe("await_human");
  });
});

// ---------------------------------------------------------------------------
// Label mapping
// ---------------------------------------------------------------------------

describe("decisionFromLabel", () => {
  it("maps the three offered choices", () => {
    expect(decisionFromLabel(GATE_CHOICES.approve).outcome).toBe("proceed");
    expect(decisionFromLabel(GATE_CHOICES.revise).outcome).toBe("revise");
    expect(decisionFromLabel(GATE_CHOICES.stop).outcome).toBe("stop");
  });

  it("is case- and whitespace-insensitive", () => {
    expect(decisionFromLabel("  approve and continue  ").outcome).toBe("proceed");
  });

  it("treats a custom answer as guidance to revise, never as approval", () => {
    const decision = decisionFromLabel("please tighten the contribution claims");
    expect(decision.outcome).toBe("revise");
    expect(decision).toHaveProperty("guidance", "please tighten the contribution claims");
  });
});

// ---------------------------------------------------------------------------
// Autonomous / auto gates
// ---------------------------------------------------------------------------

describe("evaluateGate with an auto policy", () => {
  it("proceeds without prompting", async () => {
    const client = mockClient();
    const policy = generateGatePreset("autonomous");

    const decision = await evaluateGate(policy, {
      client,
      sessionId: "ses_1",
      projectDir: tmpDir,
      stageId: "paper_positioning",
    });

    expect(decision.outcome).toBe("proceed");
    expect(client.session.promptAsync).not.toHaveBeenCalled();
    expect(client.tui.showToast).not.toHaveBeenCalled();
  });

  it("proceeds for a skipped stage", async () => {
    const client = mockClient();
    const policy = generateGatePreset("autonomous");
    policy.gates["paper_positioning"] = { policy: "skip" };

    const decision = await evaluateGate(policy, {
      client,
      sessionId: "ses_1",
      projectDir: tmpDir,
      stageId: "paper_positioning",
    });

    expect(decision.outcome).toBe("proceed");
  });
});

// ---------------------------------------------------------------------------
// Collaborative gates — TUI route
// ---------------------------------------------------------------------------

describe("evaluateGate awaiting a human", () => {
  it("marks the run gate_waiting and asks the agent to raise a question", async () => {
    const client = mockClient([
      { type: "question.asked", properties: { id: "que_1", sessionID: "ses_1" } },
      {
        type: "question.replied",
        properties: { requestID: "que_1", sessionID: "ses_1", answers: [[GATE_CHOICES.approve]] },
      },
    ]);
    const policy = generateGatePreset("collaborative");

    const decision = await evaluateGate(policy, {
      client,
      sessionId: "ses_1",
      projectDir: tmpDir,
      stageId: "paper_positioning",
      pollIntervalMs: 50,
    });

    expect(decision.outcome).toBe("proceed");

    // The agent was asked to put the question, rather than the controller
    // fabricating one over the API.
    const prompt = client.session.promptAsync.mock.calls[0][0].parts[0].text;
    expect(prompt).toContain("`question` tool");
    expect(prompt).toContain(GATE_CHOICES.approve);
    expect(prompt).toContain(GATE_CHOICES.revise);
    expect(prompt).toContain(GATE_CHOICES.stop);

    expect(client.tui.showToast).toHaveBeenCalled();
    expect(readRunState(tmpDir).stage_status).toBe("approved");
  });

  it("returns revise when the human requests changes", async () => {
    const client = mockClient([
      { type: "question.asked", properties: { id: "que_1", sessionID: "ses_1" } },
      {
        type: "question.replied",
        properties: { requestID: "que_1", sessionID: "ses_1", answers: [[GATE_CHOICES.revise]] },
      },
    ]);

    const decision = await evaluateGate(generateGatePreset("collaborative"), {
      client,
      sessionId: "ses_1",
      projectDir: tmpDir,
      stageId: "paper_positioning",
      pollIntervalMs: 50,
    });

    expect(decision.outcome).toBe("revise");
    // A gate that did not open stays waiting, so a resume re-asks it.
    expect(readRunState(tmpDir).stage_status).toBe("gate_waiting");
  });

  it("returns stop when the human stops the run", async () => {
    const client = mockClient([
      { type: "question.asked", properties: { id: "que_1", sessionID: "ses_1" } },
      {
        type: "question.replied",
        properties: { requestID: "que_1", sessionID: "ses_1", answers: [[GATE_CHOICES.stop]] },
      },
    ]);

    const decision = await evaluateGate(generateGatePreset("collaborative"), {
      client,
      sessionId: "ses_1",
      projectDir: tmpDir,
      stageId: "paper_positioning",
      pollIntervalMs: 50,
    });

    expect(decision.outcome).toBe("stop");
  });

  it("treats a rejected question as a stop", async () => {
    const client = mockClient([
      { type: "question.asked", properties: { id: "que_1", sessionID: "ses_1" } },
      { type: "question.rejected", properties: { requestID: "que_1", sessionID: "ses_1" } },
    ]);

    const decision = await evaluateGate(generateGatePreset("collaborative"), {
      client,
      sessionId: "ses_1",
      projectDir: tmpDir,
      stageId: "paper_positioning",
      pollIntervalMs: 50,
    });

    expect(decision.outcome).toBe("stop");
  });

  it("ignores a reply to a question this gate did not raise", async () => {
    // A stale question from an earlier turn must not open this gate.
    const client = mockClient([
      {
        type: "question.replied",
        properties: { requestID: "que_STALE", sessionID: "ses_1", answers: [[GATE_CHOICES.approve]] },
      },
    ]);

    // Nothing will open the gate via the TUI, so let /approve win instead.
    setTimeout(() => {
      const state = readRunState(tmpDir);
      writeRunState(tmpDir, { ...state, stage_status: "approved" });
    }, 80);

    const decision = await evaluateGate(generateGatePreset("collaborative"), {
      client,
      sessionId: "ses_1",
      projectDir: tmpDir,
      stageId: "paper_positioning",
      pollIntervalMs: 20,
    });

    expect(decision.reason).toContain("/approve");
  });

  it("treats an empty selection as revise rather than approval", async () => {
    const client = mockClient([
      { type: "question.asked", properties: { id: "que_1", sessionID: "ses_1" } },
      {
        type: "question.replied",
        properties: { requestID: "que_1", sessionID: "ses_1", answers: [[]] },
      },
    ]);

    const decision = await evaluateGate(generateGatePreset("collaborative"), {
      client,
      sessionId: "ses_1",
      projectDir: tmpDir,
      stageId: "paper_positioning",
      pollIntervalMs: 50,
    });

    expect(decision.outcome).toBe("revise");
  });
});

// ---------------------------------------------------------------------------
// Collaborative gates — /approve route
// ---------------------------------------------------------------------------

describe("evaluateGate released by /approve", () => {
  it("proceeds when run.json flips to approved", async () => {
    const client = mockClient();

    setTimeout(() => {
      const state = readRunState(tmpDir);
      writeRunState(tmpDir, { ...state, stage_status: "approved" });
    }, 60);

    const decision = await evaluateGate(generateGatePreset("collaborative"), {
      client,
      sessionId: "ses_1",
      projectDir: tmpDir,
      stageId: "paper_positioning",
      pollIntervalMs: 20,
    });

    expect(decision.outcome).toBe("proceed");
    expect(decision.reason).toContain("/approve");
  });

  it("stops when run.json flips to blocked", async () => {
    const client = mockClient();

    setTimeout(() => {
      const state = readRunState(tmpDir);
      writeRunState(tmpDir, {
        ...state,
        stage_status: "blocked",
        error: { stage: "paper_positioning", message: "rejected by human", at: new Date().toISOString() },
      });
    }, 60);

    const decision = await evaluateGate(generateGatePreset("collaborative"), {
      client,
      sessionId: "ses_1",
      projectDir: tmpDir,
      stageId: "paper_positioning",
      pollIntervalMs: 20,
    });

    expect(decision.outcome).toBe("stop");
    expect(decision.reason).toBe("rejected by human");
  });

  it("answers the dangling question so the agent is not left blocked", async () => {
    // /approve opens the gate, but the agent is still sitting on its picker.
    const client = mockClient([], {
      question: {
        list: vi.fn(() =>
          ok([{ requestID: "que_1", sessionID: "ses_1", questions: [] }]),
        ),
        reply: vi.fn(() => ok(true)),
      },
    });

    setTimeout(() => {
      const state = readRunState(tmpDir);
      writeRunState(tmpDir, { ...state, stage_status: "approved" });
    }, 60);

    await evaluateGate(generateGatePreset("collaborative"), {
      client,
      sessionId: "ses_1",
      projectDir: tmpDir,
      stageId: "paper_positioning",
      pollIntervalMs: 20,
    });

    expect(client.question.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        requestID: "que_1",
        answers: [[GATE_CHOICES.approve]],
      }),
    );
  });

  it("does not answer questions belonging to another session", async () => {
    const client = mockClient([], {
      question: {
        list: vi.fn(() => ok([{ requestID: "que_other", sessionID: "ses_OTHER", questions: [] }])),
        reply: vi.fn(() => ok(true)),
      },
    });

    setTimeout(() => {
      const state = readRunState(tmpDir);
      writeRunState(tmpDir, { ...state, stage_status: "approved" });
    }, 60);

    await evaluateGate(generateGatePreset("collaborative"), {
      client,
      sessionId: "ses_1",
      projectDir: tmpDir,
      stageId: "paper_positioning",
      pollIntervalMs: 20,
    });

    expect(client.question.reply).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Abort
// ---------------------------------------------------------------------------

describe("evaluateGate abort", () => {
  it("stops waiting when the signal aborts", async () => {
    const client = mockClient();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 60);

    const decision = await evaluateGate(generateGatePreset("collaborative"), {
      client,
      sessionId: "ses_1",
      projectDir: tmpDir,
      stageId: "paper_positioning",
      pollIntervalMs: 20,
      signal: controller.signal,
    });

    expect(decision.outcome).toBe("stop");
    expect(decision.reason).toContain("aborted");
  });
});

// ---------------------------------------------------------------------------
// Mode switching
// ---------------------------------------------------------------------------

describe("switchMode", () => {
  it("rewrites the policy and mirrors the mode into run.json", () => {
    const policy = generateGatePreset("collaborative");
    writeGatePolicy(tmpDir, policy);

    switchMode(tmpDir, policy, "autonomous");

    const next = readGatePolicy(tmpDir);
    expect(next.mode).toBe("autonomous");
    expect(next.gates["paper_positioning"]?.policy).toBe("auto");
    expect(readRunState(tmpDir).mode).toBe("autonomous");
  });

  it("preserves a per-gate override across the switch", () => {
    const policy = generateGatePreset("collaborative");
    // Not the collaborative default for this stage, so it is a user override.
    policy.gates["evidence_inventory"] = { policy: "await_human" };
    writeGatePolicy(tmpDir, policy);

    switchMode(tmpDir, policy, "autonomous");

    const next = readGatePolicy(tmpDir);
    expect(next.gates["evidence_inventory"]?.policy).toBe("await_human");
    expect(next.gates["paper_positioning"]?.policy).toBe("auto");
  });
});
