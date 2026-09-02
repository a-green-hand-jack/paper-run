/**
 * The floors under a finished manuscript.
 *
 * Every case here is something a run actually shipped on PaperWrite-Bench
 * pwb-0011 while passing thirteen stages: no citations, none of the three
 * supplied figures, four pages against a nine-page brief, two blockers filed
 * away as deferred. Structural validators cannot see any of it.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { validateStage } from "../../src/pipeline/validators.js";
import { STAGES } from "../../src/pipeline/stages.js";
import type { Stage, Validator } from "../../src/pipeline/stages.js";
import {
  inspectManuscriptSources,
  citationFloor,
  pageBudget,
  wordTarget,
} from "../../src/pipeline/manuscript.js";
import { captureInputBaseline, isSuppliedBibliography } from "../../src/pipeline/inputs.js";
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

function bib(count: number): void {
  const entries = Array.from(
    { length: count },
    (_, i) => `@article{key${i},\n  title = {Work ${i}},\n  year = {2026}\n}`,
  );
  writeFileSync(join(tmpDir, "paper", "refs.bib"), entries.join("\n\n"));
}

function section(stem: string, body: string): void {
  writeFileSync(join(tmpDir, "paper", "sections", `${stem}.tex`), body);
}

function main(stems: string[]): void {
  writeFileSync(
    join(tmpDir, "paper", "main.tex"),
    ["\\documentclass{article}", "\\begin{document}", ...stems.map((s) => `\\input{sections/${s}}`), "\\end{document}", ""].join("\n"),
  );
}

function stageWith(validator: Validator): Stage {
  return { ...STAGES.revision, validators: [validator] };
}

const prose = (words: number, extra = "") =>
  `${Array.from({ length: words }, () => "evidence").join(" ")} ${extra}`;

describe("citation floor", () => {
  it("fails a manuscript that cites nothing against a real bibliography", async () => {
    bib(52);
    section("02_intro", prose(300));
    main(["02_intro"]);

    const result = await validateStage(
      stageWith({ type: "citation_floor", required: true, message: "too few citations" }),
      tmpDir,
    );

    expect(result.passed).toBe(false);
    // 52 entries sets the floor at 11; the point is that 0 is not a paper.
    expect(result.failures.join(" ")).toContain("floor of 11");
  });

  it("stays quiet when the repository supplies no bibliography to cite", async () => {
    section("02_intro", prose(300));
    main(["02_intro"]);

    const result = await validateStage(
      stageWith({ type: "citation_floor", required: true, message: "too few citations" }),
      tmpDir,
    );
    expect(result.passed).toBe(true);
  });

  it("passes once the manuscript reaches the floor", async () => {
    bib(52);
    const keys = Array.from({ length: 11 }, (_, i) => `\\cite{key${i}}`).join(" ");
    section("02_intro", `${prose(200)} ${keys}`);
    main(["02_intro"]);

    const result = await validateStage(
      stageWith({ type: "citation_floor", required: true, message: "too few citations" }),
      tmpDir,
    );
    expect(result.passed).toBe(true);
  });

  it("fails a cited key that is not in the bibliography", async () => {
    bib(52);
    const keys = Array.from({ length: 11 }, (_, i) => `\\cite{key${i}}`).join(" ");
    section("02_intro", `${prose(200)} ${keys} \\cite{invented2026}`);
    main(["02_intro"]);

    const result = await validateStage(
      stageWith({ type: "citation_floor", required: true, message: "bad citations" }),
      tmpDir,
    );
    expect(result.passed).toBe(false);
    expect(result.failures.join(" ")).toContain("invented2026");
  });

  it("notices when every citation is crammed into one section", async () => {
    bib(52);
    const keys = Array.from({ length: 12 }, (_, i) => `\\cite{key${i}}`).join(" ");
    section("02_intro", `${prose(200)} ${keys}`);
    section("03_method", prose(200));
    main(["02_intro", "03_method"]);

    const result = await validateStage(
      stageWith({ type: "citation_floor", minFiles: 3, required: true, message: "thin" }),
      tmpDir,
    );
    expect(result.passed).toBe(false);
    expect(result.failures.join(" ")).toContain("section");
  });

  it("counts only sections the document actually inputs", () => {
    bib(10);
    section("02_intro", `${prose(50)} \\cite{key1}`);
    // Left on disk but dropped from main.tex: not part of this paper.
    section("07_limitations", `${prose(50)} \\cite{key2} \\cite{key3}`);
    main(["02_intro"]);

    expect(inspectManuscriptSources(tmpDir).citedKeys).toEqual(["key1"]);
  });
});

describe("page budget", () => {
  it("reads the budget from the brief, which the model cannot edit", () => {
    writeFileSync(
      join(tmpDir, "BRIEF.md"),
      "## Constraints\n\n- Language and length limits: a complete paper suitable for nine pages of body text.\n",
    );
    expect(pageBudget(tmpDir)).toBe(9);
  });

  it("prefers a venue file that states a real number", () => {
    mkdirSync(join(tmpDir, ".agents", "knowledge", "venues"), { recursive: true });
    writeFileSync(join(tmpDir, ".agents/knowledge/venues/iclr-2026.md"), "- main_text: 8\n");
    writeFileSync(join(tmpDir, "BRIEF.md"), "suitable for nine pages\n");
    expect(pageBudget(tmpDir)).toBe(8);
  });

  it("ignores a venue field that honestly says it is unverified", () => {
    mkdirSync(join(tmpDir, ".agents", "knowledge", "venues"), { recursive: true });
    writeFileSync(join(tmpDir, ".agents/knowledge/venues/iclr-2026.md"), "- main_text: UNVERIFIED\n");
    writeFileSync(join(tmpDir, "BRIEF.md"), "suitable for nine pages\n");
    expect(pageBudget(tmpDir)).toBe(9);
  });

  it("returns nothing when nobody stated a budget", () => {
    expect(pageBudget(tmpDir)).toBeNull();
  });

  it("fails a manuscript far short of the budget and passes one that reaches it", async () => {
    writeFileSync(join(tmpDir, "BRIEF.md"), "suitable for nine pages\n");
    const check = stageWith({ type: "manuscript_length", required: true, message: "too short" });

    section("02_intro", prose(1738));
    main(["02_intro"]);
    expect((await validateStage(check, tmpDir)).passed).toBe(false);

    section("02_intro", prose(wordTarget(9).min + 50));
    expect((await validateStage(check, tmpDir)).passed).toBe(true);
  });

  it("checks nothing when no budget was stated", async () => {
    section("02_intro", prose(50));
    main(["02_intro"]);
    const result = await validateStage(
      stageWith({ type: "manuscript_length", required: true, message: "too short" }),
      tmpDir,
    );
    expect(result.passed).toBe(true);
  });
});

describe("figure coverage", () => {
  function figures(names: string[]): void {
    mkdirSync(join(tmpDir, "materials", "figures"), { recursive: true });
    for (const name of names) writeFileSync(join(tmpDir, "materials", "figures", name), "binary");
  }

  it("fails when supplied figures appear nowhere in the manuscript", async () => {
    figures(["teaser.jpg", "plot.jpg"]);
    section("02_intro", prose(100));
    main(["02_intro"]);

    const result = await validateStage(
      stageWith({ type: "figure_coverage", required: true, message: "figures missing" }),
      tmpDir,
    );
    expect(result.passed).toBe(false);
    expect(result.failures.join(" ")).toContain("teaser");
  });

  it("passes when the manuscript places them", async () => {
    figures(["teaser.jpg"]);
    section("02_intro", `${prose(100)} \\includegraphics[width=\\linewidth]{figures/teaser.jpg}`);
    main(["02_intro"]);

    const result = await validateStage(
      stageWith({ type: "figure_coverage", required: true, message: "figures missing" }),
      tmpDir,
    );
    expect(result.passed).toBe(true);
  });

  it("accepts a figure the paper argued against, recorded under Unresolved", async () => {
    figures(["teaser.jpg"]);
    section("02_intro", prose(100));
    main(["02_intro"]);
    writeFileSync(
      join(tmpDir, "PAPER.md"),
      "## Unresolved\n\n- teaser has no protocol behind it, so it is not placed.\n",
    );

    const result = await validateStage(
      stageWith({ type: "figure_coverage", required: true, message: "figures missing" }),
      tmpDir,
    );
    expect(result.passed).toBe(true);
  });

  it("passes a repository that ships no figures at all", async () => {
    section("02_intro", prose(100));
    main(["02_intro"]);
    expect(
      (
        await validateStage(
          stageWith({ type: "figure_coverage", required: true, message: "figures missing" }),
          tmpDir,
        )
      ).passed,
    ).toBe(true);
  });
});

describe("supplied inputs", () => {
  it("treats a read-only bibliography as supplied", () => {
    bib(3);
    chmodSync(join(tmpDir, "paper", "refs.bib"), 0o444);
    expect(isSuppliedBibliography(tmpDir)).toBe(true);
  });

  it("leaves an agent-curated bibliography alone", () => {
    bib(3);
    expect(isSuppliedBibliography(tmpDir)).toBe(false);
  });

  it("fails once a recorded input changes", async () => {
    mkdirSync(join(tmpDir, "materials"), { recursive: true });
    writeFileSync(join(tmpDir, "materials", "references.bib"), "@article{a,title={A}}");
    writeFileSync(join(tmpDir, "BRIEF.md"), "brief");
    writeInputBaseline(tmpDir, captureInputBaseline(tmpDir));

    const check = stageWith({ type: "inputs_unmodified", required: true, message: "inputs changed" });
    expect((await validateStage(check, tmpDir)).passed).toBe(true);

    // The exact move a remediation turn made on pwb-0011: edit the evidence
    // until the checker agrees.
    writeFileSync(join(tmpDir, "materials", "references.bib"), "@article{a,title={A}}\n% marker\n");

    const result = await validateStage(check, tmpDir);
    expect(result.passed).toBe(false);
    expect(result.failures.join(" ")).toContain("materials/references.bib");
  });

  it("does not treat a contract the pipeline writes as a supplied input", () => {
    // discoverMaterials answers "what is there to write from", and a contract
    // carrying evidence counts. The baseline answers a different question --
    // "what may this run not alter". Conflating them blocked a live run:
    // evidence_reconciliation, whose whole job is to fill in EXPERIMENTS.md
    // ## Claim-evidence bindings, failed for modifying a supplied input.
    mkdirSync(join(tmpDir, "materials"), { recursive: true });
    writeFileSync(join(tmpDir, "materials", "table.tex"), "1 & 2");
    writeFileSync(join(tmpDir, "BRIEF.md"), "brief");
    writeFileSync(join(tmpDir, "EXPERIMENTS.md"), "# Experiments\n\n## Experiment overview\n\nTODO\n");

    const recorded = Object.keys(captureInputBaseline(tmpDir).files);

    expect(recorded).not.toContain("EXPERIMENTS.md");
    // The brief stays an input: it is the human's statement of intent, and
    // nothing downstream is meant to edit it.
    expect(recorded).toContain("BRIEF.md");
    expect(recorded).toContain("materials/table.tex");
  });

  it("passes a run recorded before input baselines existed", async () => {
    const result = await validateStage(
      stageWith({ type: "inputs_unmodified", required: true, message: "inputs changed" }),
      tmpDir,
    );
    expect(result.passed).toBe(true);
  });
});

describe("citationFloor", () => {
  it("scales with the bibliography and stays modest", () => {
    expect(citationFloor({ bibKeys: [] } as never)).toBe(0);
    expect(citationFloor({ bibKeys: Array(52).fill("k") } as never)).toBe(11);
    expect(citationFloor({ bibKeys: Array(500).fill("k") } as never)).toBe(12);
  });
});

describe("section substance", () => {
  const validator: Validator = {
    type: "section_substance",
    required: true,
    message: "The manuscript inputs a section that says nothing",
  };

  it("fails the appendix pwb-0011 shipped: an input over a file containing only TODO", async () => {
    section("02_intro", "Pruning is a deployment transformation with security consequences.\n");
    section("10_appendix", "TODO\n");
    main(["02_intro", "10_appendix"]);

    const result = await validateStage(stageWith(validator), tmpDir);

    expect(result.passed).toBe(false);
    expect(result.checks[0]!.message).toContain("10_appendix");
  });

  it("does not mistake a sanctioned TODO marker inside real prose for a placeholder", async () => {
    section(
      "06_exp",
      "We report attack success rate for three models.\n"
        + "% TODO(paper-run): needs the ablation number, absent from EXPERIMENTS.md\n"
        + "The pruned checkpoints behave differently from the dense ones.\n",
    );
    main(["06_exp"]);

    const result = await validateStage(stageWith(validator), tmpDir);
    expect(result.passed).toBe(true);
  });

  it("ignores a placeholder the manuscript does not input", async () => {
    section("02_intro", "Real prose about pruning and deployment.\n");
    section("07_limitations", "TODO\n");
    main(["02_intro"]);

    const result = await validateStage(stageWith(validator), tmpDir);
    expect(result.passed).toBe(true);
  });

  it("fails a section that is only LaTeX scaffolding with no prose", async () => {
    section("08_conclusion", "\\section{Conclusion}\\label{sec:conclusion}\n");
    main(["08_conclusion"]);

    const result = await validateStage(stageWith(validator), tmpDir);
    expect(result.passed).toBe(false);
  });
});

describe("the appendix anchor is structural, not a content promise", () => {
  const validator: Validator = {
    type: "section_substance",
    required: true,
    message: "The manuscript inputs a section that says nothing",
  };

  it("accepts an empty appendix, because check-structure.py forces the input", async () => {
    // `check-structure.py` requires main.tex to input sections/10_appendix.
    // Demanding prose there would deadlock a paper with no appendix against a
    // structural rule it cannot satisfy.
    section("02_intro", "Pruning is a deployment transformation with security consequences.\n");
    section("10_appendix", "");
    main(["02_intro", "10_appendix"]);

    const result = await validateStage(stageWith(validator), tmpDir);
    expect(result.passed).toBe(true);
  });

  it("accepts an appendix holding only a comment", async () => {
    section("02_intro", "Real prose about pruning.\n");
    section("10_appendix", "% No appendix material for this submission.\n");
    main(["02_intro", "10_appendix"]);

    const result = await validateStage(stageWith(validator), tmpDir);
    expect(result.passed).toBe(true);
  });

  it("tells the appendix to empty itself, never to drop its required input", async () => {
    section("02_intro", "Real prose about pruning.\n");
    section("10_appendix", "\\section{Appendix}\nTODO\n");
    main(["02_intro", "10_appendix"]);

    const result = await validateStage(stageWith(validator), tmpDir);
    const message = result.checks[0]!.message ?? "";

    expect(message).toContain("leave the file empty");
    expect(message).toContain("check-structure.py requires");
    // The body advice would send it into a structure violation.
    expect(message).not.toContain("stops inputting it");
  });

  it("still rejects an appendix that prints TODO into the PDF", async () => {
    // This is what shipped last time: \section{Appendix} followed by the bare
    // word TODO, rendered into the paper.
    section("02_intro", "Real prose about pruning.\n");
    section("10_appendix", "\\section{Appendix}\nTODO\n");
    main(["02_intro", "10_appendix"]);

    const result = await validateStage(stageWith(validator), tmpDir);
    expect(result.passed).toBe(false);
    expect(result.checks[0]!.message).toContain("10_appendix");
  });

  it("accepts an appendix with real content", async () => {
    section("02_intro", "Real prose about pruning.\n");
    section("10_appendix", "\\section{Appendix}\nFull hyperparameters for every pruning configuration.\n");
    main(["02_intro", "10_appendix"]);

    const result = await validateStage(stageWith(validator), tmpDir);
    expect(result.passed).toBe(true);
  });
});
