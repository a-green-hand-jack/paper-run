/**
 * Prose quality checks the controller can run itself.
 *
 * ## Why this is a port rather than a call
 *
 * The harness vendors a working checker at
 * `.agents/vendor/ccfa-skills/ccf-paper-writer/scripts/check_prose_quality.py`,
 * and `ccf-paper-writer` tells the agent to run it. Nothing ever does: the
 * writer's `bash` permission is gated and it is told not to run repository
 * scripts, while `runCheck` only executes files inside `.agents/tools/` that
 * were hashed into the local trust manifest at init. Widening that boundary to
 * execute vendored third-party Python is a bad trade for one checker.
 *
 * So the rules are reimplemented here, where validation already lives. Rule
 * codes, severities, and thresholds mirror the vendored script so that a
 * finding means the same thing on both sides. When the harness promotes the
 * checker into `.agents/tools/`, this module can be replaced by an ordinary
 * `check_script` validator.
 *
 * ## What it can and cannot tell you
 *
 * These are *mechanical* tells — filler openers, promotional vocabulary,
 * template enumerations, suspiciously even sentence and paragraph lengths.
 * They correlate with unedited generated prose. They say nothing about whether
 * the argument holds, so a clean report is not evidence of a good paper. Treat
 * a finding as a prompt to re-read that passage, which is why the validator
 * ships advisory rather than required.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export type ProseSeverity = "error" | "warning" | "advisory";

export interface ProseIssue {
  code: string;
  severity: ProseSeverity;
  message: string;
  /** Short human-readable specifics: counts, sample text, line numbers. */
  detail?: string;
}

export interface ProseReport {
  scope: "paper" | "section";
  wordCount: number;
  emDashCount: number;
  emDashLimit: number;
  issues: ProseIssue[];
  /** Files that contributed prose, relative to the project root. */
  files: string[];
}

// ---------------------------------------------------------------------------
// Rule data — mirrors the vendored checker
// ---------------------------------------------------------------------------

const OPENING_FILLER: readonly RegExp[] = [
  /\bin the realm of\b/gi,
  /\bit is important to note that\b/gi,
  /\bit should be (?:noted|emphasized) that\b/gi,
  /\bit is worth (?:noting|mentioning) that\b/gi,
  /\bwe would like to (?:note|emphasize|highlight) that\b/gi,
  /\bin today'?s rapidly evolving\b/gi,
  /\bthis serves as a testament to\b/gi,
  /\bit goes without saying that\b/gi,
  /\bin order to\b/gi,
  /\bas a matter of fact\b/gi,
  /\bwhen it comes to\b/gi,
  /\bat the end of the day\b/gi,
  /\bwith that being said\b/gi,
  /\bthis section will discuss\b/gi,
  /\bthe following paragraph examines\b/gi,
  /\bwe now turn our attention to\b/gi,
];

const PRECISION_TERMS: readonly string[] = [
  "delve", "tapestry", "landscape", "pivotal", "crucial", "foster", "showcase",
  "testament", "navigate", "leverage", "realm", "embark", "underscore",
  "multifaceted", "nuanced", "comprehensive", "robust", "intricate",
  "cornerstone", "paradigm", "synergy", "holistic", "streamline",
  "cutting-edge", "groundbreaking",
];

const FORMULAIC_PATTERNS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: "not_only_but_also", pattern: /\bnot only\b[\s\S]{0,140}\bbut also\b/gi },
];

/**
 * Enumerative openers, as a deliberate narrowing of the vendored rule.
 *
 * The vendored checker matches `first` … `second` … `third` as bare words
 * within 300 characters of each other, which fires on ordinary prose:
 * "improves on the first dataset, and the second. The third shows no change."
 * Nothing can be rewritten to satisfy that, so it trains its readers to ignore
 * it. What the rule is actually after is the template enumeration — the three
 * words used as clause openers — so that is what this matches.
 */
const ENUMERATION_OPENERS: readonly RegExp[] = [
  /(?:^|[.!?;:]\s+|\n\s*)first(?:ly)?\s*[,:]/gi,
  /(?:^|[.!?;:]\s+|\n\s*)second(?:ly)?\s*[,:]/gi,
  /(?:^|[.!?;:]\s+|\n\s*)third(?:ly)?\s*[,:]/gi,
];

// ---------------------------------------------------------------------------
// Text preparation
// ---------------------------------------------------------------------------

/**
 * Reduce a source file to authored prose.
 *
 * Everything removed here is structure rather than writing: a `| --- |` table
 * rule counted as em dashes, or a table of numbers counted as sentences, would
 * produce findings that no amount of rewriting could clear. The LaTeX-specific
 * stripping is the part the vendored checker lacks, and paper-run needs it
 * because `paper/sections/*.tex` is the only place manuscript prose lives.
 */
export function proseOnly(text: string): string {
  let out = text;

  // Markdown fenced code.
  out = out.replace(/```[\s\S]*?```/g, " ");

  // LaTeX comments, but not an escaped percent sign.
  out = out.replace(/(^|[^\\])%.*$/gm, "$1 ");

  // Verbatim, math, and float environments: not authored sentences.
  const environments = [
    "verbatim", "lstlisting", "minted", "equation", "equation\\*", "align", "align\\*",
    "figure", "figure\\*", "table", "table\\*", "tabular", "algorithm", "algorithmic", "quote",
  ];
  for (const env of environments) {
    out = out.replace(new RegExp(`\\\\begin\\{${env}\\}[\\s\\S]*?\\\\end\\{${env}\\}`, "g"), " ");
  }

  // Inline and display math.
  out = out.replace(/\$\$[\s\S]*?\$\$/g, " ");
  out = out.replace(/(?<!\\)\$[^$\n]*\$/g, " ");
  out = out.replace(/\\\([\s\S]*?\\\)/g, " ");
  out = out.replace(/\\\[[\s\S]*?\\\]/g, " ");

  // Reference-like commands contribute keys, not prose.
  out = out.replace(/\\(?:cite[a-zA-Z]*|ref|eqref|label|autoref|url|input|include|usepackage|bibliography[a-zA-Z]*)\s*(?:\[[^\]]*\])?\{[^}]*\}/g, " ");

  // Remaining commands: drop the control word, keep any braced argument text.
  out = out.replace(/\\[a-zA-Z@]+\s*(?:\[[^\]]*\])?/g, " ");
  out = out.replace(/[{}]/g, " ");

  // Markdown tables, HTML tags, horizontal rules, quoted spans.
  out = out.replace(/^\s*\|.*\|\s*$/gm, " ");
  out = out.replace(/<[^>]+>/g, " ");
  out = out.replace(/^\s*(?:---+|___+|\*\*\*+)\s*$/gm, " ");
  out = out.replace(/“[^”]*”|"[^"\n]*"|‘[^’]*’/g, " ");

  return out;
}

function words(text: string): string[] {
  return text.match(/[A-Za-z]+(?:[-'][A-Za-z]+)*|[一-鿿]/g) ?? [];
}

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?。！？])\s+/)
    .map((s) => s.trim())
    .filter((s) => words(s).length >= 3);
}

// ---------------------------------------------------------------------------
// Inspection
// ---------------------------------------------------------------------------

/** Run every rule over one body of text. */
export function inspectProse(
  text: string,
  scope: "paper" | "section" = "paper",
  files: string[] = [],
): ProseReport {
  const prose = proseOnly(text);
  const issues: ProseIssue[] = [];
  const wordCount = words(prose).length;

  // --- em dashes ---
  const emDashCount =
    (prose.match(/—/g) ?? []).length + (prose.match(/(?<!-)---(?!-)/g) ?? []).length;
  const emDashLimit = scope === "paper" ? 3 : 0;
  if (emDashCount > emDashLimit) {
    issues.push({
      code: "em_dash_limit",
      severity: "error",
      message: `Authored prose contains ${emDashCount} em dashes; the ${scope} limit is ${emDashLimit}.`,
      detail: `${emDashCount}/${emDashLimit}`,
    });
  }

  // --- throat-clearing openers ---
  const fillers: string[] = [];
  for (const pattern of OPENING_FILLER) {
    for (const match of prose.matchAll(pattern)) {
      if (match[0]) fillers.push(match[0].toLowerCase());
    }
  }
  if (fillers.length > 0) {
    const unique = [...new Set(fillers)].slice(0, 5);
    issues.push({
      code: "opening_filler",
      severity: "warning",
      message: "Delete the throat-clearing openers where the following clause stands directly.",
      detail: `${fillers.length} occurrence(s): ${unique.join(", ")}`,
    });
  }

  // --- promotional or vague vocabulary ---
  const lower = prose.toLowerCase();
  const flagged: Array<[string, number]> = [];
  for (const term of PRECISION_TERMS) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const count = (lower.match(new RegExp(`\\b${escaped}\\b`, "g")) ?? []).length;
    if (count > 0) flagged.push([term, count]);
  }
  if (flagged.length > 0) {
    flagged.sort((a, b) => b[1] - a[1]);
    issues.push({
      code: "precision_terms",
      severity: "advisory",
      message: "Verify that each promotional or vague term is earned by evidence and scope.",
      detail: flagged.slice(0, 6).map(([term, count]) => `${term}×${count}`).join(", "),
    });
  }

  // --- template enumerations and contrasts ---
  for (const { name, pattern } of FORMULAIC_PATTERNS) {
    const matches = [...prose.matchAll(pattern)];
    if (matches.length > 0) {
      issues.push({
        code: "formulaic_structure",
        severity: "warning",
        message: "Check whether the enumeration or contrast follows the argument rather than a fixed template.",
        detail: `${name} ×${matches.length}`,
      });
    }
  }

  if (ENUMERATION_OPENERS.every((pattern) => pattern.test(prose))) {
    issues.push({
      code: "formulaic_structure",
      severity: "warning",
      message: "Check whether the enumeration or contrast follows the argument rather than a fixed template.",
      detail: "first_second_third openers",
    });
  }
  for (const pattern of ENUMERATION_OPENERS) pattern.lastIndex = 0;

  // --- sentence rhythm ---
  const lengths = sentences(prose).map((sentence) => words(sentence).length);
  const narrowRuns: number[] = [];
  for (let start = 0; start + 5 <= lengths.length; start++) {
    const window = lengths.slice(start, start + 5);
    if (Math.max(...window) - Math.min(...window) <= 5) narrowRuns.push(start + 1);
  }
  if (narrowRuns.length > 0) {
    issues.push({
      code: "uniform_sentence_run",
      severity: "warning",
      message: "Review five-sentence runs with nearly identical length for repeated syntax.",
      detail: `${narrowRuns.length} run(s), first at sentence ${narrowRuns[0]}`,
    });
  }

  // --- paragraph rhythm ---
  const paragraphLengths = prose
    .split(/\n\s*\n/)
    .map((paragraph) => words(paragraph).length)
    .filter((length) => length >= 20);
  if (paragraphLengths.length >= 3) {
    const mean = paragraphLengths.reduce((sum, n) => sum + n, 0) / paragraphLengths.length;
    const spread = Math.max(...paragraphLengths.map((n) => Math.abs(n - mean) / mean));
    if (mean > 0 && spread <= 0.15) {
      issues.push({
        code: "uniform_paragraphs",
        severity: "advisory",
        message: "Review unusually uniform paragraph lengths; keep them when the genre requires regularity.",
        detail: `${paragraphLengths.length} paragraphs within ±${Math.round(spread * 100)}% of ${Math.round(mean)} words`,
      });
    }
  }

  // --- semicolons ---
  const semicolons = (prose.match(/;/g) ?? []).length;
  const semicolonRate = wordCount > 0 ? (semicolons * 1000) / wordCount : 0;
  if (semicolonRate > 2) {
    issues.push({
      code: "semicolon_density",
      severity: "advisory",
      message: "Review semicolon density above two per 1,000 prose words.",
      detail: `${semicolons} semicolons, ${semicolonRate.toFixed(2)} per 1,000 words`,
    });
  }

  return { scope, wordCount, emDashCount, emDashLimit, issues, files };
}

// ---------------------------------------------------------------------------
// Manuscript-level entry point
// ---------------------------------------------------------------------------

/**
 * Inspect the manuscript as one body of prose.
 *
 * Sections are concatenated rather than checked one by one: rhythm rules need
 * a document to be meaningful, and the vendored checker's per-section em-dash
 * limit of zero is too blunt for LaTeX, where `---` is ordinary punctuation.
 */
export function inspectManuscript(projectDir: string, dir = "paper/sections"): ProseReport {
  const root = resolve(projectDir);
  const sectionsDir = join(root, dir);

  if (!existsSync(sectionsDir)) {
    return { scope: "paper", wordCount: 0, emDashCount: 0, emDashLimit: 3, issues: [], files: [] };
  }

  const files: string[] = [];
  const parts: string[] = [];

  let entries: string[];
  try {
    entries = readdirSync(sectionsDir).sort();
  } catch {
    entries = [];
  }

  for (const entry of entries) {
    if (!entry.endsWith(".tex")) continue;
    const path = join(sectionsDir, entry);
    try {
      if (!statSync(path).isFile()) continue;
      parts.push(readFileSync(path, "utf-8"));
      files.push(`${dir}/${entry}`);
    } catch {
      // An unreadable section is the structural validators' problem, not this one.
    }
  }

  return inspectProse(parts.join("\n\n"), "paper", files);
}

/** One-line summary for a validator message or a log. */
export function summarizeProseReport(report: ProseReport): string {
  if (report.issues.length === 0) {
    return `prose check clean (${report.wordCount} words across ${report.files.length} file(s))`;
  }
  const parts = report.issues.map(
    (issue) => `${issue.severity}/${issue.code}${issue.detail ? ` (${issue.detail})` : ""}`,
  );
  return `${report.issues.length} prose finding(s): ${parts.join("; ")}`;
}

/** Findings at or above `warning` — the ones the vendored checker blocks on. */
export function blockingProseIssues(report: ProseReport): ProseIssue[] {
  return report.issues.filter((issue) => issue.severity === "error" || issue.severity === "warning");
}
