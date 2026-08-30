import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { execaSync } from "execa";

import {
  captureLockedContractBaseline,
  checkLockedContracts,
  formatLockedContractFailure,
} from "../../src/pipeline/locked-contract.js";

let tmpDir: string;

function paper(locked: string): string {
  return `# Paper Contract

## Paper identity

- Working title: Guarded Paper
- Target venue: TestConf
- Paper type: Full paper
- Intended readers: Pipeline authors
- One-sentence positioning: A positioning sentence.

## Operating mode

- Mode: autonomous

## What readers should believe

### Central thesis \u2014 locked

Contracts must be checked from Git.

### Contributions

- A deterministic guard.

## What must not change silently

Current locked items:

${locked}

## Story and structure

### Narrative arc — bounded

Problem then solution.

## Authors and identity

- Author list: Ada Example
`;
}

function commitContracts(locked: string): void {
  writeFileSync(join(tmpDir, "BRIEF.md"), "Human brief.\n");
  writeFileSync(join(tmpDir, "PAPER.md"), paper(locked));
  execaSync("git", ["add", "BRIEF.md", "PAPER.md"], { cwd: tmpDir });
  execaSync("git", ["commit", "-m", "contracts"], { cwd: tmpDir });
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "paper-run-lock-"));
  mkdirSync(tmpDir, { recursive: true });
  execaSync("git", ["init"], { cwd: tmpDir });
  execaSync("git", ["config", "user.email", "t@t.com"], { cwd: tmpDir });
  execaSync("git", ["config", "user.name", "T"], { cwd: tmpDir });
});

afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

describe("locked contract guard", () => {
  it("compares BRIEF.md exactly with the captured HEAD baseline", async () => {
    commitContracts("- The central thesis.");
    const baseline = await captureLockedContractBaseline(tmpDir);
    writeFileSync(join(tmpDir, "BRIEF.md"), "Changed brief.\n");

    const result = checkLockedContracts(tmpDir, baseline);

    expect(result.passed).toBe(false);
    expect(result.violations[0]?.file).toBe("BRIEF.md");
    expect(formatLockedContractFailure(result)).toContain(baseline.baseCommit);
    expect(formatLockedContractFailure(result)).toContain(result.candidateDigest);
  });

  it.each([
    ["central thesis", "Contracts must be checked from Git.", "Contracts may be guessed."],
    ["contributions", "A deterministic guard.", "A probabilistic guard."],
    ["working title", "Guarded Paper", "Unguarded Paper"],
    ["target venue", "TestConf", "OtherConf"],
    ["paper type", "Full paper", "Short paper"],
    ["intended readers", "Pipeline authors", "Everyone"],
    ["author list", "Ada Example", "Grace Example"],
  ])("protects the mapped %s selector", async (lockedItem, before, after) => {
    commitContracts(`- The ${lockedItem}.`);
    const baseline = await captureLockedContractBaseline(tmpDir);
    const path = join(tmpDir, "PAPER.md");
    writeFileSync(path, readFileSync(path, "utf-8").replace(before, after));

    const result = checkLockedContracts(tmpDir, baseline);

    expect(result.passed).toBe(false);
    expect(result.violations.some((violation) => violation.selector)).toBe(true);
  });

  it("allows unrelated PAPER.md selectors and manuscript files to change", async () => {
    commitContracts("- The central thesis.");
    const baseline = await captureLockedContractBaseline(tmpDir);
    const path = join(tmpDir, "PAPER.md");
    writeFileSync(path, readFileSync(path, "utf-8").replace("Guarded Paper", "A Better Title"));
    mkdirSync(join(tmpDir, "paper"));
    writeFileSync(join(tmpDir, "paper", "main.tex"), "Draft prose.\n");

    expect(checkLockedContracts(tmpDir, baseline).passed).toBe(true);
  });

  it("fails closed only for unclassifiable PAPER.md changes when locked prose is unknown", async () => {
    commitContracts("- Preserve the primary fairness condition.");
    const baseline = await captureLockedContractBaseline(tmpDir);
    const path = join(tmpDir, "PAPER.md");

    writeFileSync(path, readFileSync(path, "utf-8").replace("Problem then solution.", "Solution then problem."));
    const unsafe = checkLockedContracts(tmpDir, baseline);
    expect(unsafe.passed).toBe(false);
    expect(unsafe.violations[0]?.message).toContain("unclassifiable");

    writeFileSync(path, readFileSync(path, "utf-8").replace("Solution then problem.", "Problem then solution.").replace("Guarded Paper", "Known field edit"));
    expect(checkLockedContracts(tmpDir, baseline).passed).toBe(true);
  });

  it("rejects edits to the locked-items declaration itself", async () => {
    commitContracts("- The central thesis.");
    const baseline = await captureLockedContractBaseline(tmpDir);
    const path = join(tmpDir, "PAPER.md");
    writeFileSync(path, readFileSync(path, "utf-8").replace("- The central thesis.", "- None."));

    expect(checkLockedContracts(tmpDir, baseline).violations[0]?.message).toContain(
      "What must not change silently",
    );
  });

  it("protects a supported selector marked locked in its heading without a summary item", async () => {
    commitContracts("- None.");
    const baseline = await captureLockedContractBaseline(tmpDir);
    const path = join(tmpDir, "PAPER.md");
    writeFileSync(path, readFileSync(path, "utf-8").replace("Contracts must be checked from Git.", "Changed thesis."));

    expect(checkLockedContracts(tmpDir, baseline).violations).toEqual([
      expect.objectContaining({ selector: "central_thesis" }),
    ]);
  });

  it("masks an authorized Mode field change from unknown-lock fallback", async () => {
    commitContracts("- Preserve the primary fairness condition.");
    const baseline = await captureLockedContractBaseline(tmpDir);
    const path = join(tmpDir, "PAPER.md");
    writeFileSync(path, readFileSync(path, "utf-8").replace("- Mode: autonomous", "- Mode: collaborative"));

    expect(checkLockedContracts(tmpDir, baseline).passed).toBe(true);
  });

  it.each([
    "Paper identity",
    "What readers should believe",
    "Authors and identity",
    "What must not change silently",
    "Operating mode",
  ])("rejects a duplicate protected H2 in the baseline: %s", async (heading) => {
    commitContracts("- The central thesis.");
    const path = join(tmpDir, "PAPER.md");
    writeFileSync(path, `${readFileSync(path, "utf-8")}\n## ${heading}\n\nDuplicate.\n`);
    execaSync("git", ["add", "PAPER.md"], { cwd: tmpDir });
    execaSync("git", ["commit", "-m", "ambiguous"], { cwd: tmpDir });

    await expect(captureLockedContractBaseline(tmpDir)).rejects.toThrow(/duplicate protected heading/);
  });

  it.each(["Central thesis", "Contributions"])(
    "rejects a duplicate controlled H3 in the candidate: %s",
    async (heading) => {
      commitContracts("- The central thesis.");
      const baseline = await captureLockedContractBaseline(tmpDir);
      const path = join(tmpDir, "PAPER.md");
      writeFileSync(path, `${readFileSync(path, "utf-8")}\n### ${heading}\n\nDuplicate.\n`);

      const result = checkLockedContracts(tmpDir, baseline);
      expect(result.passed).toBe(false);
      expect(result.violations[0]?.message).toContain("candidate is ambiguous");
    },
  );
});
