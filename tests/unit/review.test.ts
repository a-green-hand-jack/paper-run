import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { detectEntrypoint, inspectReviewSource } from "../../src/commands/review.js";

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
});
