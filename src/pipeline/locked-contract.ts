import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

import { execa } from "execa";

export type LockedPaperSelector =
  | "central_thesis"
  | "contributions"
  | "working_title"
  | "target_venue"
  | "paper_type"
  | "intended_readers"
  | "authors_identity";

export interface LockedContractBaseline {
  baseCommit: string;
  brief: string;
  paper: string;
  candidateDigest: string;
}

export interface LockedContractViolation {
  file: "BRIEF.md" | "PAPER.md";
  message: string;
  selector?: LockedPaperSelector;
}

export interface LockedContractResult {
  passed: boolean;
  baseCommit: string;
  candidateDigest: string;
  violations: LockedContractViolation[];
}

const FIELD_SELECTORS: ReadonlyArray<[string, LockedPaperSelector]> = [
  ["Working title", "working_title"],
  ["Target venue", "target_venue"],
  ["Paper type", "paper_type"],
  ["Intended readers", "intended_readers"],
];

/** Capture immutable contract contents from HEAD once, before a stage starts. */
export async function captureLockedContractBaseline(
  projectDir: string,
): Promise<LockedContractBaseline> {
  const cwd = resolve(projectDir);
  const { stdout } = await execa("git", ["rev-parse", "HEAD"], { cwd });
  const baseCommit = stdout.trim();
  const [brief, paper] = await Promise.all([
    readFromCommit(cwd, baseCommit, "BRIEF.md"),
    readFromCommit(cwd, baseCommit, "PAPER.md"),
  ]);
  assertUnambiguousPaper(paper);

  return {
    baseCommit,
    brief,
    paper,
    candidateDigest: digestContracts(brief, paper),
  };
}

/** Compare the current contracts with a previously captured stage baseline. */
export function checkLockedContracts(
  projectDir: string,
  baseline: LockedContractBaseline,
): LockedContractResult {
  const root = resolve(projectDir);
  const brief = readCurrent(root, "BRIEF.md");
  const paper = readCurrent(root, "PAPER.md");
  return checkContractContents(baseline, brief, paper);
}

/** Compare the explicitly staged contracts with HEAD for manual checkpoints. */
export async function checkStagedLockedContracts(projectDir: string): Promise<LockedContractResult> {
  const baseline = await captureLockedContractBaseline(projectDir);
  const root = resolve(projectDir);
  const [brief, paper] = await Promise.all([
    readFromIndex(root, "BRIEF.md"),
    readFromIndex(root, "PAPER.md"),
  ]);
  return checkContractContents(baseline, brief, paper);
}

export function formatLockedContractFailure(result: LockedContractResult): string {
  const detail = result.violations.map((violation) => violation.message).join("; ");
  return (
    `locked-contract violation against base ${result.baseCommit}: ${detail}. ` +
    `Candidate digest: ${result.candidateDigest}. ` +
    "The run is stopped; ordinary stage approval cannot authorize this change because it is not bound to both values."
  );
}

function comparePaper(before: string, after: string): LockedContractViolation[] {
  const violations: LockedContractViolation[] = [];
  let baseline: ParsedPaper;
  let candidate: ParsedPaper;
  try {
    baseline = parsePaper(before);
  } catch (err) {
    return [{ file: "PAPER.md", message: `PAPER.md baseline is ambiguous: ${parseError(err)}` }];
  }
  try {
    candidate = parsePaper(after);
  } catch (err) {
    return [{ file: "PAPER.md", message: `PAPER.md candidate is ambiguous: ${parseError(err)}` }];
  }

  if (baseline.lockedSection !== candidate.lockedSection) {
    violations.push({
      file: "PAPER.md",
      message: "PAPER.md ## What must not change silently was modified",
    });
  }

  for (const selector of baseline.lockedSelectors) {
    if (baseline.values.get(selector) !== candidate.values.get(selector)) {
      violations.push({
        file: "PAPER.md",
        selector,
        message: `PAPER.md locked selector ${selector} was modified`,
      });
    }
  }

  if (baseline.unknownLockedItems.length > 0 && baseline.remainder !== candidate.remainder) {
    violations.push({
      file: "PAPER.md",
      message:
        `PAPER.md contains an unclassifiable change while these locked commitments cannot be mapped safely: ` +
        baseline.unknownLockedItems.join(" | "),
    });
  }

  return violations;
}

function checkContractContents(
  baseline: LockedContractBaseline,
  brief: string,
  paper: string,
): LockedContractResult {
  const violations: LockedContractViolation[] = [];
  if (brief !== baseline.brief) {
    violations.push({ file: "BRIEF.md", message: "BRIEF.md differs from the stage's Git checkpoint baseline" });
  }
  if (paper !== baseline.paper) violations.push(...comparePaper(baseline.paper, paper));
  return {
    passed: violations.length === 0,
    baseCommit: baseline.baseCommit,
    candidateDigest: digestContracts(brief, paper),
    violations,
  };
}

interface ParsedPaper {
  lockedSection: string;
  lockedSelectors: Set<LockedPaperSelector>;
  unknownLockedItems: string[];
  values: Map<LockedPaperSelector, string>;
  remainder: string;
}

function parsePaper(markdown: string): ParsedPaper {
  assertUnambiguousPaper(markdown);
  const sections = splitSections(markdown);
  const values = new Map<LockedPaperSelector, string>();
  const classifiedRanges: Array<[number, number, string]> = [];

  const identity = sections.get("paper identity");
  if (identity) {
    for (const [label, selector] of FIELD_SELECTORS) {
      const match = new RegExp(`^\\s*-?\\s*${escapeRegex(label)}\\s*:\\s*(.*)$`, "im").exec(identity.text);
      values.set(selector, match?.[1]?.trim() ?? "");
      if (match?.index !== undefined) {
        classifiedRanges.push([
          identity.start + match.index,
          identity.start + match.index + match[0].length,
          selector,
        ]);
      }
    }
  }

  const operatingMode = sections.get("operating mode");
  if (operatingMode) {
    const match = /^\s*(?:[-*]\s+)?Mode\s*:\s*.*$/im.exec(operatingMode.text);
    if (match?.index !== undefined) {
      classifiedRanges.push([operatingMode.start + match.index, operatingMode.start + match.index + match[0].length, "mode"]);
    }
  }

  addSectionSelector(sections, "what readers should believe", "central thesis", "central_thesis", values, classifiedRanges);
  addSectionSelector(sections, "what readers should believe", "contributions", "contributions", values, classifiedRanges);

  const authors = sections.get("authors and identity");
  values.set("authors_identity", authors?.text.trim() ?? "");
  if (authors) classifiedRanges.push([authors.start, authors.end, "authors_identity"]);

  const locked = sections.get("what must not change silently");
  const lockedSection = locked?.text.trim() ?? "";
  const lockedItems = extractLockedItems(lockedSection);
  const lockedSelectors = new Set<LockedPaperSelector>();
  const unknownLockedItems: string[] = [];

  for (const item of lockedItems) {
    const mapped = mapLockedItem(item);
    if (mapped.length === 0) unknownLockedItems.push(item);
    else mapped.forEach((selector) => lockedSelectors.add(selector));
  }

  addHeadingLockedSelectors(markdown, lockedSelectors);

  if (locked) classifiedRanges.push([locked.start, locked.end, "locked_items"]);

  return {
    lockedSection,
    lockedSelectors,
    unknownLockedItems,
    values,
    remainder: maskRanges(markdown, classifiedRanges),
  };
}

const PROTECTED_H2 = new Set([
  "paper identity",
  "what readers should believe",
  "authors and identity",
  "what must not change silently",
  "operating mode",
]);
const CONTROLLED_H3 = new Set(["central thesis", "contributions"]);

function assertUnambiguousPaper(markdown: string): void {
  assertNoDuplicateHeadings(markdown, 2, PROTECTED_H2);
  assertNoDuplicateHeadings(markdown, 3, CONTROLLED_H3);
}

function assertNoDuplicateHeadings(markdown: string, level: 2 | 3, controlled: Set<string>): void {
  const counts = new Map<string, number>();
  const pattern = new RegExp(`^#{${level}}\\s+(.+?)\\s*$`, "gm");
  for (const match of markdown.matchAll(pattern)) {
    const heading = normalizeHeading(match[1]!);
    if (!controlled.has(heading)) continue;
    const count = (counts.get(heading) ?? 0) + 1;
    counts.set(heading, count);
    if (count > 1) throw new Error(`duplicate protected heading: ${"#".repeat(level)} ${heading}`);
  }
}

function parseError(err: unknown): string {
  return err instanceof Error ? err.message : "contract parse failed";
}

interface Section {
  start: number;
  end: number;
  text: string;
}

function splitSections(markdown: string): Map<string, Section> {
  const matches = [...markdown.matchAll(/^##\s+(.+?)\s*$/gm)];
  const sections = new Map<string, Section>();
  for (let index = 0; index < matches.length; index++) {
    const match = matches[index]!;
    const start = match.index!;
    const end = matches[index + 1]?.index ?? markdown.length;
    sections.set(normalizeHeading(match[1]!), { start, end, text: markdown.slice(start, end) });
  }
  return sections;
}

function addHeadingLockedSelectors(markdown: string, selectors: Set<LockedPaperSelector>): void {
  for (const match of markdown.matchAll(/^(#{2,3})\s+(.+?)\s+[\u2014-]\s+locked\s*$/gim)) {
    const heading = normalizeHeading(match[2]!);
    if (heading === "central thesis") selectors.add("central_thesis");
    if (heading === "contributions") selectors.add("contributions");
    if (heading === "authors and identity") selectors.add("authors_identity");
    if (heading === "paper identity") {
      FIELD_SELECTORS.forEach(([, selector]) => selectors.add(selector));
    }
  }
}

function addSectionSelector(
  sections: Map<string, Section>,
  parentName: string,
  headingName: string,
  selector: LockedPaperSelector,
  values: Map<LockedPaperSelector, string>,
  ranges: Array<[number, number, string]>,
): void {
  const parent = sections.get(parentName);
  if (!parent) {
    values.set(selector, "");
    return;
  }

  const headings = [...parent.text.matchAll(/^###\s+(.+?)\s*$/gm)];
  const index = headings.findIndex((match) => normalizeHeading(match[1]!) === headingName);
  if (index === -1) {
    values.set(selector, "");
    return;
  }

  const match = headings[index]!;
  const localStart = match.index!;
  const localEnd = headings[index + 1]?.index ?? parent.text.length;
  values.set(selector, parent.text.slice(localStart, localEnd).trim());
  ranges.push([parent.start + localStart, parent.start + localEnd, selector]);
}

function normalizeHeading(heading: string): string {
  return heading.replace(/\s+[\u2014-]\s+(locked|bounded|free|unresolved)\s*$/i, "").trim().toLowerCase();
}

function extractLockedItems(section: string): string[] {
  if (!section) return [];
  const current = /Current locked items:\s*([\s\S]*)/i.exec(section)?.[1] ?? section.replace(/^##[^\n]*\n?/, "");
  const bullets = [...current.matchAll(/^\s*[-*]\s+(.+?)\s*$/gm)].map((match) => match[1]!.trim());
  const items = bullets.length > 0 ? bullets : current.split("\n").map((line) => line.trim()).filter(Boolean);
  return items.filter((item) => !/^(todo\b|none\.?$)/i.test(item));
}

function mapLockedItem(item: string): LockedPaperSelector[] {
  const normalized = item.toLowerCase();
  const selectors: LockedPaperSelector[] = [];
  if (/central\s+(thesis|claim)|scientific identity of the central claim/.test(normalized)) selectors.push("central_thesis");
  if (/\bcontributions?\b/.test(normalized)) selectors.push("contributions");
  if (/\bworking title\b|\bpaper title\b/.test(normalized)) selectors.push("working_title");
  if (/\btarget venue\b/.test(normalized)) selectors.push("target_venue");
  if (/\bpaper type\b/.test(normalized)) selectors.push("paper_type");
  if (/\bintended readers?\b|\btarget audience\b/.test(normalized)) selectors.push("intended_readers");
  if (/\bauthor list\b|\bauthors? and identity\b|\bauthor identity\b/.test(normalized)) selectors.push("authors_identity");
  return selectors;
}

function maskRanges(markdown: string, ranges: Array<[number, number, string]>): string {
  return ranges
    .sort((left, right) => right[0] - left[0])
    .reduce(
      (text, [start, end, selector]) => `${text.slice(0, start)}\n<${selector}>\n${text.slice(end)}`,
      markdown,
    );
}

async function readFromCommit(cwd: string, commit: string, path: string): Promise<string> {
  const { stdout } = await execa("git", ["show", `${commit}:${path}`], {
    cwd,
    stripFinalNewline: false,
  });
  return stdout;
}

async function readFromIndex(cwd: string, path: string): Promise<string> {
  try {
    const { stdout } = await execa("git", ["show", `:${path}`], { cwd, stripFinalNewline: false });
    return stdout;
  } catch {
    return "";
  }
}

function readCurrent(root: string, path: string): string {
  try {
    return readFileSync(join(root, path), "utf-8");
  } catch {
    return "";
  }
}

function digestContracts(brief: string, paper: string): string {
  return createHash("sha256").update("BRIEF.md\0").update(brief).update("\0PAPER.md\0").update(paper).digest("hex");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
