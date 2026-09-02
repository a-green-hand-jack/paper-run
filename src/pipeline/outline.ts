/**
 * The manuscript's outline, read from the contract rather than the filesystem.
 *
 * An earlier version drafted one turn per `paper/sections/*.tex` file it found
 * on disk. That list is the *template's* — ten fixed files — and it has nothing
 * to do with the paper being written. The consequence was measured: a run whose
 * agreed outline included an Analysis section had nowhere to put it, and spent
 * two of its ten drafting turns on a limitations section and an
 * acknowledgements section that the task explicitly forbade.
 *
 * So the outline is `PAPER.md`'s `### Section responsibilities` table, and the
 * filesystem is reconciled to it. The table is written by the planning stage,
 * which is the turn that actually decides what the paper's argument needs.
 *
 * ## Staying legal
 *
 * The harness's `check-structure.py` constrains the layout and this module has
 * to respect it: section files match `NN_name.tex`; `main.tex` must input
 * `00_title`, `01_abstract` and `10_appendix`; every input must exist; body
 * (`0*`) and appendix (`1*`) inputs ascend; body sections precede `\appendix`
 * and appendix sections follow it. Files that exist without being inputted are
 * fine, which is why an unwanted template section is simply left out of
 * `main.tex` rather than deleted.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** One row of the section responsibilities table. */
export interface PlannedSection {
  /** The table's own name for the section, e.g. "Related work". */
  title: string;
  /** The `paper/sections` stem, e.g. `03_related`. */
  stem: string;
  /** What the section owes the reader, for the drafting prompt. */
  readerTask: string;
}

/** Sections every manuscript has a slot for, whatever the table says. */
const TITLE_STEM = "00_title";
const ABSTRACT_STEM = "01_abstract";
const APPENDIX_STEM = "10_appendix";

/** Body sections occupy 02..09, so eight is the ceiling. */
const MAX_BODY_SECTIONS = 8;

const STEM_RE = /^[01]\d_[a-z][a-z0-9_]*$/;

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Read the planned sections in reading order.
 *
 * Returns an empty list when the table is missing or unparseable; the
 * `section_plan` validator is what turns that into a stage failure, so callers
 * here can treat it as "no plan yet".
 */
export function readPlannedSections(projectDir: string): PlannedSection[] {
  const path = join(resolve(projectDir), "PAPER.md");
  if (!existsSync(path)) return [];

  let markdown: string;
  try {
    markdown = readFileSync(path, "utf-8");
  } catch {
    return [];
  }

  const rows = tableRows(markdown, "### Section responsibilities");
  if (rows.length === 0) return [];

  const sections: PlannedSection[] = [];
  let bodyIndex = 2;

  for (const row of rows) {
    const title = (row["section"] ?? "").trim();
    if (!title) continue;

    const declared = normalizeStem(row["file"]);
    const role = classify(title);

    let stem: string;
    if (declared) {
      stem = declared;
    } else if (role === "title") {
      stem = TITLE_STEM;
    } else if (role === "abstract") {
      stem = ABSTRACT_STEM;
    } else if (role === "appendix") {
      stem = APPENDIX_STEM;
    } else {
      stem = `${String(bodyIndex).padStart(2, "0")}_${slug(title)}`;
      bodyIndex += 1;
    }

    if (sections.some((section) => section.stem === stem)) continue;
    sections.push({ title, stem, readerTask: (row["reader task"] ?? "").trim() });
  }

  return sections;
}

/**
 * Everything wrong with a parsed plan, as messages a stage can report.
 *
 * Empty means the plan is usable.
 */
export function planIssues(sections: readonly PlannedSection[]): string[] {
  const issues: string[] = [];

  if (sections.length === 0) {
    return [
      "PAPER.md ### Section responsibilities has no usable rows — drafting reads that table to decide which sections to write",
    ];
  }

  for (const section of sections) {
    if (!STEM_RE.test(section.stem)) {
      issues.push(
        `section "${section.title}" maps to "${section.stem}", which is not a valid NN_name section stem`,
      );
    }
  }

  const body = sections.filter((section) => section.stem.startsWith("0"));
  if (body.length > MAX_BODY_SECTIONS + 2) {
    issues.push(
      `${body.length} body sections exceeds the ${MAX_BODY_SECTIONS + 2} that the 0X naming allows`,
    );
  }

  const stems = sections.map((section) => section.stem);
  const duplicates = stems.filter((stem, index) => stems.indexOf(stem) !== index);
  if (duplicates.length > 0) {
    issues.push(`duplicate section files: ${[...new Set(duplicates)].join(", ")}`);
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Reconciling the filesystem and main.tex
// ---------------------------------------------------------------------------

export interface Reconciliation {
  /** Section files created because the plan named them and they did not exist. */
  created: string[];
  /** The stems `main.tex` now inputs, in order. */
  inputs: string[];
}

/**
 * Make `paper/` match the plan.
 *
 * Deliberately controller-owned rather than asked of the model: the layout has
 * hard rules, regenerating a list of `\input` lines needs no judgement, and a
 * drafting turn that has to fix its own scaffolding before writing is a turn
 * spent on the wrong thing.
 *
 * Sections the plan does not name are left on disk and dropped from
 * `main.tex` — `check-structure.py` allows an uninputted file, and deleting a
 * template section would be an irreversible answer to a reversible question.
 */
export function reconcileMainTex(
  projectDir: string,
  sections: readonly PlannedSection[],
): Reconciliation {
  const root = resolve(projectDir);
  const sectionsDir = join(root, "paper", "sections");
  mkdirSync(sectionsDir, { recursive: true });

  const ordered = orderForDocument(sections);
  const created: string[] = [];

  for (const section of ordered) {
    const path = join(sectionsDir, `${section.stem}.tex`);
    if (existsSync(path)) continue;
    writeFileSync(
      path,
      [
        `% ${section.title}`,
        section.readerTask ? `% Reader task: ${section.readerTask}` : "",
        `% Created from PAPER.md ### Section responsibilities. Draft this section here.`,
        "",
      ]
        .filter((line) => line !== "")
        .join("\n") + "\n",
      "utf-8",
    );
    created.push(`paper/sections/${section.stem}.tex`);
  }

  const mainPath = join(root, "paper", "main.tex");
  if (existsSync(mainPath)) {
    writeFileSync(mainPath, rewriteInputs(readFileSync(mainPath, "utf-8"), ordered), "utf-8");
  }

  return { created, inputs: ordered.map((section) => section.stem) };
}

/**
 * The plan plus the three anchors the harness requires, in document order.
 *
 * Body sections keep the order the table gave them; the anchors are placed
 * regardless, because `check-structure.py` fails a `main.tex` that omits them
 * and a paper without a title or abstract is not a paper.
 */
function orderForDocument(sections: readonly PlannedSection[]): PlannedSection[] {
  const byStem = new Map(sections.map((section) => [section.stem, section]));

  const anchor = (stem: string, title: string): PlannedSection =>
    byStem.get(stem) ?? { title, stem, readerTask: "" };

  const body = sections
    .filter(
      (section) =>
        section.stem.startsWith("0") &&
        section.stem !== TITLE_STEM &&
        section.stem !== ABSTRACT_STEM,
    )
    .sort((a, b) => a.stem.localeCompare(b.stem));

  const appendix = sections
    .filter((section) => section.stem.startsWith("1") && section.stem !== APPENDIX_STEM)
    .sort((a, b) => a.stem.localeCompare(b.stem));

  return [
    anchor(TITLE_STEM, "Title"),
    anchor(ABSTRACT_STEM, "Abstract"),
    ...body,
    anchor(APPENDIX_STEM, "Appendix"),
    ...appendix,
  ];
}

/**
 * Replace `main.tex`'s section inputs with the planned ones.
 *
 * Body inputs go where the first existing section input was; appendix inputs go
 * after `\appendix`. Any conditional wrapper around a section input (the
 * template guards acknowledgements with `\ifPaperAcknowledgements`) goes with
 * the line it guarded, since the section it referred to may no longer be part
 * of the paper.
 */
function rewriteInputs(main: string, ordered: readonly PlannedSection[]): string {
  const lines = main.split("\n");
  const isSectionInput = (line: string) => /\\input\s*\{sections\//.test(line);
  const appendixLine = lines.findIndex((line) => /\\appendix/.test(line));
  const body = ordered.filter((section) => section.stem.startsWith("0"));
  const appendix = ordered.filter((section) => section.stem.startsWith("1"));

  const droppableGuards = guardLinesToDrop(lines);

  const kept: string[] = [];
  let bodyPlaced = false;
  let appendixPlaced = false;

  for (const [index, line] of lines.entries()) {
    const beforeAppendix = appendixLine === -1 || index < appendixLine;

    if (isSectionInput(line)) {
      if (beforeAppendix) {
        if (!bodyPlaced) {
          kept.push(...body.map((section) => `\\input{sections/${section.stem}}`));
          bodyPlaced = true;
        }
      } else if (!appendixPlaced) {
        kept.push(...appendix.map((section) => `\\input{sections/${section.stem}}`));
        appendixPlaced = true;
      }
      continue;
    }

    // A guard whose only purpose was wrapping a section input is dropped with
    // it; guards around anything else are left alone.
    if (droppableGuards.has(index)) continue;

    kept.push(line);
  }

  if (!bodyPlaced) {
    const insertAt = kept.findIndex((line) => /\\begin\{document\}/.test(line));
    const block = body.map((section) => `\\input{sections/${section.stem}}`);
    if (insertAt >= 0) kept.splice(insertAt + 1, 0, ...block);
    else kept.push(...block);
  }
  if (!appendixPlaced && appendix.length > 0) {
    const insertAt = kept.findIndex((line) => /\\appendix/.test(line));
    const block = appendix.map((section) => `\\input{sections/${section.stem}}`);
    if (insertAt >= 0) kept.splice(insertAt + 1, 0, ...block);
    else kept.push(...block);
  }

  return kept.join("\n");
}

/**
 * Guard lines whose conditional wraps nothing but section inputs.
 *
 * The template guards its acknowledgements input with
 * `\ifPaperAcknowledgements ... \fi`, and when the plan drops that section the
 * guard has to go with it. A guard around anything else must survive intact.
 *
 * This used to be decided by a two-line proximity window, which cannot tell
 * the two apart. On pwb-0011 it dropped the `\fi` closing the anonymous-author
 * conditional purely because `\input{sections/00_title}` sat two lines below
 * it, leaving `\ifPaperAnonymous` unterminated:
 *
 *     \ifPaperAnonymous
 *       \author{Anonymous Authors}
 *     \else
 *       \author{\PaperAuthors}
 *     \begin{document}          <- no \fi
 *
 * TeX answered `! Incomplete \iftrue; all text was ignored after line 15`,
 * and the drafting stage spent its remediation attempts on a file it had not
 * written and could not have fixed.
 *
 * So match the conditionals properly and judge each block by its contents.
 */
function guardLinesToDrop(lines: readonly string[]): Set<number> {
  const isOpen = (line: string) =>
    /^\s*\\if[a-zA-Z@]*\s*$/.test(line) || /^\s*\\if[a-zA-Z@]+\b/.test(line.trimEnd());
  const isElse = (line: string) => /^\s*\\else\s*$/.test(line);
  const isClose = (line: string) => /^\s*\\fi\s*$/.test(line);
  const isSectionInput = (line: string) => /\\input\s*\{sections\//.test(line);
  const isIgnorable = (line: string) => line.trim() === "" || line.trim().startsWith("%");

  const drop = new Set<number>();
  const open: { start: number; guards: number[]; inputs: number; other: number }[] = [];

  for (const [index, line] of lines.entries()) {
    if (isOpen(line) && !/\\newif/.test(line)) {
      open.push({ start: index, guards: [index], inputs: 0, other: 0 });
      continue;
    }

    const current = open.at(-1);
    if (!current) continue;

    if (isElse(line)) {
      current.guards.push(index);
      continue;
    }

    if (isClose(line)) {
      current.guards.push(index);
      open.pop();
      // Droppable only when the block exists to carry section inputs and
      // nothing else. An empty conditional is left alone: it is not ours.
      if (current.inputs > 0 && current.other === 0) {
        for (const guard of current.guards) drop.add(guard);
      } else {
        // Its contents survive, so an enclosing block has non-input content.
        const parent = open.at(-1);
        if (parent) parent.other += 1;
      }
      continue;
    }

    if (isSectionInput(line)) current.inputs += 1;
    else if (!isIgnorable(line)) current.other += 1;
  }

  return drop;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse the first GFM table under `heading` into lower-cased column maps. */
function tableRows(markdown: string, heading: string): Array<Record<string, string>> {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) return [];

  let header: string[] | null = null;
  const rows: Array<Record<string, string>> = [];

  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();

    if (/^#{1,6}\s/.test(trimmed) && header !== null) break;
    if (!trimmed.startsWith("|")) {
      if (header !== null && rows.length > 0) break;
      continue;
    }

    const cells = trimmed.replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());

    if (header === null) {
      header = cells.map((cell) => cell.toLowerCase());
      continue;
    }
    // The alignment row.
    if (cells.every((cell) => /^:?-{2,}:?$/.test(cell))) continue;

    const row: Record<string, string> = {};
    for (const [index, key] of header.entries()) row[key] = cells[index] ?? "";
    rows.push(row);
  }

  return rows;
}

/** Accept `paper/sections/03_related.tex`, `03_related.tex`, or `03_related`. */
function normalizeStem(value: string | undefined): string | null {
  if (!value) return null;
  const stem = value
    .trim()
    .replace(/^`|`$/g, "")
    .replace(/^paper\/sections\//, "")
    .replace(/\.tex$/, "")
    .trim();
  return STEM_RE.test(stem) ? stem : null;
}

/** Which slot a section name is asking for. */
function classify(title: string): "title" | "abstract" | "appendix" | "body" {
  const name = title.toLowerCase();
  if (/^title\b/.test(name)) return "title";
  if (name.includes("abstract")) return "abstract";
  if (name.includes("appendix") || name.includes("supplementary")) return "appendix";
  return "body";
}

/**
 * Conventional stems for the sections the harness template already ships.
 *
 * Without this, a plan saying "Introduction" would create
 * `02_introduction.tex` beside the template's unused `02_intro.tex` — two
 * files for one section, one of them empty. Matching the template's own names
 * reuses the file that is already there.
 */
const CONVENTIONAL_SLUGS: ReadonlyArray<[RegExp, string]> = [
  [/^intro/, "intro"],
  [/related|prior work|background/, "related"],
  [/method|approach|technique|framework/, "method"],
  [/experiment|evaluation|empirical|result/, "exp"],
  [/analysis|discussion|ablation/, "analysis"],
  [/conclusion|summary/, "conclusion"],
  [/limitation/, "limitations"],
  [/acknowledg/, "acknowledgement"],
];

/** A section name as a legal file stem suffix. */
function slug(title: string): string {
  const name = title.toLowerCase();
  for (const [pattern, stem] of CONVENTIONAL_SLUGS) {
    if (pattern.test(name)) return stem;
  }

  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 24);
  return /^[a-z]/.test(base) ? base : `s_${base || "section"}`;
}

/** Section files present on disk, for diagnostics. */
export function sectionFilesOnDisk(projectDir: string): string[] {
  const dir = join(resolve(projectDir), "paper", "sections");
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir).filter((entry) => entry.endsWith(".tex")).sort();
  } catch {
    return [];
  }
}
