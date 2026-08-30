/**
 * The 13 pipeline stages, declared rather than coded.
 *
 * Each stage says what the agent should do, which harness skill owns the work,
 * and how the controller decides the work actually happened. Keeping this
 * declarative is what lets the controller stay a single loop: it never knows
 * what "drafting" means, only how to run a stage, validate it, and gate it.
 *
 * ## The division of labour with the harness
 *
 * The harness owns *how to write a paper*: the skills, the contracts, the
 * validators. paper-run owns *how to run a job to completion*: sequencing,
 * validation, checkpoints, gates.
 *
 * So a stage prompt never re-explains the writing craft. It orients the agent
 * (which stage, what came before), points at the owner skill from
 * `AGENTS.md`'s routing table, and states what must be true when the turn
 * ends. The skill supplies the method.
 *
 * Skill paths and check-script names here were taken from
 * agent-writing-harness v0.3.0 and are verified by
 * `tests/unit/stages.test.ts` when a harness checkout is available.
 *
 * ## Validation is not a completion message
 *
 * `validators` are the whole point. The controller never accepts "done" from
 * the model; it runs these afterwards. A stage with no meaningful validator is
 * a stage that can silently produce nothing.
 */

import type { StageId } from "../state/gate-presets.js";
import { PIPELINE_STAGES } from "../state/gate-presets.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One check the controller runs after a stage's turn ends. */
export type Validator =
  /** Run a harness check script; passes on exit code 0. */
  | { type: "check_script"; script: string; args?: string[]; required: boolean; message: string }
  /** A file must exist (and, optionally, be non-trivial). */
  | { type: "file_exists"; path: string; minBytes?: number; required: boolean; message: string }
  /** A contract must contain a heading, and that section must be non-empty. */
  | {
      type: "contract_section";
      contract: string;
      heading: string;
      required: boolean;
      message: string;
    }
  /** At least one file matching a glob-ish prefix must exist under a directory. */
  | {
      type: "dir_has_content";
      dir: string;
      extension?: string;
      minBytes?: number;
      required: boolean;
      message: string;
    }
  /** A JSON state file paper-run itself owns must be present and parseable. */
  | { type: "state_file"; file: string; required: boolean; message: string }
  /** Validate fresh artifacts declared by .agents/paper-build.json or the safe fallback. */
  | { type: "publication_build"; required: boolean; message: string };

export interface Stage {
  id: StageId;
  /** Human-readable name, used in commit subjects and toasts. */
  name: string;
  /** One line describing the stage's job, shown to the agent. */
  objective: string;
  /**
   * Owner skill from the harness routing table, or null when the stage is
   * paper-run's own (bootstrap, material assessment).
   */
  harnessSkill: string | null;
  /** Sidecar skills the agent may load alongside the owner. Never a substitute. */
  sidecarSkills?: string[];
  /** What the agent is expected to produce. Rendered into the prompt verbatim. */
  expectedOutputs: string[];
  /** How the controller verifies the stage really happened. */
  validators: Validator[];
  /** Per-stage time budget for the agent turn. */
  timeoutMs: number;
  /** How many remediation attempts before the stage is declared blocked. */
  retries: number;
}

const MINUTES = 60_000;

// ---------------------------------------------------------------------------
// Stage definitions
// ---------------------------------------------------------------------------

export const STAGES: Record<StageId, Stage> = {
  bootstrap: {
    id: "bootstrap",
    name: "Bootstrap",
    objective:
      "Confirm the writing repository is correctly initialized and the brief has been ingested.",
    // paper-run's own concern: the repo already exists by the time a run starts.
    harnessSkill: ".agents/skills/paper-orientation/SKILL.md",
    expectedOutputs: [
      "Confirmation that AGENTS.md, PAPER.md, and BRIEF.md are present and readable",
      "A short orientation summary of what this paper is about, based only on the brief",
    ],
    validators: [
      {
        type: "file_exists",
        path: "BRIEF.md",
        minBytes: 32,
        required: true,
        message: "BRIEF.md is missing or empty — the brief was not ingested",
      },
      {
        type: "check_script",
        script: "check-structure.py",
        required: true,
        message: "Repository structure does not match the harness template",
      },
    ],
    timeoutMs: 5 * MINUTES,
    retries: 1,
  },

  material_assessment: {
    id: "material_assessment",
    name: "Material assessment",
    objective:
      "Judge whether the supplied materials can support a paper, and say so honestly.",
    // Deliberately paper-run's own: the harness has no sufficiency-assessment
    // skill, and this gate is what stops a run from fabricating a paper.
    harnessSkill: null,
    expectedOutputs: [
      ".paper-run/assessment.json with a usable / partial / unusable verdict",
      "For a partial verdict: exactly what is missing and which sections can still be written",
      "For an unusable verdict: why writing cannot responsibly begin",
    ],
    validators: [
      {
        type: "state_file",
        file: "assessment.json",
        required: true,
        message: "No .paper-run/assessment.json was written",
      },
    ],
    timeoutMs: 10 * MINUTES,
    retries: 2,
  },

  evidence_inventory: {
    id: "evidence_inventory",
    name: "Evidence inventory",
    objective:
      "Record what evidence exists, what each experiment shows, and where the gaps are.",
    harnessSkill: ".agents/skills/paper-brief-ingest/SKILL.md",
    sidecarSkills: [".agents/skills/ccf-experiment-designer/SKILL.md"],
    expectedOutputs: [
      "EXPERIMENTS.md ## Experiment overview populated from the available materials",
      "Unavailable or incomplete results marked unresolved rather than guessed",
    ],
    validators: [
      {
        type: "contract_section",
        contract: "EXPERIMENTS.md",
        heading: "## Experiment overview",
        required: true,
        message: "EXPERIMENTS.md ## Experiment overview is missing or empty",
      },
      {
        type: "check_script",
        script: "check-paper-contracts.py",
        required: true,
        message: "Paper contracts failed structural validation",
      },
    ],
    timeoutMs: 15 * MINUTES,
    retries: 2,
  },

  paper_positioning: {
    id: "paper_positioning",
    name: "Paper positioning",
    objective:
      "Fix what this paper claims, for whom, and how it differs from what exists.",
    harnessSkill: ".agents/skills/style-alignment/SKILL.md",
    expectedOutputs: [
      "PAPER.md ## Paper identity",
      "PAPER.md ## What readers should believe, including central thesis and contributions",
      "Anything genuinely undecided left under ## Unresolved rather than invented",
    ],
    validators: [
      {
        type: "contract_section",
        contract: "PAPER.md",
        heading: "## Paper identity",
        required: true,
        message: "PAPER.md ## Paper identity is missing or empty",
      },
      {
        type: "contract_section",
        contract: "PAPER.md",
        heading: "## What readers should believe",
        required: true,
        message: "PAPER.md ## What readers should believe is missing or empty",
      },
      {
        type: "check_script",
        script: "check-paper-contracts.py",
        required: true,
        message: "Paper contracts failed structural validation",
      },
    ],
    timeoutMs: 15 * MINUTES,
    retries: 2,
  },

  claim_evidence: {
    id: "claim_evidence",
    name: "Claim-evidence organization",
    objective: "Bind every claim the paper will make to the evidence that supports it.",
    harnessSkill: ".agents/skills/citation-support-review/SKILL.md",
    sidecarSkills: [".agents/skills/ccf-integrity-auditor/SKILL.md"],
    expectedOutputs: [
      "Each contribution in PAPER.md traced to specific evidence under EXPERIMENTS.md ## Claim-evidence bindings",
      "Claim-evidence qualification stays in EXPERIMENTS.md; cross-cutting gaps may go under PAPER.md ## Unresolved",
      "Do not edit the locked PAPER.md ### Central thesis or ### Contributions sections",
      "Claims without support marked unresolved — never softened into sounding supported",
    ],
    validators: [
      {
        type: "contract_section",
        contract: "EXPERIMENTS.md",
        heading: "## Claim-evidence bindings",
        required: true,
        message:
          "EXPERIMENTS.md ## Claim-evidence bindings is missing or empty — record bindings there without editing locked PAPER.md sections",
      },
      {
        type: "check_script",
        script: "check-paper-contracts.py",
        required: true,
        message: "Paper contracts failed structural validation",
      },
    ],
    timeoutMs: 15 * MINUTES,
    retries: 2,
  },

  story_outline: {
    id: "story_outline",
    name: "Story and outline",
    objective: "Decide the narrative arc and what each section is responsible for.",
    harnessSkill: ".agents/skills/style-alignment/SKILL.md",
    expectedOutputs: [
      "PAPER.md ## Story and structure, including the narrative arc",
      "Section responsibilities table: what each section must accomplish for the reader",
    ],
    validators: [
      {
        type: "contract_section",
        contract: "PAPER.md",
        heading: "## Story and structure",
        required: true,
        message: "PAPER.md ## Story and structure is missing or empty",
      },
      {
        type: "check_script",
        script: "check-paper-contracts.py",
        required: true,
        message: "Paper contracts failed structural validation",
      },
    ],
    timeoutMs: 15 * MINUTES,
    retries: 2,
  },

  canonical_drafting: {
    id: "canonical_drafting",
    name: "Canonical drafting",
    objective: "Write the manuscript sections in paper/sections/.",
    harnessSkill: ".agents/skills/section-writing/SKILL.md",
    sidecarSkills: [
      ".agents/skills/ccf-paper-writer/SKILL.md",
      ".agents/skills/lieflat-less-ai-tone/SKILL.md",
    ],
    expectedOutputs: [
      "Draft prose in paper/sections/*.tex following the agreed outline",
      "Every unsupported statement carried as an explicit % TODO(paper-run): marker",
      "No invented numbers, results, or citations under any circumstance",
    ],
    validators: [
      {
        type: "dir_has_content",
        dir: "paper/sections",
        extension: ".tex",
        minBytes: 200,
        required: true,
        message: "No substantive content was written to paper/sections/",
      },
      {
        type: "check_script",
        script: "check-paper-interfaces.py",
        required: true,
        message: "Paper interface macros are missing or inconsistent",
      },
    ],
    // Drafting is the longest turn in the pipeline by a wide margin.
    timeoutMs: 45 * MINUTES,
    retries: 2,
  },

  citation_integration: {
    id: "citation_integration",
    name: "Citation, figure and table integration",
    objective: "Wire references, figures and tables into the draft and make them check out.",
    harnessSkill: ".agents/skills/reference-repair/SKILL.md",
    sidecarSkills: [
      ".agents/skills/citation-support-review/SKILL.md",
      ".agents/skills/ccf-visual-composer/SKILL.md",
    ],
    expectedOutputs: [
      "Citations resolved in paper/refs.bib with the reference ledger updated",
      "Figures and tables referenced from the text actually present",
      "Any citation that cannot be verified recorded as unresolved, not invented",
    ],
    validators: [
      {
        type: "check_script",
        script: "check-reference-integrity.py",
        required: true,
        message: "Reference integrity check failed",
      },
      {
        type: "check_script",
        script: "check-bibtex-format.py",
        required: false,
        message: "BibTeX formatting issues remain",
      },
    ],
    timeoutMs: 20 * MINUTES,
    retries: 2,
  },

  self_review: {
    id: "self_review",
    name: "Self review",
    objective: "Re-read the draft as a whole and fix what is internally inconsistent.",
    // section-writing forbids review passes during drafting, so this is a
    // separate turn on purpose.
    harnessSkill: ".agents/skills/section-writing/SKILL.md",
    sidecarSkills: [".agents/skills/ccf-humanization/SKILL.md"],
    expectedOutputs: [
      "Internal inconsistencies between sections resolved",
      "Terminology and notation unified against PAPER_INTERFACES.md",
      "Remaining TODO markers still visible, not quietly deleted",
    ],
    validators: [
      {
        type: "check_script",
        script: "check-paper-interfaces.py",
        required: true,
        message: "Paper interface macros are missing or inconsistent",
      },
      {
        type: "check_script",
        script: "check-reference-integrity.py",
        args: ["--profile", "draft"],
        required: true,
        message: "Draft reference and claim-evidence integrity check failed",
      },
    ],
    timeoutMs: 20 * MINUTES,
    retries: 1,
  },

  independent_review: {
    id: "independent_review",
    name: "Independent consistency review",
    objective:
      "Review the manuscript cold, as a reader who did not write it, and report findings.",
    harnessSkill: ".agents/skills/manuscript-consistency-review/SKILL.md",
    sidecarSkills: [
      ".agents/skills/ccf-paper-reviewer/SKILL.md",
      ".agents/skills/ccf-integrity-auditor/SKILL.md",
    ],
    expectedOutputs: [
      ".paper-run/review-findings.md with blocker, major, and minor findings sections",
      "Unsupported claims and fabrication risks called out explicitly",
      "Findings only — this stage reports, it does not fix",
    ],
    validators: [
      {
        type: "file_exists",
        path: ".paper-run/review-findings.md",
        minBytes: 200,
        required: true,
        message: "Independent review did not produce .paper-run/review-findings.md",
      },
      ...["Blocker", "Major", "Minor"].map((severity) => ({
        type: "contract_section" as const,
        contract: ".paper-run/review-findings.md",
        heading: `## ${severity} findings`,
        required: true,
        message: `Independent review report has no substantive ## ${severity} findings section (write \"None.\" when there are no findings)`,
      })),
      {
        type: "check_script",
        script: "check-paper-contracts.py",
        required: true,
        message: "Paper contracts failed structural validation",
      },
    ],
    timeoutMs: 25 * MINUTES,
    retries: 1,
  },

  revision: {
    id: "revision",
    name: "Revision",
    objective: "Address the review findings.",
    harnessSkill: ".agents/skills/section-writing/SKILL.md",
    sidecarSkills: [".agents/skills/control-review/SKILL.md"],
    expectedOutputs: [
      "Every blocker and major finding either fixed or explicitly deferred with a reason",
      "Changes to locked contract items proposed rather than made",
    ],
    validators: [
      {
        type: "check_script",
        script: "check-paper-contracts.py",
        required: true,
        message: "Paper contracts failed structural validation",
      },
      {
        type: "check_script",
        script: "check-reference-integrity.py",
        required: true,
        message: "Reference integrity check failed",
      },
    ],
    timeoutMs: 30 * MINUTES,
    retries: 2,
  },

  publication_build: {
    id: "publication_build",
    name: "Publication variant build",
    objective: "Build the publication variants and make them compile.",
    harnessSkill: ".agents/skills/publication-planning/SKILL.md",
    sidecarSkills: [".agents/skills/ccf-submission-checker/SKILL.md"],
    expectedOutputs: [
      "PUBLICATION.md ## Active variants reflecting what was built",
      "make pdf succeeding for the configured variants",
    ],
    validators: [
      {
        type: "check_script",
        script: "check-publication.py",
        required: true,
        message: "Publication contract failed validation",
      },
      {
        type: "check_script",
        script: "check-paper-profile.py",
        required: true,
        message: "Build profile (.agents/paper-build.json) is invalid",
      },
      {
        type: "publication_build",
        required: true,
        message: "Publication build command failed or did not produce its configured output",
      },
    ],
    timeoutMs: 20 * MINUTES,
    retries: 2,
  },

  paper_candidate: {
    id: "paper_candidate",
    name: "Paper candidate",
    objective: "Assemble the candidate and state plainly what a human still must decide.",
    harnessSkill: ".agents/skills/release-review/SKILL.md",
    expectedOutputs: [
      "A release record describing the candidate",
      "An explicit list of every remaining TODO, unresolved item, and human decision required",
      "No claim that the paper is ready for submission — that judgement is the human's",
    ],
    validators: [
      {
        type: "check_script",
        script: "check-release.py",
        required: false,
        message: "Release validation reported issues",
      },
      {
        type: "check_script",
        script: "check-paper-contracts.py",
        required: true,
        message: "Paper contracts failed structural validation",
      },
    ],
    timeoutMs: 20 * MINUTES,
    retries: 1,
  },
};

// ---------------------------------------------------------------------------
// Sequencing
// ---------------------------------------------------------------------------

/** Look up a stage by id. Throws for an unknown id rather than returning undefined. */
export function getStage(id: string): Stage {
  const stage = STAGES[id as StageId];
  if (!stage) {
    throw new Error(
      `Unknown pipeline stage "${id}". Known stages: ${PIPELINE_STAGES.join(", ")}`,
    );
  }
  return stage;
}

/** The stage after `id`, or null at the end of the pipeline. */
export function getNextStage(id: string): Stage | null {
  const index = PIPELINE_STAGES.indexOf(id as StageId);
  if (index === -1) throw new Error(`Unknown pipeline stage "${id}"`);
  const next = PIPELINE_STAGES[index + 1];
  return next ? STAGES[next] : null;
}

/**
 * Stages still to run, starting at `currentStage`.
 *
 * When the current stage is already completed, the list starts at the one
 * after it; otherwise the current stage is re-run. That asymmetry is what
 * makes resume safe: an interrupted stage has no checkpoint, so redoing it
 * costs a turn rather than losing work.
 */
export function remainingStages(currentStage: string, currentCompleted: boolean): Stage[] {
  const index = PIPELINE_STAGES.indexOf(currentStage as StageId);
  if (index === -1) throw new Error(`Unknown pipeline stage "${currentStage}"`);
  const start = currentCompleted ? index + 1 : index;
  return PIPELINE_STAGES.slice(start).map((id) => STAGES[id]);
}

/** Position of a stage in the pipeline, 1-based, for progress display. */
export function stageNumber(id: string): number {
  const index = PIPELINE_STAGES.indexOf(id as StageId);
  if (index === -1) throw new Error(`Unknown pipeline stage "${id}"`);
  return index + 1;
}

export const TOTAL_STAGES = PIPELINE_STAGES.length;
