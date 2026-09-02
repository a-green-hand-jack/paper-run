/**
 * Pipeline stage, prompt, and validator tests.
 *
 * The most valuable test here is the one that checks every skill path and
 * check-script name against a real harness checkout: a typo in a skill path
 * would send the agent to read a file that does not exist, and it would
 * improvise instead of failing loudly.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  readFileSync,
  chmodSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execaSync } from "execa";

import {
  STAGES,
  getStage,
  getNextStage,
  remainingStages,
  stageNumber,
  TOTAL_STAGES,
} from "../../src/pipeline/stages.js";
import {
  renderStagePrompt,
  renderRemediationPrompt,
  renderSectionPrompt,
  renderSummaryRequest,
} from "../../src/pipeline/prompts.js";
import {
  buildPublicationArtifacts,
  capturePublicationBaseline,
  validateStage,
  hasNonEmptySection,
} from "../../src/pipeline/validators.js";
import { PIPELINE_STAGES } from "../../src/state/gate-presets.js";
import type { StageRecord } from "../../src/state/schema.js";
import { initializeHarnessTrust } from "../../src/harness/harness.js";
import { readPublication } from "../../src/state/store.js";

/**
 * A harness checkout, for cross-checking that every path we send the agent to
 * actually exists. Set PAPER_RUN_HARNESS to point at one; CI clones the pinned
 * tag. Without it these checks skip rather than fail, so a local run without
 * network still works — but CI must have it, which `harness checkout presence`
 * below enforces.
 */
const HARNESS_CHECKOUT = process.env.PAPER_RUN_HARNESS ?? "/tmp/awh";
const hasHarness = existsSync(join(HARNESS_CHECKOUT, "AGENTS.md"));

function writeBuildProfile(
  root: string,
  build: { name: string; command: string[]; output?: string },
): void {
  mkdirSync(join(root, ".agents"), { recursive: true });
  writeFileSync(
    join(root, ".agents", "paper-build.json"),
    JSON.stringify({
      schema_version: "paper-build-profile-v1",
      layout: "external-latex",
      source_root: "paper",
      entrypoint: "paper/main.tex",
      bibliography: "paper/refs.bib",
      builds: [build],
    }),
  );
}

function publicationOnlyStage() {
  return {
    ...STAGES.publication_build,
    validators: [
      { type: "publication_build" as const, required: true, message: "build failed" },
    ],
  };
}

function writeDefaultPublicationSources(root: string): void {
  mkdirSync(join(root, "paper"), { recursive: true });
  writeFileSync(join(root, "paper", "main.tex"), "source");
  writeFileSync(join(root, "paper", "refs.bib"), "bibliography");
}

function pdf(body = "artifact"): string {
  return `%PDF-1.7\n${body}\n%%EOF\n`;
}

function writeFakeLatexmk(root: string): string {
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const executable = join(bin, "latexmk");
  writeFileSync(
    executable,
    "#!/bin/sh\njob=main\noutdir=.\nfor arg in \"$@\"; do\n  case \"$arg\" in\n    -jobname=*) job=${arg#-jobname=} ;;\n    -outdir=*) outdir=${arg#-outdir=} ;;\n  esac\ndone\nmkdir -p \"$outdir\"\nprintf '%s\\n' '%PDF-1.7' 'built' '%%EOF' > \"$outdir/$job.pdf\"\n",
  );
  chmodSync(executable, 0o755);
  return bin;
}

describe("harness checkout presence", () => {
  it("is available when running in CI", () => {
    // These path checks are the only thing standing between a typo'd skill
    // path and an agent improvising because the file it was sent to read does
    // not exist. Skipping them silently in CI would defeat the point.
    if (!process.env.CI) return;
    expect(
      hasHarness,
      `No harness checkout at ${HARNESS_CHECKOUT}. CI must clone agent-writing-harness.`,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Stage table
// ---------------------------------------------------------------------------

describe("stage definitions", () => {
  it("covers every pipeline stage exactly once", () => {
    expect(Object.keys(STAGES).sort()).toEqual([...PIPELINE_STAGES].sort());
    // Spelled out so a change to the pipeline is a deliberate edit here, not a
    // silent consequence of editing the stage table.
    expect([...PIPELINE_STAGES]).toEqual([
      "bootstrap",
      "material_assessment",
      "paper_plan",
      "full_draft",
      "evidence_reconciliation",
      "self_review",
      "independent_review",
      "revision",
      "publication_build",
      "paper_candidate",
    ]);
    expect(TOTAL_STAGES).toBe(PIPELINE_STAGES.length);
  });

  it("gives every stage an id matching its key", () => {
    for (const [key, stage] of Object.entries(STAGES)) {
      expect(stage.id).toBe(key);
    }
  });

  it("gives every stage at least one required validator", () => {
    // A stage with no required validator can silently produce nothing.
    for (const stage of Object.values(STAGES)) {
      const required = stage.validators.filter((v) => v.required);
      expect(required.length, `${stage.id} has no required validator`).toBeGreaterThan(0);
    }
  });

  it("gives every stage expected outputs and a non-trivial timeout", () => {
    for (const stage of Object.values(STAGES)) {
      expect(stage.expectedOutputs.length, `${stage.id}`).toBeGreaterThan(0);
      expect(stage.timeoutMs, `${stage.id}`).toBeGreaterThanOrEqual(60_000);
      expect(stage.retries, `${stage.id}`).toBeGreaterThanOrEqual(1);
    }
  });

  it("allows drafting the longest turn", () => {
    const drafting = STAGES.full_draft.timeoutMs;
    for (const stage of Object.values(STAGES)) {
      expect(stage.timeoutMs).toBeLessThanOrEqual(drafting);
    }
  });

  it("leaves material assessment without a harness skill", () => {
    // The harness has no sufficiency-assessment skill; this stage is ours.
    expect(STAGES.material_assessment.harnessSkill).toBeNull();
  });

  it("requires a structured independent review artifact", () => {
    expect(STAGES.independent_review.validators).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "file_exists", path: ".paper-run/review-findings.md" }),
        expect.objectContaining({ type: "contract_section", heading: "## Blocker findings" }),
        expect.objectContaining({ type: "contract_section", heading: "## Major findings" }),
        expect.objectContaining({ type: "contract_section", heading: "## Minor findings" }),
      ]),
    );
  });

  it("routes claim-evidence bindings away from locked PAPER.md sections", () => {
    expect(STAGES.evidence_reconciliation.validators).toContainEqual(
      expect.objectContaining({
        type: "contract_section",
        contract: "EXPERIMENTS.md",
        heading: "## Claim-evidence bindings",
        required: true,
      }),
    );

    const outputs = STAGES.evidence_reconciliation.expectedOutputs.join("\n");
    expect(outputs).toContain("EXPERIMENTS.md ## Claim-evidence bindings");
    expect(outputs).toContain("Do not edit the locked PAPER.md");
  });

  it("validates publication artifacts and checks references during self-review", () => {
    expect(STAGES.publication_build.validators).toContainEqual(
      expect.objectContaining({ type: "publication_build", required: true }),
    );
    expect(STAGES.self_review.validators).toContainEqual(
      expect.objectContaining({
        type: "check_script",
        script: "check-reference-integrity.py",
        args: ["--profile", "draft"],
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Cross-check against the real harness
// ---------------------------------------------------------------------------

describe.skipIf(!hasHarness)("harness references (checked against a real checkout)", () => {
  it("points every harnessSkill at a SKILL.md that exists", () => {
    for (const stage of Object.values(STAGES)) {
      if (!stage.harnessSkill) continue;
      const path = join(HARNESS_CHECKOUT, stage.harnessSkill);
      expect(existsSync(path), `${stage.id} -> ${stage.harnessSkill}`).toBe(true);
    }
  });

  it("points every sidecar skill at a SKILL.md that exists", () => {
    for (const stage of Object.values(STAGES)) {
      for (const sidecar of stage.sidecarSkills ?? []) {
        const path = join(HARNESS_CHECKOUT, sidecar);
        expect(existsSync(path), `${stage.id} sidecar -> ${sidecar}`).toBe(true);
      }
    }
  });

  it("points every required-reading path at a file that exists", () => {
    // Required reading is the whole point of the mechanism: a stage claims the
    // agent must read a specific file. A path that has drifted sends the agent
    // looking for guidance that is not there, which is worse than not asking.
    for (const stage of Object.values(STAGES)) {
      for (const path of stage.requiredReading ?? []) {
        expect(existsSync(join(HARNESS_CHECKOUT, path)), `${stage.id} -> ${path}`).toBe(true);
      }
    }
  });

  it("keeps the drafting stage pointed at per-section guidance", () => {
    // section-writing is written for one active section at a time; the stage
    // is only allowed to claim perSection while the skill it loads agrees.
    const drafting = STAGES.full_draft;
    expect(drafting.perSection).toBe(true);
    const skill = readFileSync(join(HARNESS_CHECKOUT, drafting.harnessSkill!), "utf-8");
    expect(skill).toContain("active section");
  });

  it("names only check scripts that exist", () => {
    for (const stage of Object.values(STAGES)) {
      for (const validator of stage.validators) {
        if (validator.type !== "check_script") continue;
        const path = join(HARNESS_CHECKOUT, ".agents", "tools", validator.script);
        expect(existsSync(path), `${stage.id} -> ${validator.script}`).toBe(true);
      }
    }
  });

  it("references contracts that exist in the template", () => {
    for (const stage of Object.values(STAGES)) {
      for (const validator of stage.validators) {
        if (validator.type !== "contract_section") continue;
        // paper-run stage artifacts are created at runtime, not shipped by the harness.
        if (validator.contract.startsWith(".paper-run/")) continue;
        const path = join(HARNESS_CHECKOUT, validator.contract);
        expect(existsSync(path), `${stage.id} -> ${validator.contract}`).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Sequencing
// ---------------------------------------------------------------------------

describe("sequencing", () => {
  it("getStage returns the stage", () => {
    expect(getStage("bootstrap").name).toBe("Bootstrap");
  });

  it("getStage throws for an unknown id rather than returning undefined", () => {
    expect(() => getStage("nonsense")).toThrow(/Unknown pipeline stage/);
  });

  it("getNextStage walks the pipeline and ends with null", () => {
    expect(getNextStage("bootstrap")?.id).toBe("material_assessment");
    expect(getNextStage("paper_candidate")).toBeNull();
  });

  it("remainingStages re-runs an incomplete stage", () => {
    const remaining = remainingStages("paper_plan", false);
    expect(remaining[0]?.id).toBe("paper_plan");
  });

  it("remainingStages skips a completed stage", () => {
    const remaining = remainingStages("paper_plan", true);
    expect(remaining[0]?.id).toBe("full_draft");
  });

  it("remainingStages is empty after the last stage completes", () => {
    expect(remainingStages("paper_candidate", true)).toHaveLength(0);
  });

  it("stageNumber is 1-based", () => {
    expect(stageNumber("bootstrap")).toBe(1);
    expect(stageNumber("paper_candidate")).toBe(PIPELINE_STAGES.length);
  });
});

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

describe("renderStagePrompt", () => {
  const baseCtx = { mode: "autonomous" as const, history: [] as StageRecord[] };

  it("names the stage and its position", () => {
    const prompt = renderStagePrompt(STAGES.full_draft, baseCtx);
    expect(prompt).toContain(`Stage ${stageNumber("full_draft")}/${TOTAL_STAGES}`);
    expect(prompt).toContain("Full draft");
  });

  it("points at the owner skill and marks sidecars as sidecars", () => {
    const prompt = renderStagePrompt(STAGES.full_draft, baseCtx);
    expect(prompt).toContain(".agents/skills/section-writing/SKILL.md");
    expect(prompt).toContain("It owns this task");
    expect(prompt).toContain("never instead of it");
  });

  it("says a stage is paper-run's own when it has no skill", () => {
    const prompt = renderStagePrompt(STAGES.material_assessment, baseCtx);
    expect(prompt).toContain("belongs to paper-run");
  });

  it("always carries the never-fabricate rule", () => {
    for (const stage of Object.values(STAGES)) {
      const prompt = renderStagePrompt(stage, baseCtx);
      expect(prompt, `${stage.id}`).toMatch(/Never invent/i);
    }
  });

  it("tells claim-evidence work not to modify locked contribution prose", () => {
    const prompt = renderStagePrompt(STAGES.evidence_reconciliation, baseCtx);
    expect(prompt).toContain("EXPERIMENTS.md ## Claim-evidence bindings");
    expect(prompt).toContain("Do not edit the locked PAPER.md ### Central thesis or ### Contributions");
  });

  it("summarizes prior stages", () => {
    const history: StageRecord[] = [
      {
        stage_id: "bootstrap",
        status: "completed",
        started_at: "2026-08-29T10:00:00.000Z",
        completed_at: "2026-08-29T10:01:00.000Z",
        commit_sha: "abc",
      },
    ];
    const prompt = renderStagePrompt(STAGES.material_assessment, { ...baseCtx, history });
    expect(prompt).toContain("Completed so far");
    expect(prompt).toContain("bootstrap: completed");
  });

  it("elides a long history rather than listing every stage", () => {
    const history: StageRecord[] = PIPELINE_STAGES.slice(0, 8).map((id) => ({
      stage_id: id,
      status: "completed" as const,
      started_at: "2026-08-29T10:00:00.000Z",
      completed_at: "2026-08-29T10:01:00.000Z",
      commit_sha: "abc",
    }));
    const prompt = renderStagePrompt(STAGES.self_review, { ...baseCtx, history });
    expect(prompt).toMatch(/…\d+ earlier stage\(s\) completed/);
  });

  it("tells the agent to mark gaps when materials are partial", () => {
    const prompt = renderStagePrompt(STAGES.full_draft, {
      ...baseCtx,
      materialVerdict: "partial",
    });
    expect(prompt).toContain("TODO(paper-run)");
    expect(prompt).toContain("partial");
  });

  it("tells the agent to stop when materials are unusable", () => {
    const prompt = renderStagePrompt(STAGES.full_draft, {
      ...baseCtx,
      materialVerdict: "unusable",
    });
    expect(prompt).toContain("must not proceed");
  });

  it("adds no material section when materials are usable", () => {
    const prompt = renderStagePrompt(STAGES.full_draft, {
      ...baseCtx,
      materialVerdict: "usable",
    });
    expect(prompt).not.toContain("Material constraints");
  });

  it("distinguishes the two modes in the ground rules", () => {
    const collab = renderStagePrompt(STAGES.paper_plan, {
      ...baseCtx,
      mode: "collaborative",
    });
    const auto = renderStagePrompt(STAGES.paper_plan, { ...baseCtx, mode: "autonomous" });

    expect(collab).toContain("reviewing at gates");
    expect(auto).toContain("not licence to");
  });

  it("prioritizes human guidance when present", () => {
    const prompt = renderStagePrompt(STAGES.revision, {
      ...baseCtx,
      humanGuidance: "tighten the contribution claims",
    });
    expect(prompt).toContain("Guidance from the human");
    expect(prompt).toContain("tighten the contribution claims");
  });
});

describe("renderRemediationPrompt", () => {
  it("names the failing checks specifically", () => {
    const prompt = renderRemediationPrompt(STAGES.paper_plan, {
      mode: "autonomous",
      history: [],
      validationFailures: ["PAPER.md ## Paper identity is missing or empty"],
    });
    expect(prompt).toContain("validation failed");
    expect(prompt).toContain("PAPER.md ## Paper identity");
  });

  it("tells the agent not to fake a passing check", () => {
    const prompt = renderRemediationPrompt(STAGES.evidence_reconciliation, {
      mode: "autonomous",
      history: [],
      validationFailures: ["something failed"],
    });
    expect(prompt).toContain("instead of writing something that would make the check");
  });

  it("retains claim-evidence routing and lock boundaries during remediation", () => {
    const prompt = renderRemediationPrompt(STAGES.evidence_reconciliation, {
      mode: "autonomous",
      history: [],
      validationFailures: ["Paper contracts failed structural validation"],
    });

    expect(prompt).toContain("EXPERIMENTS.md ## Claim-evidence bindings");
    expect(prompt).toContain("Do not edit the locked PAPER.md ### Central thesis or ### Contributions");
  });
});

describe("renderSummaryRequest", () => {
  it("asks for a short summary and no further work", () => {
    const prompt = renderSummaryRequest(STAGES.paper_plan);
    expect(prompt).toContain("Paper plan");
    expect(prompt).toContain("Do not do further work");
  });
});

// ---------------------------------------------------------------------------
// hasNonEmptySection
// ---------------------------------------------------------------------------

describe("hasNonEmptySection", () => {
  it("finds content under a heading", () => {
    const md = "# Doc\n\n## Paper identity\n\nA paper about widgets.\n";
    expect(hasNonEmptySection(md, "## Paper identity")).toBe(true);
  });

  it("is false when the heading is absent", () => {
    expect(hasNonEmptySection("# Doc\n\n## Other\n\ntext\n", "## Paper identity")).toBe(false);
  });

  it("is false for an empty section", () => {
    const md = "## Paper identity\n\n## Next section\n\ncontent\n";
    expect(hasNonEmptySection(md, "## Paper identity")).toBe(false);
  });

  it("does not count a bare TODO placeholder as content", () => {
    // A template section still saying TODO has not been filled in.
    for (const placeholder of ["TODO", "TBD", "_(to be written)_", "(to be decided)"]) {
      const md = `## Paper identity\n\n${placeholder}\n\n## Next\n`;
      expect(hasNonEmptySection(md, "## Paper identity"), placeholder).toBe(false);
    }
  });

  it("does not count an HTML comment as content", () => {
    const md = "## Paper identity\n\n<!-- fill this in -->\n\n## Next\n";
    expect(hasNonEmptySection(md, "## Paper identity")).toBe(false);
  });

  it("counts content that merely mentions TODO alongside real text", () => {
    const md = "## Paper identity\n\nA paper about widgets. TODO: refine the title.\n";
    expect(hasNonEmptySection(md, "## Paper identity")).toBe(true);
  });

  it("stops at the next same-level heading but not at a deeper one", () => {
    const deeper = "## Paper identity\n\n### Sub\n\ncontent under sub\n";
    expect(hasNonEmptySection(deeper, "## Paper identity")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validateStage
// ---------------------------------------------------------------------------

describe("validateStage", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "paper-run-validate-"));
    mkdirSync(join(tmpDir, ".paper-run"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("fails a missing required file and reports why", async () => {
    const stage = {
      ...STAGES.bootstrap,
      validators: [
        {
          type: "file_exists" as const,
          path: "BRIEF.md",
          minBytes: 32,
          required: true,
          message: "BRIEF.md is missing or empty",
        },
      ],
    };

    const result = await validateStage(stage, tmpDir);
    expect(result.passed).toBe(false);
    expect(result.failures).toContain("BRIEF.md is missing or empty");
  });

  it("passes a file that meets the size bar", async () => {
    writeFileSync(join(tmpDir, "BRIEF.md"), "x".repeat(64));
    const stage = {
      ...STAGES.bootstrap,
      validators: [
        {
          type: "file_exists" as const,
          path: "BRIEF.md",
          minBytes: 32,
          required: true,
          message: "missing",
        },
      ],
    };

    expect((await validateStage(stage, tmpDir)).passed).toBe(true);
  });

  it("fails a file that exists but is too small", async () => {
    writeFileSync(join(tmpDir, "BRIEF.md"), "hi");
    const stage = {
      ...STAGES.bootstrap,
      validators: [
        {
          type: "file_exists" as const,
          path: "BRIEF.md",
          minBytes: 32,
          required: true,
          message: "too small",
        },
      ],
    };

    expect((await validateStage(stage, tmpDir)).passed).toBe(false);
  });

  it("checks a contract section", async () => {
    writeFileSync(join(tmpDir, "PAPER.md"), "## Paper identity\n\nA real paper.\n");
    const stage = {
      ...STAGES.paper_plan,
      validators: [
        {
          type: "contract_section" as const,
          contract: "PAPER.md",
          heading: "## Paper identity",
          required: true,
          message: "empty",
        },
      ],
    };

    expect((await validateStage(stage, tmpDir)).passed).toBe(true);
  });

  it("requires substantive claim-evidence bindings in EXPERIMENTS.md", async () => {
    const validator = STAGES.evidence_reconciliation.validators.find(
      (candidate) =>
        candidate.type === "contract_section" &&
        candidate.contract === "EXPERIMENTS.md" &&
        candidate.heading === "## Claim-evidence bindings",
    );
    expect(validator).toBeDefined();
    const stage = { ...STAGES.evidence_reconciliation, validators: [validator!] };

    expect((await validateStage(stage, tmpDir)).passed).toBe(false);

    writeFileSync(join(tmpDir, "EXPERIMENTS.md"), "## Claim-evidence bindings\n\nTODO\n");
    expect((await validateStage(stage, tmpDir)).passed).toBe(false);

    writeFileSync(
      join(tmpDir, "EXPERIMENTS.md"),
      "## Claim-evidence bindings\n\n- C1 is supported by table_kw.tex; uncertainty is unavailable.\n",
    );
    expect((await validateStage(stage, tmpDir)).passed).toBe(true);
  });

  it("fails a state file that is not valid JSON", async () => {
    writeFileSync(join(tmpDir, ".paper-run", "assessment.json"), "{not json");
    const stage = {
      ...STAGES.material_assessment,
      validators: [
        {
          type: "state_file" as const,
          file: "assessment.json",
          required: true,
          message: "assessment is unreadable",
        },
      ],
    };

    expect((await validateStage(stage, tmpDir)).passed).toBe(false);
  });

  it("passes a directory containing a large enough file", async () => {
    mkdirSync(join(tmpDir, "paper", "sections"), { recursive: true });
    writeFileSync(join(tmpDir, "paper", "sections", "01_intro.tex"), "x".repeat(300));

    const stage = {
      ...STAGES.full_draft,
      validators: [
        {
          type: "dir_has_content" as const,
          dir: "paper/sections",
          extension: ".tex",
          minBytes: 200,
          required: true,
          message: "nothing drafted",
        },
      ],
    };

    expect((await validateStage(stage, tmpDir)).passed).toBe(true);
  });

  it("fails a directory whose files are all below the size bar", async () => {
    mkdirSync(join(tmpDir, "paper", "sections"), { recursive: true });
    writeFileSync(join(tmpDir, "paper", "sections", "01_intro.tex"), "% stub\n");

    const stage = {
      ...STAGES.full_draft,
      validators: [
        {
          type: "dir_has_content" as const,
          dir: "paper/sections",
          extension: ".tex",
          minBytes: 200,
          required: true,
          message: "nothing drafted",
        },
      ],
    };

    expect((await validateStage(stage, tmpDir)).passed).toBe(false);
  });

  it("records an optional failure without blocking the stage", async () => {
    const stage = {
      ...STAGES.bootstrap,
      validators: [
        {
          type: "file_exists" as const,
          path: "nope.md",
          required: false,
          message: "advisory only",
        },
      ],
    };

    const result = await validateStage(stage, tmpDir);
    expect(result.passed).toBe(true);
    expect(result.failures).toHaveLength(0);
    expect(result.checks[0]?.passed).toBe(false);
  });

  it("requires every severity section in the independent review artifact", async () => {
    writeFileSync(
      join(tmpDir, ".paper-run", "review-findings.md"),
      "## Review summary\n\nReviewed.\n\n## Blocker findings\n\nNone.\n\n## Major findings\n\nA major issue.\n",
    );
    const stage = {
      ...STAGES.independent_review,
      validators: STAGES.independent_review.validators.filter(
        (validator) => validator.type !== "check_script",
      ),
    };

    const result = await validateStage(stage, tmpDir);
    expect(result.passed).toBe(false);
    expect(result.failures.join(" ")).toContain("Minor findings");
  });

  it("does not execute a malicious Makefile while validating publication artifacts", async () => {
    writeDefaultPublicationSources(tmpDir);
    writeFileSync(join(tmpDir, "paper.pdf"), pdf());
    writeFileSync(join(tmpDir, "Makefile"), "pdf:\n\t@printf compromised > make-ran\n");
    writeBuildProfile(tmpDir, {
      name: "test-pdf",
      command: ["make", "pdf", "VARIANT=draft"],
      output: "paper.pdf",
    });

    expect((await validateStage(publicationOnlyStage(), tmpDir)).passed).toBe(true);
    expect(existsSync(join(tmpDir, "make-ran"))).toBe(false);
  });

  it("executes a strictly declared build through controller-owned latexmk argv", async () => {
    writeDefaultPublicationSources(tmpDir);
    writeBuildProfile(tmpDir, {
      name: "test-pdf",
      command: ["make", "pdf", "VARIANT=draft"],
      output: "paper/paper.pdf",
    });
    const baseline = capturePublicationBaseline(tmpDir);
    const previousPath = process.env["PATH"];
    process.env["PATH"] = `${writeFakeLatexmk(tmpDir)}:${previousPath ?? ""}`;
    try {
      expect(await buildPublicationArtifacts(tmpDir, { baseline })).toEqual({ passed: true, diagnostic: "" });
      expect(readPublication(tmpDir)?.variants[0]?.status).toBe("completed");
      expect((await validateStage(publicationOnlyStage(), tmpDir)).passed).toBe(true);
    } finally {
      process.env["PATH"] = previousPath;
    }
  });

  it("refuses a build profile modified after the stage baseline", async () => {
    writeDefaultPublicationSources(tmpDir);
    writeBuildProfile(tmpDir, {
      name: "test-pdf",
      command: ["make", "pdf"],
      output: "paper/paper.pdf",
    });
    const baseline = capturePublicationBaseline(tmpDir);
    writeBuildProfile(tmpDir, {
      name: "test-pdf",
      command: ["make", "pdf", "VARIANT=draft"],
      output: "paper/paper.pdf",
    });

    const result = await buildPublicationArtifacts(tmpDir, { baseline });
    expect(result.passed).toBe(false);
    expect(result.diagnostic).toContain("differs from the stage baseline");
    expect(existsSync(join(tmpDir, "paper", "paper.pdf"))).toBe(false);
  });

  it("uses paper/main.pdf as the fallback output without executing make", async () => {
    writeDefaultPublicationSources(tmpDir);
    writeFileSync(join(tmpDir, "paper", "main.pdf"), pdf());
    writeFileSync(join(tmpDir, "Makefile"), "pdf:\n\t@printf built > make-pdf-ran\n");

    expect((await validateStage(publicationOnlyStage(), tmpDir)).passed).toBe(true);
    expect(existsSync(join(tmpDir, "make-pdf-ran"))).toBe(false);
  });

  it("requires every configured build to declare an output", async () => {
    writeDefaultPublicationSources(tmpDir);
    writeBuildProfile(tmpDir, {
      name: "missing-output",
      command: ["make", "pdf"],
    });

    const result = await validateStage(publicationOnlyStage(), tmpDir);
    expect(result.passed).toBe(false);
    expect(result.failures.join(" ")).toContain("missing output");
  });

  it("fails when the default output is missing", async () => {
    writeDefaultPublicationSources(tmpDir);

    const result = await validateStage(publicationOnlyStage(), tmpDir);
    expect(result.passed).toBe(false);
    expect(result.failures.join(" ")).toContain("output is missing or empty");
  });

  it("rejects arbitrary executables without running them or exposing argv", async () => {
    writeDefaultPublicationSources(tmpDir);
    writeBuildProfile(tmpDir, {
      name: "unsafe",
      command: ["sh", "-c", "printf super-secret > build-ran"],
      output: "paper.pdf",
    });
    const result = await validateStage(publicationOnlyStage(), tmpDir);
    expect(result.passed).toBe(false);
    expect(existsSync(join(tmpDir, "build-ran"))).toBe(false);
    expect(result.failures.join(" ")).not.toContain("super-secret");
  });

  it.each(["/tmp/paper.pdf", "../paper.pdf", ""])(
    "rejects unsafe configured output %j",
    async (output) => {
      writeDefaultPublicationSources(tmpDir);
      writeBuildProfile(tmpDir, {
        name: "unsafe-output",
        command: ["make", "pdf"],
        output,
      });
      expect((await validateStage(publicationOnlyStage(), tmpDir)).passed).toBe(false);
      expect(existsSync(join(tmpDir, "build-ran"))).toBe(false);
    },
  );

  it("rejects an output path that escapes through a symlink", async () => {
    const outside = mkdtempSync(join(tmpdir(), "paper-run-output-"));
    try {
      writeDefaultPublicationSources(tmpDir);
      symlinkSync(outside, join(tmpDir, "linked-output"));
      writeFileSync(join(outside, "paper.pdf"), pdf());
      writeBuildProfile(tmpDir, {
        name: "symlink-output",
        command: ["make", "pdf"],
        output: "linked-output/paper.pdf",
      });
      expect((await validateStage(publicationOnlyStage(), tmpDir)).passed).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects an output older than source_root contents", async () => {
    writeDefaultPublicationSources(tmpDir);
    writeFileSync(join(tmpDir, "paper.pdf"), pdf());
    writeBuildProfile(tmpDir, {
      name: "stale-output",
      command: ["make", "pdf"],
      output: "paper.pdf",
    });
    const old = new Date("2020-01-01T00:00:00Z");
    const current = new Date("2021-01-01T00:00:00Z");
    utimesSync(join(tmpDir, "paper.pdf"), old, old);
    utimesSync(join(tmpDir, "paper", "main.tex"), current, current);

    const result = await validateStage(publicationOnlyStage(), tmpDir);
    expect(result.passed).toBe(false);
    expect(result.failures.join(" ")).toContain("output is stale");
  });

  it("accepts a nonempty regular output current with all declared sources", async () => {
    writeDefaultPublicationSources(tmpDir);
    writeFileSync(join(tmpDir, "paper.pdf"), pdf());
    writeBuildProfile(tmpDir, {
      name: "changed-output",
      command: ["make", "pdf"],
      output: "paper.pdf",
    });
    expect((await validateStage(publicationOnlyStage(), tmpDir)).passed).toBe(true);
  });

  it("rejects a non-PDF output declaration", async () => {
    writeDefaultPublicationSources(tmpDir);
    writeFileSync(join(tmpDir, "paper.bin"), pdf());
    writeBuildProfile(tmpDir, {
      name: "wrong-extension",
      command: ["make", "pdf"],
      output: "paper.bin",
    });

    const result = await validateStage(publicationOnlyStage(), tmpDir);
    expect(result.failures.join(" ")).toContain("must be a .pdf file");
  });

  it.each(["not a pdf", "%PDF-1.7\nmissing eof"])(
    "rejects invalid PDF structure",
    async (content) => {
      writeDefaultPublicationSources(tmpDir);
      writeFileSync(join(tmpDir, "paper.pdf"), content);
      writeBuildProfile(tmpDir, {
        name: "invalid-pdf",
        command: ["make", "pdf"],
        output: "paper.pdf",
      });

      const result = await validateStage(publicationOnlyStage(), tmpDir);
      expect(result.failures.join(" ")).toContain("structurally valid PDF");
    },
  );

  it("requires an artifact digest to change from the stage-turn baseline", async () => {
    writeDefaultPublicationSources(tmpDir);
    writeFileSync(join(tmpDir, "paper.pdf"), pdf("before"));
    writeBuildProfile(tmpDir, {
      name: "stage-output",
      command: ["make", "pdf"],
      output: "paper.pdf",
    });
    const baseline = capturePublicationBaseline(tmpDir);

    const unchanged = await validateStage(publicationOnlyStage(), tmpDir, {
      publicationBaseline: baseline,
    });
    expect(unchanged.failures.join(" ")).toContain("was not rebuilt during this stage");

    writeFileSync(join(tmpDir, "paper.pdf"), pdf("after"));
    expect(
      (await validateStage(publicationOnlyStage(), tmpDir, { publicationBaseline: baseline })).passed,
    ).toBe(true);
  });

  it("rejects an output declaration changed after baseline capture", async () => {
    writeDefaultPublicationSources(tmpDir);
    writeFileSync(join(tmpDir, "first.pdf"), pdf("first"));
    writeBuildProfile(tmpDir, {
      name: "stage-output",
      command: ["make", "pdf"],
      output: "first.pdf",
    });
    const baseline = capturePublicationBaseline(tmpDir);
    writeFileSync(join(tmpDir, "second.pdf"), pdf("second"));
    writeBuildProfile(tmpDir, {
      name: "stage-output",
      command: ["make", "pdf"],
      output: "second.pdf",
    });

    const result = await validateStage(publicationOnlyStage(), tmpDir, {
      publicationBaseline: baseline,
    });
    expect(result.failures.join(" ")).toContain("paper-build.json changed during this stage");
  });

  it("does not include validator stdout or stderr in failure diagnostics", async () => {
    mkdirSync(join(tmpDir, ".agents", "tools"), { recursive: true });
    writeFileSync(
      join(tmpDir, ".agents", "tools", "check-secret.py"),
      "import sys\nprint('stdout-secret')\nprint('stderr-secret', file=sys.stderr)\nraise SystemExit(3)\n",
    );
    execaSync("git", ["init"], { cwd: tmpDir });
    await initializeHarnessTrust(tmpDir, "test");
    const stage = {
      ...STAGES.bootstrap,
      validators: [
        {
          type: "check_script" as const,
          script: "check-secret.py",
          required: true,
          message: "check failed",
        },
      ],
    };

    const result = await validateStage(stage, tmpDir);
    expect(result.passed).toBe(false);
    expect(result.failures.join(" ")).toContain("exited with code 3");
    expect(result.failures.join(" ")).not.toContain("stdout-secret");
    expect(result.failures.join(" ")).not.toContain("stderr-secret");
  });
});

// ---------------------------------------------------------------------------
// Required reading and per-section prompts
// ---------------------------------------------------------------------------

describe("required reading", () => {
  const ctx = { mode: "autonomous" as const, history: [] };

  it("states the files as an instruction, not an invitation", () => {
    const prompt = renderStagePrompt(STAGES.full_draft, ctx);

    expect(prompt).toContain("## Required reading");
    expect(prompt).toContain("not");
    expect(prompt).toContain(".agents/knowledge/scientific-writing.md");
    // The point of the mechanism: the deepest guidance is named outright
    // instead of being left behind two conditional hops.
    expect(prompt).toContain("prose-quality-guardrails.md");
  });

  it("tells the agent to report a missing file rather than pretend", () => {
    expect(renderStagePrompt(STAGES.paper_plan, ctx)).toContain(
      "say so in your summary rather",
    );
  });

  it("omits the heading for a stage that names no reading", () => {
    expect(renderStagePrompt(STAGES.bootstrap, ctx)).not.toContain("## Required reading");
  });
});

describe("renderSectionPrompt", () => {
  const ctx = { mode: "autonomous" as const, history: [] };
  const section = { path: "paper/sections/04_method.tex", index: 3, total: 7 };

  it("names the one file this turn is for", () => {
    const prompt = renderSectionPrompt(STAGES.full_draft, ctx, section);

    expect(prompt).toContain("section 3/7");
    expect(prompt).toContain("paper/sections/04_method.tex");
    expect(prompt).toContain("Do not draft, revise, or reorganise the other sections");
  });

  it("points at the section responsibilities agreed earlier", () => {
    const prompt = renderSectionPrompt(STAGES.full_draft, ctx, section);
    expect(prompt).toContain("Section");
    expect(prompt).toContain("responsibilities");
  });

  it("carries the owner skill, required reading, and the fabrication rule", () => {
    const prompt = renderSectionPrompt(STAGES.full_draft, ctx, section);

    expect(prompt).toContain(".agents/skills/section-writing/SKILL.md");
    expect(prompt).toContain("## Required reading");
    expect(prompt).toContain("Never invent facts");
  });

  it("passes on a partial material verdict", () => {
    const prompt = renderSectionPrompt(
      STAGES.full_draft,
      { ...ctx, materialVerdict: "partial" },
      section,
    );
    expect(prompt).toContain("**partial**");
    expect(prompt).toContain("TODO(paper-run)");
  });

  it("prioritises human guidance when a gate supplied it", () => {
    const prompt = renderSectionPrompt(
      STAGES.full_draft,
      { ...ctx, humanGuidance: "lead with the failure case" },
      section,
    );
    expect(prompt).toContain("lead with the failure case");
    expect(prompt).toContain("## Guidance from the human");
  });
});
