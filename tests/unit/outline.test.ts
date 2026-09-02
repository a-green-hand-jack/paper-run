/**
 * The outline: PAPER.md decides which sections exist, not the template.
 *
 * Each test here corresponds to something that actually went wrong on
 * PaperWrite-Bench pwb-0011, where the agreed outline named an Analysis section
 * the template ships no file for, and two of ten drafting turns went to
 * sections the task explicitly forbade.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  readPlannedSections,
  planIssues,
  reconcileMainTex,
  sectionFilesOnDisk,
} from "../../src/pipeline/outline.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "paper-run-outline-"));
  mkdirSync(join(tmpDir, "paper", "sections"), { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function writePaper(rows: string[], heading = "### Section responsibilities"): void {
  writeFileSync(
    join(tmpDir, "PAPER.md"),
    [
      "# Paper Contract",
      "",
      "## Story and structure",
      "",
      heading,
      "",
      "| Section | Reader task | Must preserve |",
      "|---|---|---|",
      ...rows,
      "",
      "## Writing style",
      "",
      "Plain.",
      "",
    ].join("\n"),
  );
}

function writeMain(inputs: string[], withAppendix = true): void {
  writeFileSync(
    join(tmpDir, "paper", "main.tex"),
    [
      "\\documentclass{article}",
      "\\begin{document}",
      ...inputs.map((stem) => `\\input{sections/${stem}}`),
      ...(withAppendix ? ["\\appendix", "\\input{sections/10_appendix}"] : []),
      "\\end{document}",
      "",
    ].join("\n"),
  );
}

const main = () => readFileSync(join(tmpDir, "paper", "main.tex"), "utf-8");

describe("readPlannedSections", () => {
  it("reads the table in reading order and numbers the body ascending", () => {
    writePaper([
      "| Abstract | TL;DR | scope |",
      "| Introduction | Build the tension | thesis |",
      "| Related work | Position the contribution | no precedence claims |",
      "| Analysis | Explain what the tables show | exact values |",
      "| Conclusion | Restate the takeaway | approved claims |",
    ]);

    expect(readPlannedSections(tmpDir).map((s) => s.stem)).toEqual([
      "01_abstract",
      "02_intro",
      "03_related",
      "04_analysis",
      "05_conclusion",
    ]);
  });

  it("reuses the template's own file names rather than near-duplicates", () => {
    // "Introduction" must not become 02_introduction beside an unused 02_intro.
    writePaper(["| Introduction | Build the tension | thesis |"]);
    expect(readPlannedSections(tmpDir)[0]?.stem).toBe("02_intro");
  });

  it("honours an explicit File column over the derived name", () => {
    writeFileSync(
      join(tmpDir, "PAPER.md"),
      [
        "## Story and structure",
        "",
        "### Section responsibilities",
        "",
        "| Section | File | Reader task |",
        "|---|---|---|",
        "| Threat model | `paper/sections/03_threat.tex` | State the adversary |",
        "",
      ].join("\n"),
    );
    expect(readPlannedSections(tmpDir)[0]?.stem).toBe("03_threat");
  });

  it("carries the reader task through for the drafting prompt", () => {
    writePaper(["| Method | Make the pipeline auditable | no results |"]);
    expect(readPlannedSections(tmpDir)[0]?.readerTask).toBe("Make the pipeline auditable");
  });

  it("returns nothing when the table is absent or the contract is missing", () => {
    expect(readPlannedSections(tmpDir)).toEqual([]);
    writePaper([], "### Something else entirely");
    expect(readPlannedSections(tmpDir)).toEqual([]);
  });

  it("skips the template's unfilled placeholder rows only when they name nothing", () => {
    writePaper(["|  | TODO | TODO |", "| Method | TODO | TODO |"]);
    expect(readPlannedSections(tmpDir).map((s) => s.stem)).toEqual(["02_method"]);
  });
});

describe("planIssues", () => {
  it("reports an empty plan, because drafting depends on it", () => {
    expect(planIssues([]).join(" ")).toContain("no usable rows");
  });

  it("accepts a usable plan", () => {
    writePaper(["| Introduction | Build the tension | thesis |"]);
    expect(planIssues(readPlannedSections(tmpDir))).toEqual([]);
  });

  it("rejects a duplicate section file", () => {
    const sections = [
      { title: "Method", stem: "04_method", readerTask: "" },
      { title: "Approach", stem: "04_method", readerTask: "" },
    ];
    expect(planIssues(sections).join(" ")).toContain("duplicate");
  });

  it("rejects a stem the harness layout would reject", () => {
    const sections = [{ title: "Method", stem: "Method", readerTask: "" }];
    expect(planIssues(sections).join(" ")).toContain("not a valid");
  });
});

describe("reconcileMainTex", () => {
  it("creates a planned section the template does not ship", () => {
    for (const stem of ["00_title", "01_abstract", "02_intro", "10_appendix"]) {
      writeFileSync(join(tmpDir, "paper", "sections", `${stem}.tex`), "% placeholder\n");
    }
    writeMain(["00_title", "01_abstract", "02_intro"]);
    writePaper(["| Introduction | Build the tension | thesis |", "| Analysis | Explain the tables | values |"]);

    const result = reconcileMainTex(tmpDir, readPlannedSections(tmpDir));

    expect(result.created).toContain("paper/sections/03_analysis.tex");
    expect(existsSync(join(tmpDir, "paper", "sections", "03_analysis.tex"))).toBe(true);
    expect(main()).toContain("\\input{sections/03_analysis}");
  });

  it("drops a section the plan omits without deleting its file", () => {
    for (const stem of ["00_title", "01_abstract", "02_intro", "07_limitations", "10_appendix"]) {
      writeFileSync(join(tmpDir, "paper", "sections", `${stem}.tex`), "% placeholder\n");
    }
    writeMain(["00_title", "01_abstract", "02_intro", "07_limitations"]);
    writePaper(["| Introduction | Build the tension | thesis |"]);

    reconcileMainTex(tmpDir, readPlannedSections(tmpDir));

    expect(main()).not.toContain("07_limitations");
    // Left on disk: check-structure.py allows an uninputted file, and deleting
    // it would be an irreversible answer to a reversible question.
    expect(sectionFilesOnDisk(tmpDir)).toContain("07_limitations.tex");
  });

  it("keeps the three anchors the harness layout requires", () => {
    writeMain([]);
    writePaper(["| Method | Auditable pipeline | no results |"]);

    const result = reconcileMainTex(tmpDir, readPlannedSections(tmpDir));

    expect(result.inputs[0]).toBe("00_title");
    expect(result.inputs[1]).toBe("01_abstract");
    expect(result.inputs).toContain("10_appendix");
    for (const anchor of ["00_title", "01_abstract", "10_appendix"]) {
      expect(main()).toContain(`\\input{sections/${anchor}}`);
    }
  });

  it("takes the table's order as the reading order", () => {
    // The plan decides where a section goes. Listing Conclusion first is an
    // odd paper, not something to silently reorder behind the author's back.
    writePaper([
      "| Conclusion | Restate | claims |",
      "| Introduction | Tension | thesis |",
    ]);
    writeMain([]);

    const result = reconcileMainTex(tmpDir, readPlannedSections(tmpDir));

    expect(result.inputs).toEqual([
      "00_title",
      "01_abstract",
      "02_conclusion",
      "03_intro",
      "10_appendix",
    ]);
  });

  it("keeps the appendix after \\appendix and body sections before it", () => {
    writePaper(["| Introduction | Tension | thesis |", "| Analysis | Tables | values |"]);
    writeMain([]);

    reconcileMainTex(tmpDir, readPlannedSections(tmpDir));

    const text = main();
    const marker = text.indexOf("\\appendix");
    expect(text.indexOf("sections/02_intro")).toBeLessThan(marker);
    expect(text.indexOf("sections/03_analysis")).toBeLessThan(marker);
    expect(text.indexOf("sections/10_appendix")).toBeGreaterThan(marker);
  });

  it("drops the conditional wrapper around a section it removed", () => {
    writeFileSync(join(tmpDir, "paper", "sections", "08_acknowledgement.tex"), "% placeholder\n");
    writeFileSync(
      join(tmpDir, "paper", "main.tex"),
      [
        "\\documentclass{article}",
        "\\begin{document}",
        "\\input{sections/00_title}",
        "\\ifPaperAcknowledgements",
        "  \\input{sections/08_acknowledgement}",
        "\\fi",
        "\\appendix",
        "\\input{sections/10_appendix}",
        "\\end{document}",
        "",
      ].join("\n"),
    );
    writePaper(["| Introduction | Tension | thesis |"]);

    reconcileMainTex(tmpDir, readPlannedSections(tmpDir));

    expect(main()).not.toContain("08_acknowledgement");
    expect(main()).not.toContain("ifPaperAcknowledgements");
  });
});

describe("conditionals in main.tex survive the rewrite", () => {
  /** The template's own preamble and body, in the shape that broke. */
  const TEMPLATE = [
    "\\documentclass{article}",
    "\\title{\\PaperTitle}",
    "\\ifPaperAnonymous",
    "  \\author{Anonymous Authors}",
    "\\else",
    "  \\author{\\PaperAuthors}",
    "\\fi",
    "\\begin{document}",
    "\\input{sections/00_title}",
    "\\input{sections/01_abstract}",
    "\\input{sections/02_intro}",
    "\\ifPaperAcknowledgements",
    "\\input{sections/08_acknowledgement}",
    "\\fi",
    "\\appendix",
    "\\input{sections/10_appendix}",
    "\\end{document}",
    "",
  ].join("\n");

  const PLAN = [
    { title: "Title", stem: "00_title", readerTask: "" },
    { title: "Abstract", stem: "01_abstract", readerTask: "" },
    { title: "Introduction", stem: "02_intro", readerTask: "" },
    { title: "Appendix", stem: "10_appendix", readerTask: "" },
  ];

  function rewrite(): string {
    writeFileSync(join(tmpDir, "paper", "main.tex"), TEMPLATE);
    reconcileMainTex(tmpDir, PLAN);
    return readFileSync(join(tmpDir, "paper", "main.tex"), "utf-8");
  }

  it("keeps the \\fi closing a conditional that guards prose, not a section", () => {
    // A two-line proximity window judged this \fi a section guard, because
    // \input{sections/00_title} sat two lines below it, and dropped it. TeX
    // answered "! Incomplete \iftrue; all text was ignored after line 15" and
    // the drafting stage spent its remediation attempts on a file it had not
    // written.
    const out = rewrite();

    expect(out).toContain("\\ifPaperAnonymous");
    expect(out).toContain("\\author{Anonymous Authors}");
    expect(out.split("\n").filter((line) => line.trim() === "\\fi")).toHaveLength(1);
  });

  it("leaves \\if and \\fi balanced", () => {
    const out = rewrite();

    expect((out.match(/\\if[a-zA-Z@]+/g) ?? []).length).toBe(
      (out.match(/\\fi\b/g) ?? []).length,
    );
  });

  it("still drops a guard whose only content was a dropped section", () => {
    const out = rewrite();

    expect(out).not.toContain("ifPaperAcknowledgements");
    expect(out).not.toContain("08_acknowledgement");
  });
});
