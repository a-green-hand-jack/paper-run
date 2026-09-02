/**
 * Material assessment tests.
 *
 * This stage is the only thing standing between thin materials and a fluent,
 * partly-invented paper, so the tests lean on the cases where an agent would
 * be tempted to overstate readiness — and on the reconciliation that catches
 * it.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";

import {
  ASSESSMENT_CRITERIA,
  renderAssessmentPrompt,
  discoverMaterials,
  inventoryMaterials,
  hasBrief,
  evaluateAssessment,
  reconcileVerdict,
  formatBlockReport,
  parseAssessment,
  mustStopBeforeDrafting,
  isBlockedByUnusableMaterials,
} from "../../src/pipeline/material-assessment.js";
import { generateGatePreset } from "../../src/state/gate-presets.js";
import type { Assessment } from "../../src/state/schema.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeAssessment(overrides: Partial<Assessment> = {}): Assessment {
  return {
    schema_version: "paper-run-assessment-v1",
    verdict: "usable",
    criteria: {
      research_question: { rating: "sufficient", evidence: "stated in brief" },
      evidence: { rating: "sufficient", evidence: "3 experiments with results" },
      venue: { rating: "sufficient", evidence: "NeurIPS named" },
      figures_tables: { rating: "sufficient", evidence: "4 figures present" },
      related_work: { rating: "sufficient", evidence: "40 references" },
    },
    summary: "Materials are complete.",
    missing_for_usable: [],
    can_proceed_with: ["all sections"],
    blockers: [],
    assessed_files: ["BRIEF.md", "EXPERIMENTS.md"],
    assessed_at: "2026-08-29T10:00:00.000Z",
    ...overrides,
  };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "paper-run-material-"));
  mkdirSync(join(tmpDir, ".paper-run"), { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeAssessment(value: unknown): void {
  writeFileSync(
    join(tmpDir, ".paper-run", "assessment.json"),
    typeof value === "string" ? value : JSON.stringify(value, null, 2),
  );
}

// ---------------------------------------------------------------------------
// Criteria
// ---------------------------------------------------------------------------

describe("assessment criteria", () => {
  it("covers the five dimensions", () => {
    expect(ASSESSMENT_CRITERIA.map((c) => c.key)).toEqual([
      "research_question",
      "evidence",
      "venue",
      "figures_tables",
      "related_work",
    ]);
  });

  it("gives every criterion all three rating descriptions", () => {
    for (const c of ASSESSMENT_CRITERIA) {
      expect(c.sufficient, c.key).toBeTruthy();
      expect(c.partial, c.key).toBeTruthy();
      expect(c.absent, c.key).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

describe("renderAssessmentPrompt", () => {
  it("lists every criterion with its rating scale", () => {
    const prompt = renderAssessmentPrompt({ materialFiles: ["BRIEF.md"], briefPresent: true });
    for (const c of ASSESSMENT_CRITERIA) {
      expect(prompt, c.key).toContain(c.key);
      expect(prompt).toContain(c.question);
    }
  });

  it("frames unusable as a correct answer, not a failure", () => {
    // The model's default pull is to be helpful and proceed. The prompt has to
    // actively make an honest refusal feel like doing the job.
    const prompt = renderAssessmentPrompt({ materialFiles: [], briefPresent: true });
    expect(prompt).toContain("it is the job");
    expect(prompt).toContain("Do not stretch to `partial`");
  });

  it("forbids drafting during the assessment turn", () => {
    const prompt = renderAssessmentPrompt({ materialFiles: [], briefPresent: true });
    expect(prompt).toContain("Do not write");
  });

  it("flags a missing brief as close to disqualifying", () => {
    const prompt = renderAssessmentPrompt({ materialFiles: [], briefPresent: false });
    expect(prompt).toContain("close to disqualifying");
  });

  it("lists discovered files, and says so when there are none", () => {
    const withFiles = renderAssessmentPrompt({
      materialFiles: ["BRIEF.md", "materials/results.csv"],
      briefPresent: true,
    });
    expect(withFiles).toContain("materials/results.csv");

    const without = renderAssessmentPrompt({ materialFiles: [], briefPresent: true });
    expect(without).toContain("No material files were found");
  });

  it("names the exact output path and schema version", () => {
    const prompt = renderAssessmentPrompt({ materialFiles: [], briefPresent: true });
    expect(prompt).toContain(".paper-run/assessment.json");
    expect(prompt).toContain("paper-run-assessment-v1");
    expect(prompt).toContain("owned by paper-run itself");
    expect(prompt).toContain("do not stop to request another skill");
  });
});

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

describe("discoverMaterials", () => {
  it("finds contracts and material directories", () => {
    writeFileSync(join(tmpDir, "BRIEF.md"), "a brief");
    mkdirSync(join(tmpDir, "materials"), { recursive: true });
    writeFileSync(join(tmpDir, "materials", "results.csv"), "a,b\n1,2\n");

    const found = discoverMaterials(tmpDir);
    expect(found).toContain("BRIEF.md");
    expect(found).toContain(join("materials", "results.csv"));
  });

  it("skips empty files and dotfiles", () => {
    mkdirSync(join(tmpDir, "materials"), { recursive: true });
    writeFileSync(join(tmpDir, "materials", "empty.csv"), "");
    writeFileSync(join(tmpDir, "materials", ".hidden"), "x");
    writeFileSync(join(tmpDir, "materials", "real.csv"), "data");

    const found = discoverMaterials(tmpDir);
    expect(found.some((f) => f.includes("empty.csv"))).toBe(false);
    expect(found.some((f) => f.includes(".hidden"))).toBe(false);
    expect(found.some((f) => f.includes("real.csv"))).toBe(true);
  });

  it("caps the list so a large data tree cannot flood the prompt", () => {
    mkdirSync(join(tmpDir, "data"), { recursive: true });
    for (let i = 0; i < 40; i++) {
      writeFileSync(join(tmpDir, "data", `f${i}.csv`), "x");
    }

    expect(discoverMaterials(tmpDir, 10)).toHaveLength(10);
  });

  it("returns an empty list for a bare project", () => {
    expect(discoverMaterials(tmpDir)).toEqual([]);
  });
});

describe("hasBrief", () => {
  it("is false when BRIEF.md is absent", () => {
    expect(hasBrief(tmpDir)).toBe(false);
  });

  it("is false when BRIEF.md is only a stub", () => {
    writeFileSync(join(tmpDir, "BRIEF.md"), "# Brief\n");
    expect(hasBrief(tmpDir)).toBe(false);
  });

  it("is true for a real brief", () => {
    writeFileSync(join(tmpDir, "BRIEF.md"), "x".repeat(200));
    expect(hasBrief(tmpDir)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// reconcileVerdict — the anti-overstatement check
// ---------------------------------------------------------------------------

describe("reconcileVerdict", () => {
  it("accepts a consistent usable verdict", () => {
    expect(reconcileVerdict(makeAssessment())).toBe("usable");
  });

  it("accepts a consistent partial verdict", () => {
    const a = makeAssessment({
      verdict: "partial",
      criteria: {
        ...makeAssessment().criteria,
        evidence: { rating: "partial", evidence: "2 of 5 experiments done" },
      },
      missing_for_usable: ["experiment 3"],
    });
    expect(reconcileVerdict(a)).toBe("partial");
  });

  it("downgrades usable to unusable when blockers are listed", () => {
    // Declaring usable while reporting blockers is self-contradictory; the
    // blockers are the more trustworthy signal.
    const a = makeAssessment({ verdict: "usable", blockers: ["no results at all"] });
    expect(reconcileVerdict(a)).toBe("unusable");
  });

  it("downgrades partial to unusable when blockers are listed", () => {
    const a = makeAssessment({ verdict: "partial", blockers: ["nothing to write about"] });
    expect(reconcileVerdict(a)).toBe("unusable");
  });

  it("returns unusable when both the question and the evidence are absent", () => {
    const a = makeAssessment({
      verdict: "partial",
      criteria: {
        ...makeAssessment().criteria,
        research_question: { rating: "absent", evidence: "none found" },
        evidence: { rating: "absent", evidence: "no results" },
      },
    });
    expect(reconcileVerdict(a)).toBe("unusable");
  });

  it("downgrades usable to partial when any criterion is absent", () => {
    const a = makeAssessment({
      verdict: "usable",
      criteria: {
        ...makeAssessment().criteria,
        figures_tables: { rating: "absent", evidence: "no figures" },
      },
    });
    expect(reconcileVerdict(a)).toBe("partial");
  });

  it("downgrades usable to partial when any criterion is merely partial", () => {
    const a = makeAssessment({
      verdict: "usable",
      criteria: {
        ...makeAssessment().criteria,
        related_work: { rating: "partial", evidence: "sparse references" },
      },
    });
    expect(reconcileVerdict(a)).toBe("partial");
  });

  it("never upgrades a verdict", () => {
    // A cautious assessment is left alone: understating readiness is not the
    // failure mode this guard exists for.
    const cautious = makeAssessment({ verdict: "partial" });
    expect(reconcileVerdict(cautious)).toBe("partial");

    const veryCautious = makeAssessment({ verdict: "unusable", blockers: [] });
    expect(reconcileVerdict(veryCautious)).toBe("unusable");
  });
});

// ---------------------------------------------------------------------------
// evaluateAssessment
// ---------------------------------------------------------------------------

describe("evaluateAssessment", () => {
  it("reports when no assessment was written", () => {
    const outcome = evaluateAssessment(tmpDir);
    expect(outcome.blocked).toBe(false);
    expect(outcome.reason).toContain("no assessment.json");
    expect(outcome.assessment).toBeUndefined();
  });

  it("reports an unparseable assessment without blocking", () => {
    // A malformed file is a remediation case, not a verdict.
    writeAssessment("{not json");
    const outcome = evaluateAssessment(tmpDir);
    expect(outcome.blocked).toBe(false);
    expect(outcome.reason).toMatch(/invalid/i);
  });

  it("reports a schema-invalid assessment without blocking", () => {
    writeAssessment({ schema_version: "paper-run-assessment-v1", verdict: "maybe" });
    const outcome = evaluateAssessment(tmpDir);
    expect(outcome.blocked).toBe(false);
    expect(outcome.reason).toMatch(/invalid/i);
  });

  it("passes a usable verdict through", () => {
    writeAssessment(makeAssessment());
    const outcome = evaluateAssessment(tmpDir);
    expect(outcome.verdict).toBe("usable");
    expect(outcome.blocked).toBe(false);
    expect(outcome.downgradedFrom).toBeUndefined();
  });

  it("passes a partial verdict through without blocking", () => {
    writeAssessment(
      makeAssessment({
        verdict: "partial",
        criteria: {
          ...makeAssessment().criteria,
          evidence: { rating: "partial", evidence: "half the experiments" },
        },
        missing_for_usable: ["experiment 3 results"],
        can_proceed_with: ["introduction", "methods"],
      }),
    );

    const outcome = evaluateAssessment(tmpDir);
    expect(outcome.verdict).toBe("partial");
    expect(outcome.blocked).toBe(false);
  });

  it("blocks on an unusable verdict and explains why", () => {
    writeAssessment(
      makeAssessment({
        verdict: "unusable",
        blockers: ["no experimental results of any kind"],
        summary: "There is a topic but no work behind it.",
      }),
    );

    const outcome = evaluateAssessment(tmpDir);
    expect(outcome.blocked).toBe(true);
    expect(outcome.verdict).toBe("unusable");
    expect(outcome.reason).toContain("no experimental results");
  });

  it("blocks when reconciliation overrides an optimistic verdict", () => {
    // The agent said usable; its own findings say otherwise.
    writeAssessment(makeAssessment({ verdict: "usable", blockers: ["nothing to report on"] }));

    const outcome = evaluateAssessment(tmpDir);
    expect(outcome.blocked).toBe(true);
    expect(outcome.verdict).toBe("unusable");
    expect(outcome.downgradedFrom).toBe("usable");
  });
});

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

describe("formatBlockReport", () => {
  it("says what is missing and what would unblock it", () => {
    const report = formatBlockReport(
      makeAssessment({
        verdict: "unusable",
        summary: "No results exist yet.",
        blockers: ["no experimental results"],
        missing_for_usable: ["run the experiments", "produce figure 1"],
        criteria: {
          ...makeAssessment().criteria,
          evidence: { rating: "absent", evidence: "none" },
        },
      }),
    );

    expect(report).toContain("writing did not begin");
    expect(report).toContain("No results exist yet.");
    expect(report).toContain("no experimental results");
    expect(report).toContain("run the experiments");
    expect(report).toContain("Missing entirely: evidence");
  });

  it("stays readable when the optional lists are empty", () => {
    const report = formatBlockReport(
      makeAssessment({ verdict: "unusable", summary: "Nothing usable here." }),
    );
    expect(report).toContain("Nothing usable here.");
    expect(report.endsWith("\n")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseAssessment
// ---------------------------------------------------------------------------

describe("parseAssessment", () => {
  it("accepts a valid assessment", () => {
    const result = parseAssessment(makeAssessment());
    expect(result.ok).toBe(true);
  });

  it("reports the offending field path on failure", () => {
    const result = parseAssessment({ ...makeAssessment(), verdict: "great" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("verdict");
  });

  it("rejects a wrong schema version", () => {
    const result = parseAssessment({ ...makeAssessment(), schema_version: "v2" });
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The hard stop
// ---------------------------------------------------------------------------

describe("the unusable hard stop", () => {
  it("stops on unusable and only on unusable", () => {
    expect(mustStopBeforeDrafting("unusable")).toBe(true);
    expect(mustStopBeforeDrafting("partial")).toBe(false);
    expect(mustStopBeforeDrafting("usable")).toBe(false);
    expect(mustStopBeforeDrafting(undefined)).toBe(false);
  });

  it("does not depend on the gate policy, which is auto in autonomous mode", () => {
    // The autonomous preset marks every gate auto, so a run relying on the
    // gate to catch this would sail into drafting with nothing to write from.
    // The stop has to come from the verdict itself.
    const autonomous = generateGatePreset("autonomous");
    expect(autonomous.gates["material_assessment"]?.policy).toBe("auto");
    expect(mustStopBeforeDrafting("unusable")).toBe(true);
  });

  it("blocks every stage that produces manuscript substance", () => {
    for (const stage of [
      "self_review",
      "paper_plan",
      "evidence_reconciliation",
      "paper_plan",
      "full_draft",
      "evidence_reconciliation",
      "self_review",
      "independent_review",
      "revision",
      "publication_build",
      "paper_candidate",
    ]) {
      expect(isBlockedByUnusableMaterials(stage, "unusable"), stage).toBe(true);
    }
  });

  it("still allows re-running the assessment, so a user can recover", () => {
    // Adding materials and re-assessing is the recovery path; blocking it
    // would strand the run permanently.
    expect(isBlockedByUnusableMaterials("material_assessment", "unusable")).toBe(false);
    expect(isBlockedByUnusableMaterials("bootstrap", "unusable")).toBe(false);
  });

  it("blocks nothing when materials are usable or partial", () => {
    for (const verdict of ["usable", "partial"] as const) {
      expect(isBlockedByUnusableMaterials("full_draft", verdict), verdict).toBe(false);
    }
  });
});

describe("the materials listing is fair across directories", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "paper-run-inventory-"));
    writeFileSync(join(root, "BRIEF.md"), "# Brief\n\nWrite the paper.\n");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function supply(relative: string, body = "x"): void {
    const path = join(root, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
  }

  it("does not let one large directory consume the whole budget", () => {
    // pwb-0011's exact shape: `materials/code/` sorts first and holds 58
    // files, so a flat depth-first cap of 60 listed nothing else. The
    // assessment reported the tables and figures absent and returned
    // `unusable` for a task that supplies four tables and three figures.
    for (let i = 0; i < 58; i += 1) supply(`materials/code/configs/c${i}.yaml`);
    for (const name of ["table_ea", "table_jh", "table_qa", "table_rn"]) {
      supply(`materials/tables/${name}.tex`);
    }
    for (const name of ["plot", "plot_horizontal", "teaser"]) {
      supply(`materials/figures/${name}.jpg`);
    }
    supply("materials/references.bib", "@article{a, year={2026}}");
    supply("materials/research_overview.md", "# Overview");

    const inventory = inventoryMaterials(root, 60);

    for (const name of ["table_ea", "table_jh", "table_qa", "table_rn"]) {
      expect(inventory.files).toContain(`materials/tables/${name}.tex`);
    }
    expect(inventory.files).toContain("materials/figures/plot.jpg");
    expect(inventory.files).toContain("materials/references.bib");
    expect(inventory.files).toContain("materials/research_overview.md");
  });

  it("reports what it could not name rather than dropping it silently", () => {
    for (let i = 0; i < 200; i += 1) supply(`materials/code/f${i}.py`);
    supply("materials/tables/table_ea.tex");

    const inventory = inventoryMaterials(root, 60);

    expect(inventory.total).toBe(202); // 200 + 1 table + BRIEF.md
    expect(inventory.files.length).toBeLessThanOrEqual(60);
    expect(inventory.elided.some((entry) => entry.dir === "materials/code")).toBe(true);
  });

  it("names every file when they all fit", () => {
    supply("materials/tables/table_ea.tex");
    supply("materials/figures/plot.jpg");

    const inventory = inventoryMaterials(root, 60);

    expect(inventory.elided).toEqual([]);
    expect(inventory.files).toEqual([
      "BRIEF.md",
      "materials/figures/plot.jpg",
      "materials/tables/table_ea.tex",
    ]);
  });

  it("tells the agent when the listing is a subset, so absence is not inferred from it", () => {
    const prompt = renderAssessmentPrompt({
      materialFiles: ["BRIEF.md", "materials/code/a.py"],
      briefPresent: true,
      elidedMaterials: [{ dir: "materials/code", omitted: 140 }],
      totalMaterials: 142,
    });

    expect(prompt).toContain("This listing is truncated");
    expect(prompt).toContain("140 further file(s)");
    expect(prompt).toContain("never");
    // It must not send the agent off to enumerate the tree: a headless run
    // hit an external_directory permission block doing exactly that, and
    // material sufficiency never needed the other 140 files anyway.
    expect(prompt).not.toContain("List them yourself");
    expect(prompt).toContain("you do not need to enumerate the rest");
  });

  it("says nothing about truncation when there is none", () => {
    const prompt = renderAssessmentPrompt({
      materialFiles: ["BRIEF.md", "materials/tables/table_ea.tex"],
      briefPresent: true,
    });

    expect(prompt).toContain("Files available to you:");
    expect(prompt).not.toContain("truncated");
  });
});
