/**
 * Prose quality checks.
 *
 * Two things matter here and they pull in opposite directions. The rules have
 * to fire on the patterns they were ported to catch, and they must not fire on
 * ordinary LaTeX — a checker that flags every manuscript teaches the pipeline
 * to ignore it.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  inspectProse,
  inspectManuscript,
  proseOnly,
  blockingProseIssues,
  summarizeProseReport,
} from "../../src/pipeline/prose-quality.js";

function codes(text: string, scope: "paper" | "section" = "paper"): string[] {
  return inspectProse(text, scope).issues.map((issue) => issue.code);
}

describe("proseOnly", () => {
  it("drops LaTeX comments but keeps escaped percent signs", () => {
    const out = proseOnly("Coverage reached 40\\% of the corpus. % TODO(paper-run): check\nNext line.");
    expect(out).toContain("40\\%");
    expect(out).not.toContain("TODO(paper-run)");
  });

  it("drops math, floats, and citation keys", () => {
    const source = [
      "The estimator converges to $\\theta^*$ under Assumption 1.",
      "\\begin{table}[t]\\begin{tabular}{ll} a & b \\\\ \\end{tabular}\\end{table}",
      "This matches prior work \\cite{smith2024,jones2023}.",
    ].join("\n");
    const out = proseOnly(source);
    expect(out).not.toContain("theta");
    expect(out).not.toContain("tabular");
    expect(out).not.toContain("smith2024");
    expect(out).toContain("converges to");
  });

  it("keeps the text inside ordinary markup commands", () => {
    expect(proseOnly("We report \\textbf{substantial} gains.")).toContain("substantial");
  });
});

describe("inspectProse", () => {
  it("passes clean scientific prose", () => {
    const clean = [
      "We evaluate the method on three datasets.",
      "Accuracy improves by 3.4 points on the first, and by 5.1 on the second.",
      "The third shows no change, which we attribute to its shorter sequences.",
    ].join(" ");
    expect(inspectProse(clean).issues).toHaveLength(0);
  });

  it("flags throat-clearing openers", () => {
    expect(codes("It is important to note that the model converges.")).toContain("opening_filler");
  });

  it("flags promotional vocabulary as advisory only", () => {
    const report = inspectProse("Our robust and comprehensive framework is a cornerstone.");
    const precision = report.issues.find((issue) => issue.code === "precision_terms");
    expect(precision?.severity).toBe("advisory");
    expect(blockingProseIssues(report)).toHaveLength(0);
  });

  it("flags template enumerations", () => {
    const text = "First, we define the task. Second, we describe the model. Third, we evaluate it.";
    expect(codes(text)).toContain("formulaic_structure");
  });

  it("flags five consecutive sentences of near-identical length", () => {
    const sentence = "The model reads the input and produces a label for it.";
    expect(codes(Array(6).fill(sentence).join(" "))).toContain("uniform_sentence_run");
  });

  it("counts LaTeX triple hyphens as em dashes and holds a paper to three", () => {
    const withDashes = "a --- b. c --- d. e --- f. g --- h.";
    const report = inspectProse(withDashes, "paper");
    expect(report.emDashCount).toBe(4);
    expect(report.emDashLimit).toBe(3);
    expect(report.issues.map((i) => i.code)).toContain("em_dash_limit");
  });

  it("does not count a table rule as an em dash", () => {
    const report = inspectProse("| col | col |\n| --- | --- |\n| 1 | 2 |");
    expect(report.emDashCount).toBe(0);
  });

  it("reports semicolon density above two per thousand words", () => {
    const words = Array(200).fill("word").join(" ");
    expect(codes(`${words}; and; also; again;`)).toContain("semicolon_density");
  });

  it("summarises a clean report and a dirty one differently", () => {
    expect(summarizeProseReport(inspectProse("A short clean sentence about results."))).toContain("clean");
    expect(summarizeProseReport(inspectProse("It is important to note that x."))).toContain("opening_filler");
  });
});

describe("inspectManuscript", () => {
  it("returns an empty report when there is no sections directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "paper-run-prose-"));
    try {
      const report = inspectManuscript(dir);
      expect(report.issues).toHaveLength(0);
      expect(report.files).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads every section in order and reports them together", () => {
    const dir = mkdtempSync(join(tmpdir(), "paper-run-prose-"));
    try {
      const sections = join(dir, "paper", "sections");
      mkdirSync(sections, { recursive: true });
      writeFileSync(join(sections, "02_intro.tex"), "It is important to note that we begin here.");
      writeFileSync(join(sections, "04_method.tex"), "The method has three parts.");
      writeFileSync(join(sections, "notes.md"), "It is important to note that this is not LaTeX.");

      const report = inspectManuscript(dir);
      expect(report.files).toEqual(["paper/sections/02_intro.tex", "paper/sections/04_method.tex"]);
      // One filler issue, from the .tex file only — the .md is not manuscript.
      const filler = report.issues.filter((issue) => issue.code === "opening_filler");
      expect(filler).toHaveLength(1);
      expect(filler[0]?.detail).toContain("1 occurrence");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
