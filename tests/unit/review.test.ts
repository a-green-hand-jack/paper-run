import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { detectEntrypoint, extractManuscriptMetadata, inspectReviewSource } from "../../src/commands/review.js";

describe("external review source inspection", () => {
  let root = "";

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("detects the only documentclass and follows the TeX input graph", () => {
    root = mkdtempSync(join(tmpdir(), "paper-run-review-"));
    mkdirSync(join(root, "sections"));
    writeFileSync(join(root, "main.tex"), "\\documentclass{article}\n\\input{sections/results}\n");
    writeFileSync(join(root, "sections", "results.tex"), "Results");
    writeFileSync(join(root, "refs.bib"), "@article{x,title={X}}\n");
    writeFileSync(join(root, "figure.pdf"), "pdf");

    const entry = detectEntrypoint(root);
    const inspection = inspectReviewSource(root, "main.tex");

    expect(entry).toBe(join(root, "main.tex"));
    expect(inspection.sourceGraph).toEqual(["main.tex", "sections/results.tex"]);
    expect(inspection.bibliography).toEqual(["refs.bib"]);
    expect(inspection.figures).toEqual(["figure.pdf"]);
  });

  it("requires an explicit entrypoint when multiple manuscripts exist", () => {
    root = mkdtempSync(join(tmpdir(), "paper-run-review-"));
    writeFileSync(join(root, "a.tex"), "\\documentclass{article}");
    writeFileSync(join(root, "b.tex"), "\\documentclass{article}");

    expect(() => detectEntrypoint(root)).toThrow(/Multiple TeX entrypoints/);
    expect(detectEntrypoint(root, "b.tex")).toBe(join(root, "b.tex"));
  });

  it("rejects an entrypoint outside the source directory", () => {
    root = mkdtempSync(join(tmpdir(), "paper-run-review-"));
    expect(() => detectEntrypoint(root, "../main.tex")).toThrow(/outside/);
  });

  it("extracts verifiable metadata without inventing unresolved fields", () => {
    root = mkdtempSync(join(tmpdir(), "paper-run-review-"));
    writeFileSync(
      join(root, "main.tex"),
      "\\documentclass{article}\n\\title{A \u005c\u005c Robust Result}\n\\author{Ada Lovelace \\and Alan Turing}\n\\begin{abstract}A tested result.\\end{abstract}\n",
    );
    writeFileSync(join(root, "README.md"), "Build with latexmk.");

    const metadata = extractManuscriptMetadata(root, {
      entrypoint: "main.tex",
      sourceGraph: ["main.tex"],
      bibliography: [],
      figures: [],
      tables: [],
      styles: [],
      buildFiles: [],
      evidenceFiles: [],
      missingSourceFiles: [],
    });

    expect(metadata.title).toContain("Robust Result");
    expect(metadata.authors).toEqual(["Ada Lovelace", "Alan Turing"]);
    expect(metadata.abstract).toBe("A tested result.");
    expect(metadata.readme).toBe("Build with latexmk.");
  });

  it("preserves nested TeX metadata arguments", () => {
    root = mkdtempSync(join(tmpdir(), "paper-run-review-"));
    writeFileSync(join(root, "main.tex"), "\\documentclass{article}\n\\title{A \\textbf{Robust} Result}\n\\author{Alice\\thanks{KAUST} \\and Bob}\n");

    const metadata = extractManuscriptMetadata(root, {
      entrypoint: "main.tex",
      sourceGraph: ["main.tex"],
      bibliography: [],
      figures: [],
      tables: [],
      styles: [],
      buildFiles: [],
      evidenceFiles: [],
      missingSourceFiles: [],
    });

    expect(metadata.title).toBe("A \\textbf{Robust} Result");
    expect(metadata.authors).toEqual(["AliceKAUST", "Bob"]);
  });
});
