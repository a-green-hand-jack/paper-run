/**
 * The floor checks, against the shape of the manuscript that defeated the
 * structural ones.
 *
 * On PaperWrite-Bench pwb-0011 a four-page manuscript with zero citations and
 * zero figures passed thirteen stages and was tagged as a candidate, from
 * materials that supported nine pages and twenty real citations. Every number
 * in these fixtures is taken from that run: 52 bibliography entries, 3 supplied
 * figures, a nine-page brief, 1,247 words of prose.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  inspectManuscriptSources,
  citationFloor,
  pageBudget,
  wordTarget,
} from "../../src/pipeline/manuscript.js";
import { STAGES } from "../../src/pipeline/stages.js";
import type { Stage, Validator } from "../../src/pipeline/stages.js";
import { validateStage } from "../../src/pipeline/validators.js";
import { captureInputBaseline } from "../../src/pipeline/inputs.js";
import { writeInputBaseline } from "../../src/state/store.js";
import { PAPER_RUN_DIR } from "../../src/utils/constants.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "paper-run-floors-"));
  mkdirSync(join(tmpDir, "paper", "sections"), { recursive: true });
  mkdirSync(join(tmpDir, PAPER_RUN_DIR), { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** A 52-entry bibliography, as pwb-0011 supplied. */
function writeBib(count = 52): void {
  const entries = Array.from(
    { length: count },
    (_, i) => `@inproceedings{key${i},\n  title = {Work ${i}},\n  year = {2024},\n}`,
  );
  writeFileSync(join(tmpDir, "paper", "refs.bib"), entries.join("\n\n"));
}

function writeManuscript(sections: Record<string, string>): void {
  const stems = Object.keys(sections);
  for (const [stem, body] of Object.entries(sections)) {
    writeFileSync(join(tmpDir, "paper", "sections", `${stem}.tex`), body);
  }
  writeFileSync(
    join(tmpDir, "paper", "main.tex"),
    [
      "\\documentclass{article}",
      "\\begin{document}",
      ...stems.map((stem) => `\\input{sections/${stem}}`),
      "\\end{document}",
      "",
    ].join("\n"),
  );
}

function words(count: number): string {
  return Array.from({ length: count }, (_, i) => `word${i % 40}`).join(" ");
}

function stageWith(...validators: Validator[]): Stage {
  return { ...STAGES.full_draft, validators };
}

describe("citation_floor", () => {
  const validator: Validator = {
    type: "citation_floor",
    minFiles: 3,
    required: true,
    message: "does not engage the bibliography",
  };

  it("rejects the zero-citation manuscript that passed thirteen stages", async () => {
    writeBib();
    writeManuscript({ "02_intro": words(300), "03_method": words(300) });

    const stats = inspectManuscriptSources(tmpDir);
    expect(stats.bibKeys).toHaveLength(52);
    expect(citationFloor(stats)).toBe(11);

    const result = await validateStage(stageWith(validator), tmpDir);
    expect(result.passed).toBe(false);
    expect(result.failures.join(" ")).toContain("cites 0 distinct works");
  });

  it("accepts a manuscript that cites the literature it was given", async () => {
    writeBib();
    const cites = (from: number, to: number) =>
      Array.from({ length: to - from }, (_, i) => `\\cite{key${from + i}}`).join(" ");
    writeManuscript({
      "02_intro": `${words(200)} ${cites(0, 5)}`,
      "03_related": `${words(200)} ${cites(5, 10)}`,
      "04_method": `${words(200)} ${cites(10, 12)}`,
    });

    expect((await validateStage(stageWith(validator), tmpDir)).passed).toBe(true);
  });

  it("rejects an invented citation key even when the floor is met", async () => {
    writeBib();
    const real = Array.from({ length: 12 }, (_, i) => `\\cite{key${i}}`).join(" ");
    writeManuscript({
      "02_intro": `${words(100)} ${real}`,
      "03_related": `${words(100)} \\cite{key1}`,
      "04_method": `${words(100)} \\cite{smith2024invented}`,
    });

    const result = await validateStage(stageWith(validator), tmpDir);
    expect(result.passed).toBe(false);
    expect(result.failures.join(" ")).toContain("smith2024invented");
  });

  it("requires citations to be spread across sections, not piled into one", async () => {
    writeBib();
    const all = Array.from({ length: 12 }, (_, i) => `\\cite{key${i}}`).join(" ");
    writeManuscript({ "02_intro": `${words(200)} ${all}`, "03_method": words(200) });

    const result = await validateStage(stageWith(validator), tmpDir);
    expect(result.passed).toBe(false);
    expect(result.failures.join(" ")).toContain("section file(s)");
  });

  it("is vacuous for a repository with no bibliography yet", async () => {
    writeManuscript({ "02_intro": words(200) });
    expect(citationFloor(inspectManuscriptSources(tmpDir))).toBe(0);
    expect((await validateStage(stageWith(validator), tmpDir)).passed).toBe(true);
  });
});

describe("manuscript_length", () => {
  const validator: Validator = {
    type: "manuscript_length",
    required: true,
    message: "short of its page budget",
  };

  function writeBrief(text: string): void {
    writeFileSync(join(tmpDir, "BRIEF.md"), `# Paper Brief\n\n## Constraints\n\n- ${text}\n`);
  }

  it("reads a plural page budget out of the brief", () => {
    // The brief is byte-immutable under the locked-contract check, so this
    // number cannot be edited into agreement by the agent it constrains.
    writeBrief("Language and length limits: English; suitable for nine pages of body text");
    expect(pageBudget(tmpDir)).toBe(9);
    expect(wordTarget(9).min).toBe(3465);
  });

  it("rejects the 1,247-word draft against a nine-page brief", async () => {
    writeBrief("suitable for nine pages of single-column body text");
    writeManuscript({ "02_intro": words(1247) });

    const result = await validateStage(stageWith(validator), tmpDir);
    expect(result.passed).toBe(false);
    expect(result.failures.join(" ")).toContain("9-page budget");
  });

  it("accepts a manuscript that uses the space", async () => {
    writeBrief("suitable for nine pages of single-column body text");
    writeManuscript({ "02_intro": words(2600), "03_method": words(2500) });
    expect((await validateStage(stageWith(validator), tmpDir)).passed).toBe(true);
  });

  it("degrades to no check when nobody stated a budget", async () => {
    writeManuscript({ "02_intro": words(100) });
    expect(pageBudget(tmpDir)).toBeNull();
    // "No check" rather than "wrong check": a missed budget must not fail a run.
    expect((await validateStage(stageWith(validator), tmpDir)).passed).toBe(true);
  });
});

describe("figure_coverage", () => {
  const validator: Validator = {
    type: "figure_coverage",
    required: true,
    message: "supplied figures are missing",
  };

  function writeFigures(names: string[]): void {
    const dir = join(tmpDir, "paper", "figures");
    mkdirSync(dir, { recursive: true });
    for (const name of names) writeFileSync(join(dir, name), "binary");
  }

  it("rejects a manuscript that places none of the three supplied figures", async () => {
    writeFigures(["teaser_figure.jpg", "plot.jpg", "plot_horizontal.jpg"]);
    writeManuscript({ "02_intro": words(300) });

    const result = await validateStage(stageWith(validator), tmpDir);
    expect(result.passed).toBe(false);
    expect(result.failures.join(" ")).toContain("teaser_figure");
  });

  it("accepts them once they are placed", async () => {
    writeFigures(["plot.jpg"]);
    writeManuscript({
      "02_intro": `${words(100)}\n\\includegraphics[width=\\linewidth]{figures/plot.jpg}`,
    });
    expect((await validateStage(stageWith(validator), tmpDir)).passed).toBe(true);
  });

  it("accepts a figure deliberately left out, when the contract says why", async () => {
    // Deciding against a supplied figure is legitimate; doing it silently is
    // what this check exists to catch.
    writeFigures(["plot.jpg"]);
    writeManuscript({ "02_intro": words(100) });
    writeFileSync(
      join(tmpDir, "PAPER.md"),
      "# Paper\n\n## Unresolved\n\n- plot.jpg has no protocol recorded, so it is not placed.\n",
    );
    expect((await validateStage(stageWith(validator), tmpDir)).passed).toBe(true);
  });

  it("passes a repository that was supplied no figures", async () => {
    writeManuscript({ "02_intro": words(100) });
    expect((await validateStage(stageWith(validator), tmpDir)).passed).toBe(true);
  });
});

describe("inputs_unmodified", () => {
  const validator: Validator = {
    type: "inputs_unmodified",
    required: true,
    message: "supplied inputs were modified",
  };

  function supplyMaterials(): void {
    mkdirSync(join(tmpDir, "materials"), { recursive: true });
    writeFileSync(join(tmpDir, "materials", "references.bib"), "@article{a, title={A}}\n");
    writeFileSync(join(tmpDir, "materials", "table.tex"), "1 & 2\n");
    writeFileSync(join(tmpDir, "BRIEF.md"), "# Paper Brief\n\nSupplied.\n");
  }

  it("passes when nothing has touched the evidence", async () => {
    supplyMaterials();
    writeInputBaseline(tmpDir, captureInputBaseline(tmpDir));
    expect((await validateStage(stageWith(validator), tmpDir)).passed).toBe(true);
  });

  it("catches a turn that edited a supplied file to satisfy a check", async () => {
    // On pwb-0011 a remediation turn added a marker to the supplied,
    // read-only bibliography so a validator would stop complaining.
    supplyMaterials();
    writeInputBaseline(tmpDir, captureInputBaseline(tmpDir));
    writeFileSync(
      join(tmpDir, "materials", "references.bib"),
      "% REFERENCE_INTEGRITY_REQUIRED: references/ledger.json\n@article{a, title={A}}\n",
    );

    const result = await validateStage(stageWith(validator), tmpDir);
    expect(result.passed).toBe(false);
    expect(result.failures.join(" ")).toContain("materials/references.bib");
  });

  it("treats a read-only bibliography as supplied", () => {
    supplyMaterials();
    writeFileSync(join(tmpDir, "paper", "refs.bib"), "@article{a, title={A}}\n");
    chmodSync(join(tmpDir, "paper", "refs.bib"), 0o444);

    const baseline = captureInputBaseline(tmpDir);
    expect(Object.keys(baseline.files)).toContain("paper/refs.bib");
  });

  it("passes for a run recorded before baselines existed", async () => {
    supplyMaterials();
    expect((await validateStage(stageWith(validator), tmpDir)).passed).toBe(true);
  });
});
