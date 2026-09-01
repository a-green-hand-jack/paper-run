/**
 * Structured review findings, and the check that they were acted on.
 *
 * The Markdown report could only ever be validated for having headings, so a
 * revision turn could skip the hardest finding and still pass. These tests pin
 * the two behaviours that close that: the reviewer has to leave a record, and
 * the revision has to dispose of every blocker and major finding in it.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { STAGES } from "../../src/pipeline/stages.js";
import type { Stage, Validator } from "../../src/pipeline/stages.js";
import { validateStage } from "../../src/pipeline/validators.js";
import { readReviewFindings } from "../../src/state/store.js";
import { PAPER_RUN_DIR } from "../../src/utils/constants.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "paper-run-findings-"));
  mkdirSync(join(tmpDir, PAPER_RUN_DIR), { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeFindings(findings: unknown[]): void {
  writeFileSync(
    join(tmpDir, PAPER_RUN_DIR, "review-findings.json"),
    JSON.stringify({
      schema_version: "paper-run-review-findings-v1",
      reviewed_at: new Date().toISOString(),
      findings,
    }),
  );
}

function stageWith(validator: Validator): Stage {
  return { ...STAGES.revision, validators: [validator] };
}

const REVIEW_FINDINGS: Validator = {
  type: "review_findings",
  required: true,
  message: "no structured findings",
};

const ADDRESSED: Validator = {
  type: "findings_addressed",
  severities: ["blocker", "major"],
  required: true,
  message: "findings left unaddressed",
};

const BLOCKER = {
  id: "B1",
  severity: "blocker",
  location: "paper/sections/05_exp.tex",
  summary: "The 12% claim has no matching row in Table 2.",
  evidence: "Table 2 reports 3.4% and 5.1%.",
};

describe("review_findings", () => {
  it("fails when the reviewer wrote no record", async () => {
    const result = await validateStage(stageWith(REVIEW_FINDINGS), tmpDir);
    expect(result.passed).toBe(false);
    expect(result.failures.join(" ")).toContain("the file was not written");
  });

  it("fails a record that does not match the schema", async () => {
    writeFileSync(
      join(tmpDir, PAPER_RUN_DIR, "review-findings.json"),
      JSON.stringify({ schema_version: "paper-run-review-findings-v1", findings: "lots" }),
    );
    expect((await validateStage(stageWith(REVIEW_FINDINGS), tmpDir)).passed).toBe(false);
  });

  it("accepts an empty findings array — a sound manuscript is a valid review", async () => {
    writeFindings([]);
    expect((await validateStage(stageWith(REVIEW_FINDINGS), tmpDir)).passed).toBe(true);
  });

  it("accepts a well-formed record", async () => {
    writeFindings([BLOCKER]);
    expect((await validateStage(stageWith(REVIEW_FINDINGS), tmpDir)).passed).toBe(true);
    expect(readReviewFindings(tmpDir)?.findings[0]?.id).toBe("B1");
  });
});

describe("findings_addressed", () => {
  it("passes when no structured findings exist, so older runs are not stranded", async () => {
    const result = await validateStage(stageWith(ADDRESSED), tmpDir);
    expect(result.passed).toBe(true);
  });

  it("fails while a blocker has no resolution", async () => {
    writeFindings([BLOCKER]);
    const result = await validateStage(stageWith(ADDRESSED), tmpDir);
    expect(result.passed).toBe(false);
    expect(result.failures.join(" ")).toContain("B1");
  });

  it("accepts a deferral with a reason, not only a fix", async () => {
    writeFindings([
      { ...BLOCKER, resolution: { status: "deferred", note: "needs the ablation EXPERIMENTS.md marks unresolved" } },
    ]);
    expect((await validateStage(stageWith(ADDRESSED), tmpDir)).passed).toBe(true);
  });

  it("rejects a resolution with an empty note", async () => {
    writeFindings([{ ...BLOCKER, resolution: { status: "fixed", note: "" } }]);
    // The record no longer parses, which the validator reports rather than
    // silently treating as "no findings".
    const result = await validateStage(stageWith(ADDRESSED), tmpDir);
    expect(result.passed).toBe(false);
    expect(result.failures.join(" ")).toContain("unreadable");
  });

  it("ignores minor findings", async () => {
    writeFindings([{ ...BLOCKER, id: "m1", severity: "minor" }]);
    expect((await validateStage(stageWith(ADDRESSED), tmpDir)).passed).toBe(true);
  });

  it("names the outstanding findings so the remediation turn knows which", async () => {
    writeFindings([
      { ...BLOCKER, id: "B1" },
      { ...BLOCKER, id: "M1", severity: "major" },
      { ...BLOCKER, id: "M2", severity: "major", resolution: { status: "fixed", note: "rewrote the claim" } },
    ]);
    const result = await validateStage(stageWith(ADDRESSED), tmpDir);
    expect(result.passed).toBe(false);
    const failure = result.failures.join(" ");
    expect(failure).toContain("B1");
    expect(failure).toContain("M1");
    expect(failure).not.toContain("M2");
  });
});

describe("prose_quality validator", () => {
  it("reports mechanical prose without blocking, since it ships advisory", async () => {
    const sections = join(tmpDir, "paper", "sections");
    mkdirSync(sections, { recursive: true });
    writeFileSync(
      join(sections, "02_intro.tex"),
      "It is important to note that the model works. In the realm of vision, it is worth noting that it also works.",
    );

    const stage = stageWith({
      type: "prose_quality",
      required: false,
      message: "mechanical prose",
    });
    const result = await validateStage(stage, tmpDir);

    expect(result.passed).toBe(true);
    const check = result.checks.find((c) => c.name === "prose-quality");
    expect(check?.passed).toBe(false);
    expect(check?.message).toContain("opening_filler");
  });

  it("passes a manuscript with no mechanical tells", async () => {
    const sections = join(tmpDir, "paper", "sections");
    mkdirSync(sections, { recursive: true });
    writeFileSync(join(sections, "02_intro.tex"), "We study how retrieval depth changes answer accuracy.");

    const stage = stageWith({ type: "prose_quality", required: false, message: "mechanical prose" });
    const result = await validateStage(stage, tmpDir);
    expect(result.checks.find((c) => c.name === "prose-quality")?.passed).toBe(true);
  });
});
