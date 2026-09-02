/**
 * Findings survive the stage that has to answer them.
 *
 * Revision needs write access to `review-findings.json` to record how it
 * disposed of each finding. The same access is enough to settle a blocker by
 * demoting it, and until now nothing looked.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execaSync } from "execa";

import { validateStage } from "../../src/pipeline/validators.js";
import { STAGES } from "../../src/pipeline/stages.js";
import type { Stage, Validator } from "../../src/pipeline/stages.js";
import { PAPER_RUN_DIR } from "../../src/utils/constants.js";

let tmpDir: string;

const BLOCKER = {
  id: "B1",
  severity: "blocker",
  location: "paper/sections/05_exp.tex",
  summary: "The 12% claim has no matching row in Table 2.",
};

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "paper-run-findings-"));
  mkdirSync(join(tmpDir, PAPER_RUN_DIR), { recursive: true });
  execaSync("git", ["init"], { cwd: tmpDir });
  execaSync("git", ["config", "user.email", "t@t.com"], { cwd: tmpDir });
  execaSync("git", ["config", "user.name", "T"], { cwd: tmpDir });
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

/** Commit the current findings, standing in for the review's checkpoint. */
function checkpoint(): void {
  execaSync("git", ["add", "-A"], { cwd: tmpDir });
  execaSync("git", ["commit", "-m", "review"], { cwd: tmpDir });
}

function stageWith(validator: Validator): Stage {
  return { ...STAGES.revision, validators: [validator] };
}

const INTEGRITY: Validator = {
  type: "findings_integrity",
  required: true,
  message: "findings altered",
};

const ADDRESSED: Validator = {
  type: "findings_addressed",
  severities: ["blocker", "major"],
  maxDeferred: { blocker: 0, major: 2 },
  required: true,
  message: "findings unaddressed",
};

describe("findings_integrity", () => {
  it("accepts a resolution added after the review", async () => {
    writeFindings([BLOCKER]);
    checkpoint();
    writeFindings([{ ...BLOCKER, resolution: { status: "fixed", note: "rewrote the claim" } }]);

    expect((await validateStage(stageWith(INTEGRITY), tmpDir)).passed).toBe(true);
  });

  it("refuses a blocker quietly demoted to minor", async () => {
    writeFindings([BLOCKER]);
    checkpoint();
    writeFindings([{ ...BLOCKER, severity: "minor" }]);

    const result = await validateStage(stageWith(INTEGRITY), tmpDir);
    expect(result.passed).toBe(false);
    expect(result.failures.join(" ")).toContain("B1 had its severity changed");
  });

  it("refuses a finding that simply disappeared", async () => {
    writeFindings([BLOCKER, { ...BLOCKER, id: "M1", severity: "major" }]);
    checkpoint();
    writeFindings([BLOCKER]);

    const result = await validateStage(stageWith(INTEGRITY), tmpDir);
    expect(result.passed).toBe(false);
    expect(result.failures.join(" ")).toContain("M1 was removed");
  });

  it("passes when nothing was ever committed to compare against", async () => {
    writeFindings([BLOCKER]);
    expect((await validateStage(stageWith(INTEGRITY), tmpDir)).passed).toBe(true);
  });
});

describe("deferral caps", () => {
  it("refuses to let a blocker be deferred", async () => {
    writeFindings([
      { ...BLOCKER, resolution: { status: "deferred", note: "the ablation is missing" } },
    ]);

    const result = await validateStage(stageWith(ADDRESSED), tmpDir);
    expect(result.passed).toBe(false);
    expect(result.failures.join(" ")).toContain("B1");
  });

  it("accepts a fixed blocker", async () => {
    writeFindings([{ ...BLOCKER, resolution: { status: "fixed", note: "matched Table 2" } }]);
    expect((await validateStage(stageWith(ADDRESSED), tmpDir)).passed).toBe(true);
  });

  it("allows a bounded number of deferred majors and refuses more", async () => {
    const major = (id: string) => ({
      ...BLOCKER,
      id,
      severity: "major",
      resolution: { status: "deferred", note: "needs evidence the materials lack" },
    });

    writeFindings([major("M1"), major("M2")]);
    expect((await validateStage(stageWith(ADDRESSED), tmpDir)).passed).toBe(true);

    writeFindings([major("M1"), major("M2"), major("M3")]);
    const result = await validateStage(stageWith(ADDRESSED), tmpDir);
    expect(result.passed).toBe(false);
    expect(result.failures.join(" ")).toContain("M3");
  });
});
