/**
 * Material assessment — the stage that can stop the run.
 *
 * Every other stage produces work. This one produces a judgement: can a paper
 * honestly be written from what the user supplied? It exists because the
 * alternative failure mode is the expensive one. An agent given thin materials
 * and told to write a paper will write *something* — fluent, structured, and
 * partly invented. A blocked run costs an afternoon; a fabricated paper can
 * cost a reputation, and the fabrication is not obvious on a read-through.
 *
 * ## Three verdicts
 *
 *  - `usable`   — proceed normally.
 *  - `partial`  — proceed, but every unsupported claim is carried as an
 *                 explicit TODO. This is the common case and it is fine.
 *  - `unusable` — hard stop before drafting, in either mode. Autonomy is not
 *                 licence to invent.
 *
 * ## Why the controller re-derives the verdict
 *
 * The agent writes `assessment.json`, but the controller does not simply trust
 * the `verdict` field. A verdict that contradicts its own criteria — "usable"
 * while reporting blockers — is a sign the model optimised for proceeding.
 * `reconcileVerdict` downgrades in that case, and never upgrades.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { AssessmentSchema } from "../state/schema.js";
import type { Assessment } from "../state/schema.js";
import { readAssessment } from "../state/store.js";
import { stageNumber, TOTAL_STAGES } from "./stages.js";
import { PAPER_RUN_DIR, STATE_FILES } from "../utils/constants.js";
import { log } from "../utils/logger.js";

export type Verdict = "usable" | "partial" | "unusable";

// ---------------------------------------------------------------------------
// The criteria the agent is asked to judge
// ---------------------------------------------------------------------------

export interface Criterion {
  key: string;
  question: string;
  sufficient: string;
  partial: string;
  absent: string;
}

export const ASSESSMENT_CRITERIA: readonly Criterion[] = [
  {
    key: "research_question",
    question: "Is there a clear research question or central claim?",
    sufficient: "Stated explicitly and specifically enough to write towards",
    partial: "Implied or vague — a reader could guess it, but it is not written down",
    absent: "No identifiable question or claim",
  },
  {
    key: "evidence",
    question: "Is there evidence sufficient to support the intended claims?",
    sufficient: "Results exist for the claims the paper intends to make",
    partial: "Some claims have supporting results; others do not",
    absent: "No results, data, or findings of any kind",
  },
  {
    key: "venue",
    question: "Is the target venue or publication form identified?",
    sufficient: "Named, or unambiguous from the brief",
    partial: "Not stated but reasonably inferable from the field and format",
    absent: "Unstated and not inferable, or the brief contradicts itself",
  },
  {
    key: "figures_tables",
    question: "Are the figures and tables the paper needs available or derivable?",
    sufficient: "Present, or the underlying data is there to build them",
    partial: "Some present; others missing with no data behind them",
    absent: "None present and no data from which to produce any",
  },
  {
    key: "related_work",
    question: "Is there enough related work to position the contribution?",
    sufficient: "A usable set of references, or clear pointers to the literature",
    partial: "Sparse, but enough to begin positioning",
    absent: "No references and no indication of the surrounding literature",
  },
] as const;

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

/**
 * Build the assessment prompt.
 *
 * The framing matters more than the rubric here. The prompt has to make an
 * honest `unusable` feel like a correct answer rather than a failure to
 * perform, because the model's default pull is to be helpful and proceed.
 */
export function renderAssessmentPrompt(opts: {
  materialFiles: string[];
  briefPresent: boolean;
  /** Directories the listing could not name in full. */
  elidedMaterials?: readonly { dir: string; omitted: number }[];
  /** Supplied files in total, when the listing is a subset. */
  totalMaterials?: number;
}): string {
  const criteria = ASSESSMENT_CRITERIA.map(
    (c) =>
      [
        `### ${c.key}`,
        c.question,
        `- **sufficient** — ${c.sufficient}`,
        `- **partial** — ${c.partial}`,
        `- **absent** — ${c.absent}`,
      ].join("\n"),
  ).join("\n\n");

  // A truncated listing must never read as a complete one. The stage's whole
  // job is judging what is present, so "these are the files" and "these are
  // some of the files" are different questions.
  const elided = opts.elidedMaterials ?? [];
  const heading =
    elided.length > 0
      ? `Some of the files available to you (${opts.materialFiles.length} of ${opts.totalMaterials ?? opts.materialFiles.length} shown):`
      : "Files available to you:";

  const tail =
    elided.length > 0
      ? [
          "",
          "**This listing is truncated.** These directories hold more than is named above:",
          ...elided.map((e) => `  - \`${e.dir}/\` — ${e.omitted} further file(s)`),
          "",
          "List them yourself before judging anything absent. A file missing from this",
          "listing is a file this prompt had no room for, never evidence that the",
          "repository does not supply it.",
        ].join("\n")
      : "";

  const inventory =
    opts.materialFiles.length > 0
      ? [heading, ...opts.materialFiles.map((f) => `  - ${f}`)].join("\n") + tail
      : "No material files were found beyond the contracts themselves.";

  const briefNote = opts.briefPresent
    ? "Read `BRIEF.md` first — it is the human's statement of intent."
    : "**`BRIEF.md` is missing or empty.** That alone is close to disqualifying: without a brief there is no stated intent to write towards.";

  return [
    `# Stage ${stageNumber("material_assessment")}/${TOTAL_STAGES}: Material assessment`,
    "",
    "Judge whether the supplied materials can support an honest paper. Do not write",
    "any part of the manuscript in this turn.",
    "",
    "This stage is owned by paper-run itself and intentionally has no harness owner skill.",
    "These instructions are the complete procedure; do not stop to request another skill.",
    "",
    briefNote,
    "",
    inventory,
    "",
    "## Criteria",
    "",
    "Rate each of these `sufficient`, `partial`, or `absent`, and say what you saw:",
    "",
    criteria,
    "",
    "## Verdict",
    "",
    "Then give one overall verdict:",
    "",
    "- **usable** — the paper can be written as intended.",
    "- **partial** — the paper can be started, but some claims will have to be carried",
    "  as explicit unresolved items. This is a normal, acceptable outcome.",
    "- **unusable** — a paper cannot honestly be written from this. Writing would mean",
    "  inventing the substance.",
    "",
    "## On answering honestly",
    "",
    "`unusable` is a correct and useful answer when it is true. It is not a failure to",
    "do your job — it is the job. The pipeline stops, the human is told exactly what is",
    "missing, and nobody ends up with a fluent paper built on invented results.",
    "",
    "Do not stretch to `partial` to keep things moving. If the evidence for the central",
    "claim does not exist, say so.",
    "",
    "## Scoping a partial verdict",
    "",
    "A `partial` verdict is not a licence to hedge the whole paper. Name each limit",
    "separately in `scope_limits`: the specific claim it constrains, what evidence is",
    "missing, and which sections or contract headings it touches. Everything you do not",
    "list will be written normally, in full, without markers — so a limit you cannot",
    "locate is not a limit, it is a worry, and it belongs in `summary`.",
    "",
    "## Output",
    "",
    `Write your assessment to \`${PAPER_RUN_DIR}/${STATE_FILES.assessment}\` as JSON:`,
    "",
    "```json",
    "{",
    '  "schema_version": "paper-run-assessment-v1",',
    '  "verdict": "usable | partial | unusable",',
    '  "criteria": {',
    '    "research_question": { "rating": "sufficient", "evidence": "what you saw" }',
    "  },",
    '  "summary": "two or three sentences",',
    '  "missing_for_usable": ["what would have to exist"],',
    '  "can_proceed_with": ["sections that can be written now"],',
    '  "blockers": ["what makes this unusable — empty unless the verdict is unusable"],',
    '  "assessed_files": ["files you actually read"],',
    '  "scope_limits": [',
    '    {',
    '      "id": "L1",',
    '      "claim": "the specific claim the evidence cannot carry",',
    '      "evidence_gap": "what is missing that would support it",',
    '      "applies_to": ["paper/sections/02_intro.tex", "PAPER.md ## What readers should believe"]',
    "    }",
    "  ],",
    `  "assessed_at": "${new Date().toISOString()}"`,
    "}",
    "```",
    "",
    "Include an entry in `criteria` for every criterion above. Report only files you",
    "actually opened in `assessed_files`.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Material discovery
// ---------------------------------------------------------------------------

/** Directories that may hold user-supplied materials. */
const MATERIAL_DIRS = ["materials", "evidence", "data", "figures"] as const;

/** Contracts that carry material information. */
const MATERIAL_CONTRACTS = ["BRIEF.md", "EXPERIMENTS.md"] as const;

/**
 * What the repository supplies, and what a bounded listing had to leave out.
 */
export interface MaterialInventory {
  /** Files to name in the prompt, project-relative. */
  files: string[];
  /** Every supplied file, before the budget was applied. */
  total: number;
  /** Directories whose contents the listing could not name in full. */
  elided: { dir: string; omitted: number }[];
}

/**
 * List the files a material assessment should consider.
 *
 * Bounded on purpose: a deep tree of raw data would flood the prompt. The
 * bound must be *fair*, though, and it was not. The listing was assembled
 * depth-first in alphabetical order against a flat cap of sixty, so on
 * pwb-0011 `materials/code/` — fifty-eight files, first alphabetically —
 * consumed the entire budget and the listing stopped at
 * `materials/figure_summary.txt`. Every result table, every figure asset, the
 * research overview, and the bibliography fell off the end of a list headed
 * "Files available to you", and the assessment correctly reported them absent.
 * A verdict of `unusable` followed, on a task that supplies four tables and
 * three figures.
 *
 * So the budget is now shared between directories rather than claimed by
 * whichever sorts first, and what did not fit is reported rather than dropped
 * in silence.
 */
export function discoverMaterials(projectDir: string, maxFiles = 60): string[] {
  return inventoryMaterials(projectDir, maxFiles).files;
}

/** `discoverMaterials`, plus what it had to leave out. */
export function inventoryMaterials(projectDir: string, maxFiles = 60): MaterialInventory {
  const root = resolve(projectDir);
  const contracts: string[] = [];

  for (const contract of MATERIAL_CONTRACTS) {
    const path = join(root, contract);
    if (existsSync(path) && statSync(path).size > 0) contracts.push(contract);
  }

  // Everything first, grouped by the directory it sits in. The ceiling is a
  // guard against a pathological tree, not a budget.
  const byDirectory = new Map<string, string[]>();
  let total = contracts.length;
  for (const dir of MATERIAL_DIRS) {
    const abs = join(root, dir);
    if (!existsSync(abs)) continue;
    total += collectFiles(abs, root, byDirectory, 0);
  }

  const budget = Math.max(maxFiles - contracts.length, 0);
  const groups = [...byDirectory.entries()].sort(([a], [b]) => a.localeCompare(b));
  const taken = new Map<string, number>();

  // Round-robin: every directory gets its first file before any gets its
  // second. A directory of two tables is never starved by a directory of
  // fifty configs.
  let placed = 0;
  for (let round = 0; placed < budget; round += 1) {
    let progressed = false;
    for (const [dir, files] of groups) {
      if (round >= files.length) continue;
      progressed = true;
      taken.set(dir, round + 1);
      placed += 1;
      if (placed >= budget) break;
    }
    if (!progressed) break;
  }

  const files = [...contracts];
  const elided: { dir: string; omitted: number }[] = [];
  for (const [dir, all] of groups) {
    const count = taken.get(dir) ?? 0;
    files.push(...all.slice(0, count));
    if (count < all.length) elided.push({ dir, omitted: all.length - count });
  }

  return { files: files.sort(), total, elided };
}

/**
 * Gather every file under `dir`, grouped by its parent directory.
 *
 * Returns how many it found. The 2,000-file ceiling exists so a raw data dump
 * cannot make this walk unbounded; it is far above any real material tree.
 */
function collectFiles(
  dir: string,
  root: string,
  out: Map<string, string[]>,
  depth: number,
): number {
  if (depth > 3) return 0;

  let entries: string[];
  try {
    entries = readdirSync(dir).sort();
  } catch {
    return 0;
  }

  let found = 0;
  for (const entry of entries) {
    if (entry.startsWith(".")) continue;

    const abs = join(dir, entry);
    let stat;
    try {
      stat = statSync(abs);
    } catch {
      continue;
    }

    if (stat.isDirectory()) {
      found += collectFiles(abs, root, out, depth + 1);
      continue;
    }
    if (stat.size === 0) continue;

    const path = relative(root, abs);
    const parent = relative(root, dir) || ".";
    const bucket = out.get(parent);
    if (bucket) bucket.push(path);
    else out.set(parent, [path]);
    found += 1;

    if (found > 2000) return found;
  }

  return found;
}

/** True when BRIEF.md exists with meaningful content. */
export function hasBrief(projectDir: string, minBytes = 32): boolean {
  const path = join(resolve(projectDir), "BRIEF.md");
  if (!existsSync(path)) return false;
  try {
    return statSync(path).size >= minBytes;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Reading and reconciling the verdict
// ---------------------------------------------------------------------------

export interface AssessmentOutcome {
  /** Present when the agent wrote a valid assessment. */
  assessment?: Assessment;
  /** The verdict the controller acts on, after reconciliation. */
  verdict?: Verdict;
  /** True when the pipeline must stop before drafting. */
  blocked: boolean;
  /** Why, when something went wrong or the run is blocked. */
  reason?: string;
  /** Set when reconciliation disagreed with the agent's stated verdict. */
  downgradedFrom?: Verdict;
}

/**
 * Read the assessment the agent wrote and decide what happens next.
 */
export function evaluateAssessment(projectDir: string): AssessmentOutcome {
  let assessment: Assessment | null;

  try {
    assessment = readAssessment(projectDir);
  } catch (err) {
    return {
      blocked: false,
      reason: `assessment.json is present but invalid: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!assessment) {
    return { blocked: false, reason: "no assessment.json was written" };
  }

  const stated = assessment.verdict;
  const reconciled = reconcileVerdict(assessment);

  const outcome: AssessmentOutcome = {
    assessment,
    verdict: reconciled,
    blocked: reconciled === "unusable",
  };

  if (reconciled !== stated) {
    outcome.downgradedFrom = stated;
    log.warn(
      `Material verdict downgraded from "${stated}" to "${reconciled}" — the assessment's own findings do not support "${stated}".`,
    );
  }

  if (reconciled === "unusable") {
    const blockers = assessment.blockers.length
      ? assessment.blockers.join("; ")
      : assessment.summary;
    outcome.reason = blockers;
  }

  return outcome;
}

/**
 * Re-derive the verdict from the assessment's own findings.
 *
 * Only ever downgrades. The point is to catch an assessment whose narrative
 * contradicts its data — reporting blockers while declaring `usable`, or
 * rating the central criteria `absent` while declaring `partial`. A model
 * under pressure to be useful is more likely to overstate readiness than to
 * understate it, so the asymmetry is deliberate.
 */
export function reconcileVerdict(assessment: Assessment): Verdict {
  const stated = assessment.verdict;

  // Explicit blockers mean unusable regardless of what the verdict field says.
  if (assessment.blockers.length > 0) return "unusable";

  const ratings = Object.values(assessment.criteria).map((c) => c.rating);
  const absent = ratings.filter((r) => r === "absent").length;
  const notSufficient = ratings.filter((r) => r !== "sufficient").length;

  // No evidence and no question is not a paper, whatever the verdict claims.
  const question = assessment.criteria["research_question"]?.rating;
  const evidence = assessment.criteria["evidence"]?.rating;
  if (question === "absent" && evidence === "absent") return "unusable";

  // A claim of "usable" is not credible when something is missing outright.
  if (stated === "usable" && absent > 0) return "partial";
  if (stated === "usable" && notSufficient > 0) return "partial";

  return stated;
}

/**
 * Compose the message shown when a run is blocked.
 *
 * This is the last thing the user sees, so it says what is missing and what
 * would unblock it, not just that the run stopped.
 */
export function formatBlockReport(assessment: Assessment): string {
  const lines = ["Material assessment: unusable — writing did not begin.", ""];

  if (assessment.summary) lines.push(assessment.summary, "");

  if (assessment.blockers.length) {
    lines.push("Blockers:");
    lines.push(...assessment.blockers.map((b) => `  - ${b}`));
    lines.push("");
  }

  if (assessment.missing_for_usable.length) {
    lines.push("What would make this workable:");
    lines.push(...assessment.missing_for_usable.map((m) => `  - ${m}`));
    lines.push("");
  }

  const absent = Object.entries(assessment.criteria)
    .filter(([, c]) => c.rating === "absent")
    .map(([key]) => key);
  if (absent.length) lines.push(`Missing entirely: ${absent.join(", ")}`);

  return lines.join("\n").trimEnd();
}

/** Validate a parsed object against the assessment schema. */
export function parseAssessment(raw: unknown): { ok: true; value: Assessment } | { ok: false; error: string } {
  const result = AssessmentSchema.safeParse(raw);
  if (result.success) return { ok: true, value: result.data };

  const issues = result.error.issues
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
  return { ok: false, error: issues };
}

/** Read assessment.json as raw text, for remediation messages. */
export function readRawAssessment(projectDir: string): string | null {
  const path = join(resolve(projectDir), PAPER_RUN_DIR, STATE_FILES.assessment);
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The hard stop
// ---------------------------------------------------------------------------

/**
 * Whether an `unusable` verdict stops the run.
 *
 * It always does, in either mode. This is deliberately *not* expressed through
 * the gate policy: the autonomous preset marks every gate `auto`, so a run
 * that relied on the gate to catch this would sail straight into drafting with
 * nothing to write from. Autonomy means nobody is asked to approve each step —
 * it does not mean the run may invent the paper.
 *
 * Kept as a named predicate so the rule has one home and the controller cannot
 * accidentally make it conditional.
 */
export function mustStopBeforeDrafting(verdict: Verdict | undefined): boolean {
  return verdict === "unusable";
}

/**
 * Stages that must not run once materials are judged unusable.
 *
 * Everything from evidence inventory onward produces manuscript substance, so
 * the block covers the rest of the pipeline rather than drafting alone.
 */
export function isBlockedByUnusableMaterials(
  stageId: string,
  verdict: Verdict | undefined,
): boolean {
  if (!mustStopBeforeDrafting(verdict)) return false;
  // The assessment itself and the bootstrap before it are still allowed —
  // re-running the assessment is how a user recovers after adding materials.
  return stageId !== "bootstrap" && stageId !== "material_assessment";
}
