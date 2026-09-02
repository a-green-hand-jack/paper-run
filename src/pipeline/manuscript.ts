/**
 * What the manuscript actually contains.
 *
 * Every validator before this one asked structural questions: does the file
 * exist, does the section have a heading, did the script exit zero. A
 * manuscript can satisfy all of them and still be four pages with no citations
 * and none of the supplied figures — which is exactly what happened on
 * PaperWrite-Bench pwb-0011, where a run passed thirteen stages and produced a
 * paper citing nothing at all.
 *
 * These are floors, not targets. They cannot tell a good paper from a dull one.
 * What they can do is notice that a paper is not finished, which no check in
 * the pipeline previously did.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";

import { proseOnly } from "./prose-quality.js";

export interface ManuscriptStats {
  /** Words of authored prose across every section the document inputs. */
  words: number;
  /** Section stems `main.tex` inputs, in document order. */
  inputs: string[];
  /** Distinct BibTeX keys the manuscript cites. */
  citedKeys: string[];
  /** How many section files contain at least one citation. */
  filesWithCitations: number;
  /**
   * Section stems the manuscript inputs whose body is a placeholder.
   *
   * A `% TODO(paper-run):` marker inside real prose is the sanctioned way to
   * record a gap and is not a placeholder. A file whose entire body is the
   * word TODO is: pwb-0011 shipped `\\input{sections/10_appendix}` over a file
   * containing nothing else, and it took a 374,000-token review half to
   * notice.
   */
  placeholderSections: string[];
  /** Keys defined in the bibliography. */
  bibKeys: string[];
  /** Cited keys with no entry in the bibliography — always a hard error. */
  undefinedKeys: string[];
  /** Paths passed to \includegraphics. */
  includedGraphics: string[];
  /** Image assets available to the paper. */
  figureAssets: string[];
  tableEnvironments: number;
}

/** The title slot `check-structure.py` requires, which holds no prose. */
const TITLE_ANCHOR = "00_title";

const CITE_RE =
  /\\(?<command>[A-Za-z]*cite[A-Za-z]*\*?)(?:\s*\[[^\]]*\]){0,2}\s*\{(?<keys>[^}]*)\}/g;
const INPUT_RE = /\\input\s*\{sections\/([^}]+)\}/g;
const GRAPHICS_RE = /\\includegraphics(?:\[[^\]]*\])?\{([^}]+)\}/g;
const IMAGE_EXTENSIONS = new Set([".pdf", ".png", ".jpg", ".jpeg", ".eps", ".svg"]);

// ---------------------------------------------------------------------------
// Reading the manuscript
// ---------------------------------------------------------------------------

/** Gather everything the floor checks need, in one pass over `paper/`. */
export function inspectManuscriptSources(projectDir: string): ManuscriptStats {
  const root = resolve(projectDir);
  const paperDir = join(root, "paper");
  const sectionsDir = join(paperDir, "sections");

  const mainPath = join(paperDir, "main.tex");
  const main = existsSync(mainPath) ? read(mainPath) : "";
  const inputs = [...main.matchAll(INPUT_RE)].map((match) => match[1]!.trim());

  let words = 0;
  let filesWithCitations = 0;
  const placeholderSections: string[] = [];
  const citedKeys = new Set<string>();
  const includedGraphics: string[] = [];
  let tableEnvironments = 0;

  // Only sections the document actually inputs count. A section left on disk
  // but dropped from main.tex is not part of this paper.
  for (const stem of inputs) {
    const path = join(sectionsDir, `${stem}.tex`);
    if (!existsSync(path)) continue;
    const body = read(path);

    const prose = proseOnly(body);
    if (isPlaceholder(body, prose, stem)) placeholderSections.push(stem);
    words += countWords(prose);
    const keys = citationKeys(body);
    if (keys.length > 0) filesWithCitations += 1;
    for (const key of keys) citedKeys.add(key);
    for (const match of body.matchAll(GRAPHICS_RE)) includedGraphics.push(match[1]!.trim());
    tableEnvironments += (body.match(/\\begin\{table\*?\}/g) ?? []).length;
  }

  // main.tex may carry prose and floats of its own.
  words += countWords(proseOnly(stripInputs(main)));
  for (const key of citationKeys(main)) citedKeys.add(key);
  for (const match of stripInputs(main).matchAll(GRAPHICS_RE)) {
    includedGraphics.push(match[1]!.trim());
  }
  tableEnvironments += (stripInputs(main).match(/\\begin\{table\*?\}/g) ?? []).length;

  const bibKeys = readBibKeys(paperDir);
  const cited = [...citedKeys].sort();

  return {
    words,
    inputs,
    citedKeys: cited,
    filesWithCitations,
    placeholderSections,
    bibKeys,
    undefinedKeys: bibKeys.length === 0 ? [] : cited.filter((key) => !bibKeys.includes(key)),
    includedGraphics,
    figureAssets: discoverFigureAssets(root),
    tableEnvironments,
  };
}

/**
 * How many distinct works this paper ought to cite, at minimum.
 *
 * Scaled to the bibliography it was given rather than fixed: a repository that
 * ships no bibliography has nothing to cite and the check goes quiet, while a
 * task that supplies fifty-two entries plainly expects more than none. A fifth
 * of the bibliography, capped at twelve, sits far below what a real paper uses
 * — pwb-0011's ground truth cited forty-three of fifty-two and the baseline
 * twenty. This is the line under which the paper is unfinished, not the line
 * above which it is good.
 */
export function citationFloor(stats: ManuscriptStats): number {
  const usable = stats.bibKeys.filter((key) => !/^(todo|tbd|placeholder)$/i.test(key));
  if (usable.length < 5) return 0;
  return Math.min(12, Math.ceil(0.2 * usable.length));
}

/**
 * The page budget this paper is writing to, or null when nobody stated one.
 *
 * `BRIEF.md` is the primary source because it is the human's own words and
 * `checkLockedContracts` holds it byte-immutable — the model cannot widen its
 * own target. A venue knowledge file is consulted first only when it carries a
 * real number; offline runs leave that field `UNVERIFIED`, which is honest and
 * useless here.
 */
export function pageBudget(projectDir: string): number | null {
  const root = resolve(projectDir);

  const venuesDir = join(root, ".agents", "knowledge", "venues");
  if (existsSync(venuesDir)) {
    for (const entry of safeReaddir(venuesDir)) {
      if (!entry.endsWith(".md") || entry === "README.md" || entry === "_template.md") continue;
      const match = read(join(venuesDir, entry)).match(/^\s*-?\s*main_text:\s*(\d{1,2})\b/mi);
      if (match) return Number(match[1]);
    }
  }

  const briefPath = join(root, "BRIEF.md");
  if (!existsSync(briefPath)) return null;
  const words: Record<string, number> = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
    seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  };
  const match = read(briefPath).match(
    /\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)[\s-]?pages?\b/i,
  );
  if (!match) return null;
  const token = match[1]!.toLowerCase();
  return /^\d+$/.test(token) ? Number(token) : (words[token] ?? null);
}

/**
 * The word band a page budget implies.
 *
 * Deliberately wide. Tables and figures displace prose, and a paper that lands
 * anywhere in this range is not the failure this check exists to catch — a
 * 1,738-word draft against a nine-page brief is.
 */
export function wordTarget(pages: number): { min: number; max: number } {
  return { min: Math.round(0.7 * pages * 550), max: Math.round(1.1 * pages * 650) };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * A section body that says nothing.
 *
 * Empty, or made up entirely of placeholder tokens and punctuation. Sanctioned
 * `% TODO(paper-run):` markers never reach here — `proseOnly` strips comments,
 * so a file of real prose carrying one still reads as prose.
 */
function isPlaceholder(body: string, prose: string, stem: string): boolean {
  // `check-structure.py` forces `main.tex` to input three anchors --
  // `00_title`, `01_abstract` and `10_appendix` -- whether or not this paper
  // has content for them. Two of the three legitimately hold no prose at all:
  // a title slot is `\maketitle`, and a paper with no appendix has an empty
  // appendix. Demanding prose there would deadlock the manuscript against a
  // structural rule it cannot satisfy, the same shape as the
  // supplied-bibliography deadlock.
  //
  // So the anchors are held to a weaker rule: say nothing, or say something
  // real. An appendix printing the word TODO into the PDF still fails, and
  // that is what shipped last time. `01_abstract` is not an anchor here --
  // an abstract that says nothing is a broken paper, not a structural slot.
  if (stem === TITLE_ANCHOR || /^1\d_/.test(stem)) return hasVisiblePlaceholder(prose);

  // `proseOnly` drops the command but keeps its argument, so a file holding
  // only `\section{Conclusion}` arrives here as the word "Conclusion". A
  // heading is not prose: subtract the titles the body declares.
  const headings = [...body.matchAll(/\\(?:sub)*(?:section|paragraph)\*?\s*\{([^{}]*)\}/g)]
    .flatMap((match) => (match[1] ?? "").split(/[^A-Za-z]+/))
    .filter((word) => word.length > 0)
    .map((word) => word.toLowerCase());

  const words = prose
    .replace(/\\[a-zA-Z@]+\*?(\[[^\]]*\])?(\{[^{}]*\})?/g, " ")
    .split(/[^A-Za-z]+/)
    .filter((word) => word.length > 0);

  const remaining = [...words];
  for (const heading of headings) {
    const index = remaining.findIndex((word) => word.toLowerCase() === heading);
    if (index !== -1) remaining.splice(index, 1);
  }

  if (remaining.length === 0) return true;
  return remaining.every((word) =>
    /^(todo|tbd|fixme|placeholder|lorem|ipsum|xxx|na)$/i.test(word),
  );
}

/**
 * Placeholder text that would render into the PDF.
 *
 * `% TODO(paper-run):` markers are comments and `proseOnly` has already
 * removed them; what reaches here is body text a reader would see.
 */
function hasVisiblePlaceholder(prose: string): boolean {
  const words = prose
    .replace(/\\[a-zA-Z@]+\*?(\[[^\]]*\])?(\{[^{}]*\})?/g, " ")
    .split(/[^A-Za-z]+/)
    .filter((word) => word.length > 0);

  return words.some((word) => /^(todo|tbd|fixme|placeholder|lorem|ipsum)$/i.test(word));
}

function read(path: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

function stripInputs(text: string): string {
  return text.replace(INPUT_RE, " ");
}

function countWords(text: string): number {
  return (text.match(/[A-Za-z]+(?:[-'][A-Za-z]+)*/g) ?? []).length;
}

function citationKeys(text: string): string[] {
  const keys = new Set<string>();
  for (const match of text.matchAll(CITE_RE)) {
    if (match.groups?.["command"]?.toLowerCase().startsWith("nocite")) continue;
    for (const key of (match.groups?.["keys"] ?? "").split(",")) {
      const trimmed = key.trim();
      if (trimmed) keys.add(trimmed);
    }
  }
  return [...keys];
}

/** Keys defined by whichever bibliography the paper carries. */
function readBibKeys(paperDir: string): string[] {
  for (const name of ["refs.bib", "references.bib"]) {
    const path = join(paperDir, name);
    if (!existsSync(path)) continue;
    const keys = [...read(path).matchAll(/@\w+\s*\{\s*([^,\s]+)/g)].map((match) => match[1]!);
    if (keys.length > 0) return keys;
  }
  return [];
}

/** Image assets the paper could use, from the paper tree and the materials. */
function discoverFigureAssets(root: string): string[] {
  const found: string[] = [];
  for (const dir of [join(root, "paper", "figures"), join(root, "materials", "figures"), join(root, "figures")]) {
    if (!existsSync(dir)) continue;
    collect(dir, root, found, 0);
  }
  return [...new Set(found)].sort();
}

function collect(dir: string, root: string, out: string[], depth: number): void {
  if (depth > 2 || out.length > 200) return;
  for (const entry of safeReaddir(dir)) {
    if (entry.startsWith(".")) continue;
    const path = join(dir, entry);
    let stat;
    try {
      stat = statSync(path);
    } catch {
      continue;
    }
    if (stat.isDirectory()) collect(path, root, out, depth + 1);
    else if (IMAGE_EXTENSIONS.has(extname(entry).toLowerCase())) out.push(entry);
  }
}

/** True when the manuscript places an asset, matched on basename. */
export function graphicIsPlaced(asset: string, includedGraphics: readonly string[]): boolean {
  const stem = asset.replace(/\.[^.]+$/, "");
  return includedGraphics.some((included) => {
    const base = included.split("/").pop() ?? included;
    return base === asset || base.replace(/\.[^.]+$/, "") === stem;
  });
}
