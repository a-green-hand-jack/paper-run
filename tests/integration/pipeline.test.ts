/**
 * The controller driving a real writing repository.
 *
 * OpenCode is mocked — a real agent would cost tokens and be
 * non-deterministic — but everything else is genuine: the harness template,
 * its Python validators, git checkpoints, and the state files. The simulated
 * agent is a callback that edits the repository when a prompt arrives, which
 * is precisely the contract the controller depends on. It reads the files,
 * never the reply.
 *
 * What this catches that unit tests cannot: whether the stage table's
 * validators actually pass against a real harness repo, and whether a run can
 * be interrupted and resumed without losing or repeating work.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { existsSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execaSync } from "execa";

import { PipelineController } from "../../src/controller/controller.js";
import { generateGatePreset } from "../../src/state/gate-presets.js";
import {
  writeRunState,
  readStageHistory,
  writeStageHistory,
  ensurePaperRunDir,
} from "../../src/state/store.js";
import type { RunState } from "../../src/state/schema.js";
import { validateStage } from "../../src/pipeline/validators.js";
import { STAGES } from "../../src/pipeline/stages.js";
import { parseTrailers } from "../../src/utils/git.js";

import { makeTmpDir, cleanupTmp, makeWritingRepo, templateCache } from "./fixtures.js";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let workspace: string;
let repo: string;

beforeAll(() => {
  templateCache();
}, 180_000);

beforeEach(() => {
  workspace = makeTmpDir();
  repo = join(workspace, "paper");
  makeWritingRepo(repo);
  ensurePaperRunDir(repo);
  writeStageHistory(repo, { schema_version: "paper-run-stage-history-v1", stages: [] });
});

afterEach(() => {
  cleanupTmp(workspace);
  vi.restoreAllMocks();
});

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

function ok<T>(data: T) {
  return Promise.resolve({ data, error: undefined });
}

/** A mock OpenCode client whose "agent" is a callback over the repository. */
function mockClient(onPrompt: (text: string, turn: number) => void) {
  let turn = 0;
  const prompts: string[] = [];

  return {
    _prompts: prompts,
    session: {
      promptAsync: vi.fn((args: any) => {
        const text = args.parts[0].text;
        prompts.push(text);
        turn += 1;
        onPrompt(text, turn);
        return ok({});
      }),
      status: vi.fn(() => ok({ ses_1: { type: "busy" } })),
      abort: vi.fn(() => ok({})),
    },
    event: {
      subscribe: vi.fn(() =>
        Promise.resolve({
          stream: (async function* () {
            await new Promise((r) => setTimeout(r, 2));
            yield { type: "session.idle", properties: { sessionID: "ses_1" } };
            await new Promise(() => {});
          })(),
        }),
      ),
    },
    question: { list: vi.fn(() => ok([])), reply: vi.fn(() => ok(true)) },
    permission: { list: vi.fn(() => ok([])), reply: vi.fn(() => ok(true)) },
    tui: { showToast: vi.fn(() => ok(true)) },
  } as any;
}

/** Abort once a stage is recorded, rather than racing a wall clock. */
function abortAfter(stageId: string, ac: AbortController, timeoutMs = 30_000): void {
  const started = Date.now();
  const tick = setInterval(() => {
    let done = false;
    try {
      done = readStageHistory(repo).stages.some((s) => s.stage_id === stageId);
    } catch {
      done = false;
    }
    if (done || Date.now() - started > timeoutMs) {
      clearInterval(tick);
      ac.abort();
    }
  }, 20);
}

function writeAssessment(verdict: string, extra: Record<string, unknown> = {}): void {
  writeFileSync(
    join(repo, ".paper-run", "assessment.json"),
    JSON.stringify({
      schema_version: "paper-run-assessment-v1",
      verdict,
      criteria: {
        research_question: { rating: "sufficient", evidence: "stated" },
        evidence: { rating: "sufficient", evidence: "results present" },
        venue: { rating: "sufficient", evidence: "named" },
        figures_tables: { rating: "sufficient", evidence: "present" },
        related_work: { rating: "sufficient", evidence: "references" },
      },
      summary: "assessed",
      missing_for_usable: [],
      can_proceed_with: [],
      blockers: [],
      assessed_files: ["BRIEF.md"],
      assessed_at: new Date().toISOString(),
      ...extra,
    }),
  );
}

// ---------------------------------------------------------------------------
// The stage table against a real harness
// ---------------------------------------------------------------------------

describe("stage validators against a real harness repo", () => {
  it("bootstrap passes on a freshly created repository", async () => {
    // The template ships a populated BRIEF.md, so bootstrap's validators
    // should be satisfiable without any agent work at all.
    const result = await validateStage(STAGES.bootstrap, repo);
    expect(result.passed, result.failures.join("; ")).toBe(true);
  });

  it("reports specific failures rather than a generic one", async () => {
    // Empty out the contract a later stage depends on.
    writeFileSync(join(repo, "PAPER.md"), "# Paper\n\n## Paper identity\n\n");

    const result = await validateStage(STAGES.paper_positioning, repo);
    expect(result.passed).toBe(false);
    // The message must name what is wrong, since it goes into the
    // remediation prompt the agent has to act on.
    expect(result.failures.join(" ")).toMatch(/Paper identity|contracts/i);
  });
});

// ---------------------------------------------------------------------------
// A real stage, end to end
// ---------------------------------------------------------------------------

describe("running stages against a real repository", () => {
  it("checkpoints a completed stage with full trailers", async () => {
    writeRunState(repo, makeRunState());
    execaSync("git", ["checkout", "-b", "paper-run/abcd1234"], { cwd: repo });

    const client = mockClient(() => {
      // Bootstrap's validators already pass on a fresh template.
    });

    const ac = new AbortController();
    const controller = new PipelineController({
      client,
      sessionId: "ses_1",
      projectDir: repo,
      policy: generateGatePreset("autonomous"),
      signal: ac.signal,
    });

    abortAfter("bootstrap", ac);
    await controller.run();

    const record = readStageHistory(repo).stages.find((s) => s.stage_id === "bootstrap");
    expect(record?.status).toBe("completed");
    expect(record?.commit_sha).toMatch(/^[0-9a-f]{40}$/);

    const message = execaSync("git", ["log", "-1", "--format=%B"], { cwd: repo }).stdout;
    const trailers = parseTrailers(message);
    expect(trailers["Paper-Run-Stage"]).toBe("bootstrap");
    expect(trailers["Paper-Run-Run"]).toBe("abcd1234");
    expect(trailers["Paper-Run-Mode"]).toBe("autonomous");
  });

  it("stops the entire run when materials are unusable", async () => {
    writeRunState(repo, makeRunState({ current_stage: "bootstrap", stage_status: "completed" }));
    execaSync("git", ["checkout", "-b", "paper-run/abcd1234"], { cwd: repo });

    const client = mockClient((text) => {
      if (text.includes("Material assessment")) {
        writeAssessment("unusable", {
          blockers: ["no experimental results of any kind"],
          summary: "A topic, but no work behind it.",
        });
      }
    });

    const result = await new PipelineController({
      client,
      sessionId: "ses_1",
      projectDir: repo,
      policy: generateGatePreset("autonomous"),
    }).run();

    expect(result.status).toBe("stopped");
    if (result.status === "stopped") {
      expect(result.stageId).toBe("material_assessment");
    }

    // No manuscript work was attempted.
    const history = readStageHistory(repo);
    expect(history.stages.some((s) => s.stage_id === "canonical_drafting")).toBe(false);
    expect(history.stages.some((s) => s.stage_id === "paper_positioning")).toBe(false);

    // Nothing was written into the manuscript.
    const sections = join(repo, "paper", "sections");
    if (existsSync(sections)) {
      const intro = join(sections, "01_introduction.tex");
      if (existsSync(intro)) {
        const content = readFileSync(intro, "utf-8");
        // The template's own placeholder should be untouched.
        expect(content.length).toBeLessThan(4000);
      }
    }

    // The judgement itself is on the record.
    const record = history.stages.find((s) => s.stage_id === "material_assessment");
    expect(record?.status).toBe("blocked");
    expect(record?.material_verdict).toBe("unusable");
  });

  it("carries a partial verdict into later stage prompts", async () => {
    writeRunState(repo, makeRunState({ current_stage: "bootstrap", stage_status: "completed" }));
    execaSync("git", ["checkout", "-b", "paper-run/abcd1234"], { cwd: repo });

    const client = mockClient((text) => {
      if (text.includes("Material assessment")) {
        writeAssessment("partial", {
          criteria: {
            research_question: { rating: "sufficient", evidence: "stated" },
            evidence: { rating: "partial", evidence: "two of five experiments" },
            venue: { rating: "sufficient", evidence: "named" },
            figures_tables: { rating: "sufficient", evidence: "present" },
            related_work: { rating: "sufficient", evidence: "references" },
          },
          missing_for_usable: ["experiment 3 results"],
        });
      }
    });

    const ac = new AbortController();
    const controller = new PipelineController({
      client,
      sessionId: "ses_1",
      projectDir: repo,
      policy: generateGatePreset("autonomous"),
      signal: ac.signal,
    });

    abortAfter("evidence_inventory", ac);
    await controller.run();

    const record = readStageHistory(repo).stages.find(
      (s) => s.stage_id === "material_assessment",
    );
    expect(record?.material_verdict).toBe("partial");

    // The next stage must be told, or it will write as though the evidence
    // exists.
    const later = (client._prompts as string[]).find((p) => p.includes("Evidence inventory"));
    if (later) {
      expect(later).toContain("partial");
      expect(later).toContain("TODO(paper-run)");
    }
  });
});

// ---------------------------------------------------------------------------
// Interrupt and resume
// ---------------------------------------------------------------------------

describe("interrupt and resume", () => {
  it("resumes from the checkpoint without repeating completed work", async () => {
    writeRunState(repo, makeRunState());
    execaSync("git", ["checkout", "-b", "paper-run/abcd1234"], { cwd: repo });

    // --- first run: complete bootstrap, then stop ---
    const first = mockClient(() => {});
    const ac1 = new AbortController();
    abortAfter("bootstrap", ac1);

    await new PipelineController({
      client: first,
      sessionId: "ses_1",
      projectDir: repo,
      policy: generateGatePreset("autonomous"),
      signal: ac1.signal,
    }).run();

    const afterFirst = readStageHistory(repo);
    expect(afterFirst.stages.some((s) => s.stage_id === "bootstrap")).toBe(true);
    const bootstrapSha = afterFirst.stages.find((s) => s.stage_id === "bootstrap")?.commit_sha;

    // --- second run: a fresh controller, as if the process had restarted ---
    const second = mockClient((text) => {
      if (text.includes("Material assessment")) writeAssessment("usable");
    });
    const ac2 = new AbortController();
    abortAfter("material_assessment", ac2);

    await new PipelineController({
      client: second,
      sessionId: "ses_1",
      projectDir: repo,
      policy: generateGatePreset("autonomous"),
      signal: ac2.signal,
    }).run();

    // Bootstrap was not re-run.
    const prompts = second._prompts as string[];
    expect(prompts.some((p) => p.includes("Stage 1/13"))).toBe(false);
    expect(prompts[0]).toContain("Material assessment");

    // Its checkpoint is unchanged.
    const afterSecond = readStageHistory(repo);
    expect(afterSecond.stages.find((s) => s.stage_id === "bootstrap")?.commit_sha).toBe(
      bootstrapSha,
    );
  });

  it("re-runs a stage that was interrupted mid-flight", async () => {
    // A crash leaves the stage "running" with no checkpoint, so it must be
    // redone rather than skipped.
    writeRunState(repo, makeRunState({ current_stage: "bootstrap", stage_status: "running" }));
    execaSync("git", ["checkout", "-b", "paper-run/abcd1234"], { cwd: repo });

    const client = mockClient(() => {});
    const ac = new AbortController();
    abortAfter("bootstrap", ac);

    await new PipelineController({
      client,
      sessionId: "ses_1",
      projectDir: repo,
      policy: generateGatePreset("autonomous"),
      signal: ac.signal,
    }).run();

    expect((client._prompts as string[])[0]).toContain("Bootstrap");
  });

  it("keeps the unusable block across a restart", async () => {
    writeStageHistory(repo, {
      schema_version: "paper-run-stage-history-v1",
      stages: [
        {
          stage_id: "material_assessment",
          status: "blocked",
          started_at: "2026-08-29T10:00:00.000Z",
          completed_at: "2026-08-29T10:01:00.000Z",
          commit_sha: "abc123",
          material_verdict: "unusable",
        },
      ],
    });
    writeRunState(
      repo,
      makeRunState({ current_stage: "material_assessment", stage_status: "completed" }),
    );

    const client = mockClient(() => {
      throw new Error("the agent must not be prompted after an unusable verdict");
    });

    const result = await new PipelineController({
      client,
      sessionId: "ses_1",
      projectDir: repo,
      policy: generateGatePreset("autonomous"),
    }).run();

    expect(result.status).toBe("stopped");
    expect(client._prompts).toHaveLength(0);
  });
});
