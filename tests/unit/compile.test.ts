/**
 * Compiling while writing, and the deadlock that made it necessary.
 *
 * pwb-0011 blocked at `publication_build` after all eight writing stages had
 * passed. The cause was two correct rules meeting: the task supplied a
 * read-only bibliography with two malformed entries, `latexmk -halt-on-error`
 * refused to produce a PDF because BibTeX complained about them, and
 * `inputs_unmodified` forbade repairing the file. The same manuscript
 * recompiled cleanly under the benchmark verifier's own flow, which does not
 * halt on BibTeX.
 *
 * The other half of this file is the reason the tolerance is narrow: a real
 * LaTeX error must still fail.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  suppliedBibliographyComplaint,
  lastMeasuredPages,
  recordMeasuredPages,
  DRAFT_BUILD_DIR,
} from "../../src/pipeline/compile.js";
import { validateStage } from "../../src/pipeline/validators.js";
import { STAGES } from "../../src/pipeline/stages.js";
import type { Stage, Validator } from "../../src/pipeline/stages.js";
import { PAPER_RUN_DIR } from "../../src/utils/constants.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "paper-run-compile-"));
  mkdirSync(join(tmpDir, "paper", "sections"), { recursive: true });
  mkdirSync(join(tmpDir, "materials"), { recursive: true });
  mkdirSync(join(tmpDir, PAPER_RUN_DIR), { recursive: true });
});

afterEach(() => {
  try {
    chmodSync(join(tmpDir, "paper", "refs.bib"), 0o644);
    chmodSync(join(tmpDir, "materials", "references.bib"), 0o644);
  } catch {
    // Absent in most cases; only the supplied-bibliography tests create them.
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

/** A bibliography that is byte-identical to a supplied material and read-only. */
function suppliedBib(): void {
  const body = "@article{good,\n  title = {Work},\n  year = {2026}\n}\n";
  writeFileSync(join(tmpDir, "materials", "references.bib"), body);
  writeFileSync(join(tmpDir, "paper", "refs.bib"), body);
  chmodSync(join(tmpDir, "paper", "refs.bib"), 0o444);
  chmodSync(join(tmpDir, "materials", "references.bib"), 0o444);
}

const BIBTEX_FAILURE = {
  stdout: [
    "Latexmk: applying rule 'bibtex main'...",
    "Running 'bibtex \"main.aux\"'",
    "This is BibTeX, Version 0.99d",
    "You're missing a field name---line 138 of file refs.bib",
    "I'm skipping whatever remains of this entry",
    "You're missing a field name---line 150 of file refs.bib",
    "I'm skipping whatever remains of this entry",
    "(There were 2 error messages)",
    "Latexmk: Errors, so I did not complete making targets",
  ].join("\n"),
  stderr: "",
  exitCode: 12,
};

describe("suppliedBibliographyComplaint", () => {
  it("recognises BibTeX objecting to a supplied read-only bibliography", () => {
    suppliedBib();
    const complaint = suppliedBibliographyComplaint(tmpDir, BIBTEX_FAILURE);

    expect(complaint).toContain("2 malformed entries");
    expect(complaint).toContain("paper/refs.bib");
  });

  it("stays out of the way when the bibliography is the paper's own", () => {
    writeFileSync(join(tmpDir, "paper", "refs.bib"), "@article{a, year={2026}}\n");
    expect(suppliedBibliographyComplaint(tmpDir, BIBTEX_FAILURE)).toBeNull();
  });

  it("refuses to excuse a LaTeX error that happens to follow a BibTeX complaint", () => {
    suppliedBib();
    const withLatexError = {
      ...BIBTEX_FAILURE,
      stdout: `${BIBTEX_FAILURE.stdout}\n! Undefined control sequence.\nl.42 \\nosuchmacro`,
    };

    expect(suppliedBibliographyComplaint(tmpDir, withLatexError)).toBeNull();
  });

  it("ignores a failure BibTeX had no part in", () => {
    suppliedBib();
    const missingFile = { stdout: "! LaTeX Error: File `nope.sty' not found.", stderr: "", exitCode: 12 };

    expect(suppliedBibliographyComplaint(tmpDir, missingFile)).toBeNull();
  });
});

describe("remembering a measured page count", () => {
  function manuscript(body: string): void {
    writeFileSync(join(tmpDir, "paper", "sections", "02_intro.tex"), body);
    writeFileSync(
      join(tmpDir, "paper", "main.tex"),
      ["\\documentclass{article}", "\\begin{document}", "\\input{sections/02_intro}", "\\end{document}", ""].join("\n"),
    );
  }

  it("recalls a count recorded against the current sources", () => {
    manuscript("Some prose.\n");
    recordMeasuredPages(tmpDir, 9);

    expect(lastMeasuredPages(tmpDir)).toBe(9);
  });

  it("forgets the count once a source changes", async () => {
    manuscript("Some prose.\n");
    recordMeasuredPages(tmpDir, 9);
    expect(lastMeasuredPages(tmpDir)).toBe(9);

    await new Promise((resolve) => setTimeout(resolve, 10));
    manuscript("Some prose, revised at length.\n");

    expect(lastMeasuredPages(tmpDir)).toBeNull();
  });

  it("clears the record when a compile fails", () => {
    manuscript("Some prose.\n");
    recordMeasuredPages(tmpDir, 9);
    recordMeasuredPages(tmpDir, null);

    expect(lastMeasuredPages(tmpDir)).toBeNull();
  });

  it("writes into the gitignored build directory, not into paper/", () => {
    manuscript("Some prose.\n");
    recordMeasuredPages(tmpDir, 4);

    const record = JSON.parse(readFileSync(join(tmpDir, DRAFT_BUILD_DIR, "pages.json"), "utf-8"));
    expect(record.pages).toBe(4);
  });
});

describe("manuscript_length prefers a measured page count", () => {
  const validator: Validator = {
    type: "manuscript_length",
    required: true,
    message: "The manuscript is far short of its stated page budget",
  };

  function stageWith(check: Validator): Stage {
    return { ...STAGES.revision, validators: [check] };
  }

  function withBudget(pages: number, words: number): void {
    writeFileSync(join(tmpDir, "BRIEF.md"), `# Brief\n\nThe paper is suitable for ${pages} pages.\n`);
    writeFileSync(
      join(tmpDir, "paper", "sections", "02_intro.tex"),
      `${Array.from({ length: words }, (_, i) => `word${i}`).join(" ")}\n`,
    );
    writeFileSync(
      join(tmpDir, "paper", "main.tex"),
      ["\\documentclass{article}", "\\begin{document}", "\\input{sections/02_intro}", "\\end{document}", ""].join("\n"),
    );
  }

  it("passes a short-looking manuscript that actually compiles to its budget", async () => {
    // 2,000 words is far below the words-per-page estimate for nine pages,
    // and the estimate is what shipped a ten-page paper as "far short".
    withBudget(9, 2000);
    recordMeasuredPages(tmpDir, 10);

    const result = await validateStage(stageWith(validator), tmpDir);
    expect(result.passed).toBe(true);
  });

  it("still fails a manuscript that compiles to a third of its budget", async () => {
    withBudget(9, 2000);
    recordMeasuredPages(tmpDir, 3);

    const result = await validateStage(stageWith(validator), tmpDir);
    expect(result.passed).toBe(false);
    expect(result.checks[0]!.message).toContain("3 page(s)");
  });

  it("falls back to the word estimate when nothing has been compiled", async () => {
    withBudget(9, 500);

    const result = await validateStage(stageWith(validator), tmpDir);
    expect(result.passed).toBe(false);
    expect(result.checks[0]!.message).toContain("words of prose");
  });
});

describe("the manuscript_compiles validator", () => {
  const validator: Validator = {
    type: "manuscript_compiles",
    timeoutMs: 60_000,
    required: true,
    message: "The manuscript does not compile",
  };

  function stageWith(check: Validator): Stage {
    return { ...STAGES.full_draft, validators: [check] };
  }

  it("fails a project with no manuscript", async () => {
    const result = await validateStage(stageWith(validator), tmpDir);

    expect(result.passed).toBe(false);
    expect(result.checks[0]!.message).toContain("paper/main.tex is missing");
  });
});
