/**
 * Controller integration tests.
 *
 * These drive the real loop against a mock OpenCode client and a real git
 * repository, so checkpoints, state transitions, and resume behaviour are
 * exercised end to end rather than stubbed.
 *
 * The agent is simulated by a callback that mutates the repository when a
 * prompt arrives — which is exactly the contract the controller relies on:
 * it never reads the reply, only the resulting files.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execaSync } from "execa";

import { PipelineController } from "../../src/controller/controller.js";
import { generateGatePreset } from "../../src/state/gate-presets.js";
import {
  writeRunState,
  readRunState,
  readStageHistory,
  writeGatePolicy,
  writeStageHistory,
} from "../../src/state/store.js";
import type { RunState } from "../../src/state/schema.js";
import { STAGES } from "../../src/pipeline/stages.js";
import { GATE_CHOICES } from "../../src/controller/gate.js";
import { commitCheckpoint } from "../../src/utils/git.js";
import { initializeHarnessTrust } from "../../src/harness/harness.js";

// ---------------------------------------------------------------------------
// Repo fixture
// ---------------------------------------------------------------------------

let tmpDir: string;

function initRepo(dir: string): void {
  execaSync("git", ["init"], { cwd: dir });
  execaSync("git", ["config", "user.email", "t@t.com"], { cwd: dir });
  execaSync("git", ["config", "user.name", "T"], { cwd: dir });
  writeFileSync(join(dir, "BRIEF.md"), "x".repeat(200));
  writeFileSync(
    join(dir, "PAPER.md"),
    "# Paper\n\n## Paper identity\n\n- Working title: Baseline\n\n## What readers should believe\n\n### Central thesis \u2014 locked\n\nKeep this thesis.\n\n### Contributions\n\n- A contribution.\n\n## What must not change silently\n\nCurrent locked items:\n\n- The central thesis.\n",
  );
  mkdirSync(join(dir, ".agents", "tools"), { recursive: true });
  writeFileSync(join(dir, ".agents", "tools", "check-structure.py"), "import sys; sys.exit(0)\n");
  execaSync("git", ["add", "BRIEF.md", "PAPER.md", ".agents/tools/check-structure.py"], { cwd: dir });
  execaSync("git", ["commit", "-m", "init"], { cwd: dir });
}

function makeRunState(overrides: Partial<RunState> = {}): RunState {
  return {
    schema_version: "paper-run-v1",
    run_id: "abcd1234",
    run_branch: "paper-run/abcd1234",
    mode: "autonomous",
    current_stage: "bootstrap",
    stage_status: "pending",
    started_at: "2026-08-29T10:00:00.000Z",
    updated_at: "2026-08-29T10:00:00.000Z",
    template_version: "v0.3.0",
    ...overrides,
  };
}

/** Satisfy the bootstrap stage's validators. */
function satisfyBootstrap(dir: string): void {
  writeFileSync(join(dir, "BRIEF.md"), "x".repeat(200));
  writeFileSync(join(dir, ".agents", "tools", "check-structure.py"), "import sys; sys.exit(0)\n");
}

function writeAssessment(dir: string, verdict: string, extra: Record<string, unknown> = {}): void {
  writeFileSync(
    join(dir, ".paper-run", "assessment.json"),
    JSON.stringify({
      schema_version: "paper-run-assessment-v1",
      verdict,
      criteria: {
        research_question: { rating: "sufficient", evidence: "clear" },
        evidence: { rating: "sufficient", evidence: "results present" },
        venue: { rating: "sufficient", evidence: "named" },
        figures_tables: { rating: "sufficient", evidence: "present" },
        related_work: { rating: "sufficient", evidence: "refs" },
      },
      summary: "ok",
      missing_for_usable: [],
      can_proceed_with: [],
      blockers: [],
      assessed_files: ["BRIEF.md"],
      assessed_at: "2026-08-29T10:00:00.000Z",
      ...extra,
    }),
  );
}

// ---------------------------------------------------------------------------
// Mock client
// ---------------------------------------------------------------------------

function ok<T>(data: T) {
  return Promise.resolve({ data, error: undefined });
}

interface MockOpts {
  /** Runs when a prompt arrives — the simulated agent's side effects. */
  onPrompt?: (text: string, turn: number) => void;
  /** Events to emit while waiting, per turn. */
  eventsForTurn?: (turn: number) => Array<unknown | (() => void)>;
}

function mockClient(opts: MockOpts = {}): any {
  let turn = 0;
  const prompts: string[] = [];
  const promptArgs: any[] = [];
  let promptedSessionId = "ses_1";
  let reviewSession = 0;
  const abortedSessions = new Set<string>();

  const client: any = {
    _prompts: prompts,
    _promptArgs: promptArgs,
    session: {
      create: vi.fn(() => ok({ id: `ses_review_${++reviewSession}` })),
      promptAsync: vi.fn((args: any) => {
        const text = args.parts[0].text;
        prompts.push(text);
        promptArgs.push(args);
        promptedSessionId = args.sessionID;
        abortedSessions.delete(promptedSessionId);
        turn += 1;
        opts.onPrompt?.(text, turn);
        return ok({});
      }),
      // Always busy on first ask so waitForIdle listens to the stream.
      status: vi.fn(() => ok(abortedSessions.has(promptedSessionId)
        ? {}
        : { [promptedSessionId]: { type: "busy" } })),
      abort: vi.fn(({ sessionID }: { sessionID: string }) => {
        abortedSessions.add(sessionID);
        return ok({});
      }),
      get: vi.fn(({ sessionID }: { sessionID: string }) => ok({ id: sessionID })),
    },
    event: {
      subscribe: vi.fn(() =>
        Promise.resolve({
          stream: (async function* () {
            const extra = opts.eventsForTurn?.(turn) ?? [];
            for (const e of extra) {
              await new Promise((r) => setTimeout(r, 2));
              if (typeof e === "function") {
                e();
                continue;
              }
              yield e;
            }
            await new Promise((r) => setTimeout(r, 2));
            yield { type: "session.idle", properties: { sessionID: promptedSessionId } };
            // Then hold open.
            await new Promise(() => {});
          })(),
        }),
      ),
    },
    question: { list: vi.fn(() => ok([])), reply: vi.fn(() => ok(true)) },
    permission: { list: vi.fn(() => ok([])), reply: vi.fn(() => ok(true)) },
    tui: { showToast: vi.fn(() => ok(true)) },
  };

  return client;
}

function makeController(
  client: any,
  mode: "autonomous" | "collaborative" = "autonomous",
  signal?: AbortSignal,
  agent?: string,
) {
  const policy = generateGatePreset(mode);
  writeGatePolicy(tmpDir, policy);
  return new PipelineController({
    client,
    sessionId: "ses_1",
    projectDir: tmpDir,
    policy,
    ...(signal ? { signal } : {}),
    ...(agent ? { agent } : {}),
  });
}

/**
 * Run only the first stage: abort as soon as it is recorded, so the test is
 * not racing a wall-clock timer against however long later stages take.
 */
function abortAfterStage(stageId: string, ac: AbortController, timeoutMs = 3000): void {
  const started = Date.now();
  const tick = setInterval(() => {
    let done = false;
    try {
      done = readStageHistory(tmpDir).stages.some((s) => s.stage_id === stageId);
    } catch {
      done = false;
    }
    if (done || Date.now() - started > timeoutMs) {
      clearInterval(tick);
      ac.abort();
    }
  }, 10);
}

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "paper-run-ctrl-"));
  mkdirSync(join(tmpDir, ".paper-run"), { recursive: true });
  initRepo(tmpDir);
  writeRunState(tmpDir, makeRunState());
  writeGatePolicy(tmpDir, generateGatePreset("autonomous"));
  writeStageHistory(tmpDir, { schema_version: "paper-run-stage-history-v1", stages: [] });
  await initializeHarnessTrust(tmpDir, "v0.3.0");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("running a stage", () => {
  it("prompts, validates, checkpoints, and advances", async () => {
    const client = mockClient({
      onPrompt: () => satisfyBootstrap(tmpDir),
    });

    // Stop after bootstrap by pointing the run at the last stage next.
    writeRunState(tmpDir, makeRunState({ current_stage: "bootstrap" }));

    const ac = new AbortController();
    const controller = makeController(client, "autonomous", ac.signal);
    abortAfterStage("bootstrap", ac);
    const result = await controller.run();

    const history = readStageHistory(tmpDir);
    const bootstrap = history.stages.find((s) => s.stage_id === "bootstrap");

    expect(bootstrap?.status).toBe("completed");
    expect(bootstrap?.commit_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(result.status).toBe("interrupted");
  });

  it("writes a checkpoint commit carrying the stage trailer", async () => {
    const client = mockClient({ onPrompt: () => satisfyBootstrap(tmpDir) });
    const ac = new AbortController();
    const controller = makeController(client, "autonomous", ac.signal);
    abortAfterStage("bootstrap", ac);
    await controller.run();

    const { stdout } = execaSync("git", ["log", "-1", "--format=%B"], { cwd: tmpDir });
    expect(stdout).toContain("Paper-Run-Stage: bootstrap");
    expect(stdout).toContain("Paper-Run-Run: abcd1234");
    expect(stdout).toContain("Paper-Run-Mode: autonomous");
    const { stdout: logBody } = execaSync("git", ["log", "--format=%B"], { cwd: tmpDir });
    expect(logBody).not.toContain("Paper-Run-Status: gate_waiting");
    const { stdout: files } = execaSync("git", ["show", "--format=", "--name-only", "HEAD"], { cwd: tmpDir });
    expect(files).toContain(".paper-run/run.json");
  });

  it("runs each independent review attempt in a fresh paper-reviewer session", async () => {
    const client = mockClient();
    const controller = makeController(client, "autonomous", undefined, "paper-writer");
    await (controller as any).takeTurn(STAGES.independent_review, "review cold");
    await (controller as any).takeTurn(STAGES.independent_review, "review cold again");

    expect(client.session.create).toHaveBeenCalledTimes(2);
    expect(client._promptArgs).toEqual([
      expect.objectContaining({ sessionID: "ses_review_1", agent: "paper-reviewer" }),
      expect.objectContaining({ sessionID: "ses_review_2", agent: "paper-reviewer" }),
    ]);
  });
});

// ---------------------------------------------------------------------------
// Validation failure and remediation
// ---------------------------------------------------------------------------

describe("validation", () => {
  it("hard-stops a contract violation before validation or remediation", async () => {
    const client = mockClient({
      onPrompt: () => writeFileSync(join(tmpDir, "BRIEF.md"), "changed by the agent\n"),
    });

    const result = await makeController(client).run();

    expect(result.status).toBe("stopped");
    if (result.status === "stopped") {
      expect(result.reason).toContain("locked-contract violation");
      expect(result.reason).toContain("ordinary stage approval cannot authorize");
    }
    expect(client._prompts).toHaveLength(1);
  });

  it("does not route a collaborative locked violation through the ordinary gate", async () => {
    const client = mockClient({
      onPrompt: () => {
        const path = join(tmpDir, "PAPER.md");
        writeFileSync(path, readFileSync(path, "utf-8").replace("Keep this thesis.", "Change it."));
      },
    });

    const result = await makeController(client, "collaborative").run();

    expect(result.status).toBe("stopped");
    expect(client._prompts.some((prompt: string) => prompt.includes("Use the `question` tool"))).toBe(false);
  });

  it("retries with a remediation prompt naming the failures", async () => {
    rmSync(join(tmpDir, ".agents", "tools", "check-structure.py"));
    let fixed = false;
    const client = mockClient({
      onPrompt: (_text, turn) => {
        // Fail the first turn, satisfy on the second.
        if (turn >= 2) {
          satisfyBootstrap(tmpDir);
          fixed = true;
        }
      },
    });

    const ac = new AbortController();
    const controller = makeController(client, "autonomous", ac.signal);
    abortAfterStage("bootstrap", ac);
    await controller.run();

    expect(fixed).toBe(true);
    const prompts: string[] = client._prompts;
    expect(prompts.length).toBeGreaterThanOrEqual(2);
    expect(prompts[1]).toContain("validation failed");
    expect(prompts[1]).toContain("check-structure.py");
  });

  it("blocks the run when remediation is exhausted", async () => {
    // Never satisfies the validators.
    rmSync(join(tmpDir, ".agents", "tools", "check-structure.py"));
    const client = mockClient();
    const controller = makeController(client);

    const result = await controller.run();

    expect(result.status).toBe("stopped");
    if (result.status === "stopped") {
      expect(result.stageId).toBe("bootstrap");
      expect(result.reason).toContain("validation failed");
    }
    expect(readRunState(tmpDir).stage_status).toBe("blocked");
    expect(readRunState(tmpDir).error?.stage).toBe("bootstrap");
  });

  it("does not exceed the stage's retry budget", async () => {
    rmSync(join(tmpDir, ".agents", "tools", "check-structure.py"));
    const client = mockClient();
    const controller = makeController(client);
    await controller.run();

    // One initial turn plus `retries` remediation turns.
    expect(client._prompts.length).toBe(STAGES.bootstrap.retries + 1);
  });
});

// ---------------------------------------------------------------------------
// Material assessment
// ---------------------------------------------------------------------------

describe("material assessment", () => {
  beforeEach(() => {
    // Start the run at material assessment with bootstrap already done.
    writeRunState(
      tmpDir,
      makeRunState({ current_stage: "bootstrap", stage_status: "completed" }),
    );
    satisfyBootstrap(tmpDir);
  });

  it("stops the whole run on an unusable verdict, in autonomous mode", async () => {
    const client = mockClient({
      onPrompt: () =>
        writeAssessment(tmpDir, "unusable", {
          blockers: ["no experimental results at all"],
          summary: "A topic, but no work behind it.",
        }),
    });

    const controller = makeController(client, "autonomous");
    const result = await controller.run();

    expect(result.status).toBe("stopped");
    if (result.status === "stopped") {
      expect(result.stageId).toBe("material_assessment");
      expect(result.reason).toContain("no experimental results");
    }

    // Nothing downstream ran.
    const history = readStageHistory(tmpDir);
    expect(history.stages.some((s) => s.stage_id === "paper_positioning")).toBe(false);

    // The judgement is still on the record.
    const record = history.stages.find((s) => s.stage_id === "material_assessment");
    expect(record?.status).toBe("blocked");
    expect(record?.material_verdict).toBe("unusable");
  });

  it("checkpoints the blocked assessment so the judgement is traceable", async () => {
    const client = mockClient({
      onPrompt: () => writeAssessment(tmpDir, "unusable", { blockers: ["nothing to report"] }),
    });

    await makeController(client, "autonomous").run();

    const { stdout } = execaSync("git", ["log", "-1", "--format=%B"], { cwd: tmpDir });
    expect(stdout).toContain("Paper-Run-Stage: material_assessment");
    expect(stdout).toContain("Paper-Run-Status: blocked");
  });

  it("enforces the stop even when the agent claims usable", async () => {
    // Self-contradictory: usable while listing blockers.
    const client = mockClient({
      onPrompt: () => writeAssessment(tmpDir, "usable", { blockers: ["no results"] }),
    });

    const result = await makeController(client, "autonomous").run();
    expect(result.status).toBe("stopped");
  });

  it("continues past a partial verdict", async () => {
    const client = mockClient({
      onPrompt: (text) => {
        if (text.includes("Material assessment")) {
          writeAssessment(tmpDir, "partial", {
            criteria: {
              research_question: { rating: "sufficient", evidence: "clear" },
              evidence: { rating: "partial", evidence: "half done" },
              venue: { rating: "sufficient", evidence: "named" },
              figures_tables: { rating: "sufficient", evidence: "present" },
              related_work: { rating: "sufficient", evidence: "refs" },
            },
            missing_for_usable: ["experiment 3"],
          });
        }
      },
    });

    const ac = new AbortController();
    const controller = makeController(client, "autonomous", ac.signal);
    abortAfterStage("material_assessment", ac);
    await controller.run();

    const record = readStageHistory(tmpDir).stages.find(
      (s) => s.stage_id === "material_assessment",
    );
    expect(record?.status).toBe("completed");
    expect(record?.material_verdict).toBe("partial");
  });

  it("tells later stages that materials were partial", async () => {
    const client = mockClient({
      onPrompt: (text) => {
        if (text.includes("Material assessment")) {
          writeAssessment(tmpDir, "partial", {
            criteria: {
              research_question: { rating: "sufficient", evidence: "clear" },
              evidence: { rating: "partial", evidence: "half done" },
              venue: { rating: "sufficient", evidence: "named" },
              figures_tables: { rating: "sufficient", evidence: "present" },
              related_work: { rating: "sufficient", evidence: "refs" },
            },
          });
        }
      },
    });

    const ac = new AbortController();
    const controller = makeController(client, "autonomous", ac.signal);
    abortAfterStage("evidence_inventory", ac);
    await controller.run();

    const prompts: string[] = client._prompts;
    const later = prompts.find((p) => p.includes("Evidence inventory"));
    if (later) expect(later).toContain("TODO(paper-run)");
  });
});

// ---------------------------------------------------------------------------
// Resume
// ---------------------------------------------------------------------------

describe("resume", () => {
  it("re-runs a stage that was interrupted mid-flight", async () => {
    // Left "running" by a crash: no checkpoint was committed for it.
    writeRunState(tmpDir, makeRunState({ current_stage: "bootstrap", stage_status: "running" }));

    const client = mockClient({ onPrompt: () => satisfyBootstrap(tmpDir) });
    const ac = new AbortController();
    const controller = makeController(client, "autonomous", ac.signal);
    abortAfterStage("bootstrap", ac);
    await controller.run();

    expect(client._prompts[0]).toContain("Bootstrap");
  });

  it("starts after a stage recorded as completed", async () => {
    writeRunState(tmpDir, makeRunState({ current_stage: "bootstrap", stage_status: "completed" }));
    satisfyBootstrap(tmpDir);

    const client = mockClient();
    const ac = new AbortController();
    const controller = makeController(client, "autonomous", ac.signal);
    abortAfterStage("bootstrap", ac);
    await controller.run();

    expect(client._prompts[0]).toContain("Material assessment");
  });

  it("recovers the material verdict from history on resume", async () => {
    writeStageHistory(tmpDir, {
      schema_version: "paper-run-stage-history-v1",
      stages: [
        {
          stage_id: "material_assessment",
          status: "blocked",
          started_at: "2026-08-29T10:00:00.000Z",
          completed_at: "2026-08-29T10:01:00.000Z",
          commit_sha: "abc",
          material_verdict: "unusable",
        },
      ],
    });
    writeRunState(
      tmpDir,
      makeRunState({ current_stage: "material_assessment", stage_status: "completed" }),
    );

    const client = mockClient();
    const result = await makeController(client).run();

    // The block survives a restart: no downstream stage is attempted.
    expect(result.status).toBe("stopped");
    if (result.status === "stopped") {
      expect(result.reason).toContain("unusable");
    }
    expect(client._prompts).toHaveLength(0);
  });

  it("keeps a gate_waiting checkpoint human-gated after policy switches to auto", async () => {
    satisfyBootstrap(tmpDir);
    const policy = generateGatePreset("collaborative");
    policy.gates.bootstrap = { policy: "await_human" };
    writeGatePolicy(tmpDir, policy);
    writeRunState(tmpDir, makeRunState({ stage_status: "gate_waiting", mode: "collaborative" }));
    await commitCheckpoint(
      {
        stageId: "bootstrap",
        status: "gate_waiting",
        runId: "abcd1234",
        mode: "collaborative",
        templateVersion: "v0.3.0",
      },
      tmpDir,
    );
    const switchedPolicy = generateGatePreset("autonomous");
    writeGatePolicy(tmpDir, switchedPolicy);

    const client = mockClient({
      eventsForTurn: () => [
        { type: "question.asked", properties: { id: "que_resume", sessionID: "ses_1" } },
        {
          type: "question.replied",
          properties: {
            requestID: "que_resume",
            sessionID: "ses_1",
            answers: [[GATE_CHOICES.approve]],
          },
        },
      ],
    });
    const ac = new AbortController();
    const controller = new PipelineController({
      client,
      sessionId: "ses_1",
      projectDir: tmpDir,
      policy: switchedPolicy,
      agent: "paper-writer",
      signal: ac.signal,
    });
    abortAfterStage("bootstrap", ac);

    const result = await controller.run();

    expect(result.status).toBe("stopped");
    expect(client._prompts).toHaveLength(1);
    expect(client._prompts[0]).toContain('gate after stage "bootstrap"');
    expect(client._promptArgs[0]).not.toHaveProperty("agent", "paper-writer");
    expect(readStageHistory(tmpDir).stages).toEqual([]);
    const { stdout } = execaSync("git", ["log", "-1", "--format=%B"], { cwd: tmpDir });
    expect(stdout).toContain("Paper-Run-Status: gate_waiting");
  });
});

// ---------------------------------------------------------------------------
// Interruption
// ---------------------------------------------------------------------------

describe("interruption", () => {
  it("reports interrupted and leaves state resumable", async () => {
    const ac = new AbortController();
    const client = mockClient({ onPrompt: () => ac.abort() });

    const controller = new PipelineController({
      client,
      sessionId: "ses_1",
      projectDir: tmpDir,
      policy: generateGatePreset("autonomous"),
      signal: ac.signal,
    });

    const result = await controller.run();

    expect(result.status).toBe("interrupted");
    // Not left mid-validation: a resume can pick this up.
    expect(["running", "pending", "validating"]).toContain(
      readRunState(tmpDir).stage_status,
    );
  });

  it("abort() stops the agent's turn", async () => {
    const client = mockClient();
    const controller = makeController(client);
    await controller.abort();
    expect(client.session.abort).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

describe("gates in collaborative mode", () => {
  it("waits at a gated stage and proceeds when approved", async () => {
    let waitingCheckpointSeen = false;
    const client = mockClient({
      onPrompt: (text, turn) => {
        if (text.includes("Bootstrap")) satisfyBootstrap(tmpDir);
        if (turn === 2) {
          const message = execaSync("git", ["log", "-1", "--format=%B"], {
            cwd: tmpDir,
          }).stdout;
          waitingCheckpointSeen = message.includes("Paper-Run-Status: gate_waiting");
        }
      },
      eventsForTurn: (turn) =>
        // The gate prompt is the second turn; answer its question.
        turn >= 2
          ? [
              { type: "question.asked", properties: { id: "que_1", sessionID: "ses_1" } },
              {
                type: "question.replied",
                properties: {
                  requestID: "que_1",
                  sessionID: "ses_1",
                  answers: [[GATE_CHOICES.approve]],
                },
              },
            ]
          : [],
    });

    // Gate bootstrap so the very first stage exercises the path.
    const policy = generateGatePreset("collaborative");
    policy.gates["bootstrap"] = { policy: "await_human" };
    writeGatePolicy(tmpDir, policy);

    const ac = new AbortController();
    const controller = new PipelineController({
      client,
      sessionId: "ses_1",
      projectDir: tmpDir,
      policy,
      signal: ac.signal,
    });
    abortAfterStage("bootstrap", ac);
    await controller.run();

    const record = readStageHistory(tmpDir).stages.find((s) => s.stage_id === "bootstrap");
    expect(record?.status).toBe("completed");
    expect(waitingCheckpointSeen).toBe(true);
    const { stdout: completedFiles } = execaSync("git", ["show", "--format=", "--name-only", "HEAD"], { cwd: tmpDir });
    expect(completedFiles.trim().split("\n")).toEqual([".paper-run/run.json"]);
  });

  it("waits for the gate prompt turn to become idle before checking mutations", async () => {
    const client = mockClient({
      onPrompt: (text) => {
        if (text.includes("Bootstrap")) satisfyBootstrap(tmpDir);
      },
      eventsForTurn: (turn) => turn >= 2 ? [
        { type: "question.asked", properties: { id: "que_late", sessionID: "ses_1" } },
        {
          type: "question.replied",
          properties: { requestID: "que_late", sessionID: "ses_1", answers: [[GATE_CHOICES.approve]] },
        },
        () => writeFileSync(join(tmpDir, "LATE.md"), "mutation after question reply\n"),
      ] : [],
    });
    const policy = generateGatePreset("collaborative");
    policy.gates.bootstrap = { policy: "await_human" };
    writeGatePolicy(tmpDir, policy);

    const result = await new PipelineController({
      client,
      sessionId: "ses_1",
      projectDir: tmpDir,
      policy,
    }).run();

    expect(result.status).toBe("stopped");
    if (result.status === "stopped") expect(result.reason).toContain("LATE.md");
  });

  it("does not treat a gate-policy edit as controller-owned post-gate state", async () => {
    const client = mockClient({
      onPrompt: (text) => {
        if (text.includes("Bootstrap")) satisfyBootstrap(tmpDir);
      },
      eventsForTurn: (turn) => turn >= 2 ? [
        { type: "question.asked", properties: { id: "que_policy", sessionID: "ses_1" } },
        {
          type: "question.replied",
          properties: { requestID: "que_policy", sessionID: "ses_1", answers: [[GATE_CHOICES.approve]] },
        },
        () => {
          const changed = generateGatePreset("autonomous");
          writeGatePolicy(tmpDir, changed);
        },
      ] : [],
    });
    const policy = generateGatePreset("collaborative");
    policy.gates.bootstrap = { policy: "await_human" };
    writeGatePolicy(tmpDir, policy);

    const result = await new PipelineController({
      client,
      sessionId: "ses_1",
      projectDir: tmpDir,
      policy,
    }).run();

    expect(result.status).toBe("stopped");
    if (result.status === "stopped") expect(result.reason).toContain("gate-policy.json");
  });

  it("creates a new gate_waiting checkpoint after a human-requested revision", async () => {
    const client = mockClient({
      onPrompt: (_text, turn) => {
        if (turn === 1 || turn === 3) satisfyBootstrap(tmpDir);
      },
      eventsForTurn: (turn) => {
        if (turn !== 2 && turn !== 4) return [];
        const choice = turn === 2 ? GATE_CHOICES.revise : GATE_CHOICES.approve;
        const id = `que_revision_${turn}`;
        return [
          { type: "question.asked", properties: { id, sessionID: "ses_1" } },
          {
            type: "question.replied",
            properties: { requestID: id, sessionID: "ses_1", answers: [[choice]] },
          },
        ];
      },
    });
    const policy = generateGatePreset("collaborative");
    policy.gates.bootstrap = { policy: "await_human" };
    writeGatePolicy(tmpDir, policy);
    const ac = new AbortController();
    const controller = new PipelineController({
      client,
      sessionId: "ses_1",
      projectDir: tmpDir,
      policy,
      signal: ac.signal,
    });
    abortAfterStage("bootstrap", ac);

    await controller.run();

    const { stdout } = execaSync(
      "git",
      ["log", "--format=%B%x00"],
      { cwd: tmpDir },
    );
    expect(stdout.match(/Paper-Run-Status: gate_waiting/g)).toHaveLength(2);
  });

  it("stops the run when the human stops it at a gate", async () => {
    const client = mockClient({
      onPrompt: (text) => {
        if (text.includes("Bootstrap")) satisfyBootstrap(tmpDir);
      },
      eventsForTurn: (turn) =>
        turn >= 2
          ? [
              { type: "question.asked", properties: { id: "que_1", sessionID: "ses_1" } },
              {
                type: "question.replied",
                properties: {
                  requestID: "que_1",
                  sessionID: "ses_1",
                  answers: [[GATE_CHOICES.stop]],
                },
              },
            ]
          : [],
    });

    const policy = generateGatePreset("collaborative");
    policy.gates["bootstrap"] = { policy: "await_human" };
    writeGatePolicy(tmpDir, policy);

    const result = await new PipelineController({
      client,
      sessionId: "ses_1",
      projectDir: tmpDir,
      policy,
    }).run();

    expect(result.status).toBe("stopped");
    if (result.status === "stopped") expect(result.reason).toContain("stopped");
  });

  it("rechecks the same baseline after a gate and before checkpointing", async () => {
    const client = mockClient({
      onPrompt: (_text, turn) => {
        if (turn === 1) satisfyBootstrap(tmpDir);
        if (turn === 2) {
          const path = join(tmpDir, "PAPER.md");
          writeFileSync(path, readFileSync(path, "utf-8").replace("Keep this thesis.", "Changed at gate."));
        }
      },
      eventsForTurn: (turn) =>
        turn >= 2
          ? [
              { type: "question.asked", properties: { id: "que_guard", sessionID: "ses_1" } },
              {
                type: "question.replied",
                properties: {
                  requestID: "que_guard",
                  sessionID: "ses_1",
                  answers: [[GATE_CHOICES.approve]],
                },
              },
            ]
          : [],
    });
    const policy = generateGatePreset("collaborative");
    policy.gates["bootstrap"] = { policy: "await_human" };
    writeGatePolicy(tmpDir, policy);

    const result = await new PipelineController({
      client,
      sessionId: "ses_1",
      projectDir: tmpDir,
      policy,
    }).run();

    expect(result.status).toBe("stopped");
    if (result.status === "stopped") expect(result.reason).toContain("central_thesis");
    expect(readStageHistory(tmpDir).stages).toHaveLength(0);
  });

  it("refuses non-state project edits made after the waiting checkpoint", async () => {
    const client = mockClient({
      onPrompt: (text, turn) => {
        if (text.includes("Bootstrap")) satisfyBootstrap(tmpDir);
        if (turn === 2) writeFileSync(join(tmpDir, "NOTES.md"), "changed while gate was open\n");
      },
      eventsForTurn: (turn) =>
        turn >= 2
          ? [
              { type: "question.asked", properties: { id: "que_mutation", sessionID: "ses_1" } },
              {
                type: "question.replied",
                properties: {
                  requestID: "que_mutation",
                  sessionID: "ses_1",
                  answers: [[GATE_CHOICES.approve]],
                },
              },
            ]
          : [],
    });
    const policy = generateGatePreset("collaborative");
    policy.gates.bootstrap = { policy: "await_human" };
    writeGatePolicy(tmpDir, policy);

    const result = await new PipelineController({
      client,
      sessionId: "ses_1",
      projectDir: tmpDir,
      policy,
    }).run();

    expect(result.status).toBe("stopped");
    if (result.status === "stopped") {
      expect(result.reason).toContain("changed after the validated gate checkpoint");
      expect(result.reason).toContain("NOTES.md");
    }
    const { stdout } = execaSync("git", ["log", "-1", "--format=%B"], { cwd: tmpDir });
    expect(stdout).toContain("Paper-Run-Status: gate_waiting");
    expect(stdout).not.toContain("Paper-Run-Status: completed");
  });

  it("reloads policy so a running controller sees a switch at the next gate", async () => {
    const client = mockClient({
      onPrompt: (_text, turn) => {
        if (turn !== 1) return;
        satisfyBootstrap(tmpDir);
        const switched = generateGatePreset("collaborative");
        switched.gates["bootstrap"] = { policy: "await_human" };
        writeGatePolicy(tmpDir, switched);
      },
      eventsForTurn: (turn) =>
        turn >= 2
          ? [
              { type: "question.asked", properties: { id: "que_reload", sessionID: "ses_1" } },
              {
                type: "question.replied",
                properties: {
                  requestID: "que_reload",
                  sessionID: "ses_1",
                  answers: [[GATE_CHOICES.approve]],
                },
              },
            ]
          : [],
    });

    const ac = new AbortController();
    const controller = makeController(client, "autonomous", ac.signal);
    abortAfterStage("bootstrap", ac);
    await controller.run();

    expect(
      client._prompts.some((prompt: string) => prompt.includes('gate after stage "bootstrap"')),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Permissions during a turn
// ---------------------------------------------------------------------------

describe("permissions", () => {
  it("leaves a harness validator for human approval", async () => {
    const client = mockClient({
      onPrompt: () => satisfyBootstrap(tmpDir),
      eventsForTurn: () => [
        {
          type: "permission.asked",
          properties: {
            id: "per_1",
            sessionID: "ses_1",
            permission: "bash",
            metadata: { command: "python3 .agents/tools/check-structure.py" },
          },
        },
      ],
    });

    const ac = new AbortController();
    const controller = makeController(client, "autonomous", ac.signal);
    abortAfterStage("bootstrap", ac);
    await controller.run();

    expect(client.permission.reply).not.toHaveBeenCalled();
  });

  it("leaves an unrecognised command for the human", async () => {
    const client = mockClient({
      onPrompt: () => satisfyBootstrap(tmpDir),
      eventsForTurn: () => [
        {
          type: "permission.asked",
          properties: {
            id: "per_1",
            sessionID: "ses_1",
            permission: "bash",
            metadata: { command: "git push --force" },
          },
        },
      ],
    });

    const ac = new AbortController();
    const controller = makeController(client, "autonomous", ac.signal);
    abortAfterStage("bootstrap", ac);
    await controller.run();

    expect(client.permission.reply).not.toHaveBeenCalled();
  });

  it("fails fast instead of hanging on a headless permission request", async () => {
    const client = mockClient({
      onPrompt: () => satisfyBootstrap(tmpDir),
      eventsForTurn: () => [
        {
          type: "permission.asked",
          properties: {
            id: "per_headless",
            sessionID: "ses_1",
            permission: "bash",
            metadata: { command: "git push --force" },
          },
        },
      ],
    });
    const policy = generateGatePreset("autonomous");
    writeGatePolicy(tmpDir, policy);
    const controller = new PipelineController({
      client,
      sessionId: "ses_1",
      projectDir: tmpDir,
      policy,
      unattended: true,
    });

    await expect(controller.run()).rejects.toThrow(/Headless run requires approval for the bash permission/);
    expect(readRunState(tmpDir).stage_status).toBe("pending");
    expect(client.permission.reply).not.toHaveBeenCalled();
  });

  it("fails fast on a permission requested by a delegated child session", async () => {
    const client = mockClient({
      onPrompt: () => satisfyBootstrap(tmpDir),
      eventsForTurn: () => [
        {
          type: "permission.asked",
          properties: {
            id: "per_child",
            sessionID: "ses_child",
            permission: "bash",
            metadata: { command: "python3 -c 'arbitrary code'" },
          },
        },
      ],
    });
    const policy = generateGatePreset("autonomous");
    writeGatePolicy(tmpDir, policy);
    client.session.get.mockImplementation(({ sessionID }: { sessionID: string }) =>
      ok(sessionID === "ses_child"
        ? { id: "ses_child", parentID: "ses_1" }
        : { id: sessionID }),
    );
    const controller = new PipelineController({
      client,
      sessionId: "ses_1",
      projectDir: tmpDir,
      policy,
      unattended: true,
    });

    await expect(controller.run()).rejects.toThrow(
      /Headless run requires approval for the bash permission requested by a child session/,
    );
    expect(readRunState(tmpDir).stage_status).toBe("pending");
    expect(client.permission.reply).not.toHaveBeenCalled();
    expect(client.session.abort).toHaveBeenCalledWith(
      expect.objectContaining({ sessionID: "ses_child" }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(client.session.abort).toHaveBeenCalledWith(
      expect.objectContaining({ sessionID: "ses_1" }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
});
