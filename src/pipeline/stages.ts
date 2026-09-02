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
  | { type: "publication_build"; required: boolean; message: string }
  /** Mechanical prose tells across the drafted manuscript. Advisory by design. */
  | { type: "prose_quality"; dir?: string; required: boolean; message: string }
  /** PAPER.md's section responsibilities table yields a usable manuscript outline. */
  | { type: "section_plan"; required: boolean; message: string }
  /**
   * The manuscript cites the literature it was given.
   *
   * The floor is derived from the bibliography's own size, so a repository
   * without one is unaffected. `minFiles` additionally requires the citations
   * to be spread across sections rather than piled into one.
   */
  | { type: "citation_floor"; minFiles?: number; required: boolean; message: string }
  /** Supplied figure assets are placed in the manuscript, or explained. */
  | { type: "figure_coverage"; required: boolean; message: string }
  /**
   * No section the manuscript inputs is a placeholder.
   *
   * The independent review found a `\input{sections/10_appendix}` over a file
   * whose only body was the word TODO. That is worth catching, and it is not
   * worth a review half to catch: a placeholder is mechanically recognisable,
   * so the check belongs where the writing happens.
   *
   * Body sections must say something. The appendix anchor, which
   * `check-structure.py` forces `main.tex` to input whether or not the paper
   * has an appendix, only has to avoid printing TODO into the PDF.
   */
  | { type: "section_substance"; required: boolean; message: string }
  /**
   * The plan enumerated the experimental apparatus it read out of the materials.
   *
   * `minEntities` is the floor on how many models, datasets, benchmarks,
   * metrics, tools, and calibration sets the inventory names. The check is
   * silent for a project with no supplied materials to enumerate.
   */
  | { type: "setup_inventory"; minEntities?: number; required: boolean; message: string }
  /**
   * Every apparatus entity with a bibliography key is cited, or excused.
   *
   * The floor `citation_floor` puts under the count; this puts one under the
   * coverage. pwb-0011 cleared a count floor of eleven with twenty-two keys
   * and still cited three works in Experiments, because nothing asked whether
   * the paper cited the benchmarks it ran on.
   */
  | { type: "apparatus_cited"; required: boolean; message: string }
  /** The manuscript is within reach of the venue's page budget. */
  | { type: "manuscript_length"; required: boolean; message: string }
  /**
   * The canonical manuscript compiles, and its real page count is recorded.
   *
   * Nothing built the document before `publication_build`, the last stage, so
   * everything upstream reasoned about length through a words-per-page
   * constant and learned about a broken document at the very end. A build
   * costs seconds and no tokens; run it where the writing happens. Order
   * matters — place this before `manuscript_length`, which prefers a measured
   * page count over its estimate.
   */
  | { type: "manuscript_compiles"; timeoutMs?: number; required: boolean; message: string }
  /** Supplied inputs are byte-identical to what the run started with. */
  | { type: "inputs_unmodified"; required: boolean; message: string }
  /** The reviewer left machine-readable findings, not only a prose report. */
  | { type: "review_findings"; required: boolean; message: string }
  /**
   * Findings at these severities were each fixed or explicitly deferred.
   *
   * `maxDeferred` caps how many may be deferred per severity. A documented
   * deferral is a legitimate outcome for a finding the evidence cannot settle,
   * but on pwb-0011 it was also a free exit: two blockers and the finding that
   * the paper cited nothing were all deferred, and the stage passed. A severity
   * capped at zero cannot be deferred at all.
   */
  | {
      type: "findings_addressed";
      severities: readonly string[];
      maxDeferred?: Readonly<Record<string, number>>;
      required: boolean;
      message: string;
    }
  /** The findings file still says what the reviewer said. */
  | { type: "findings_integrity"; required: boolean; message: string };

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
  /**
   * Files the prompt names outright, as required reading.
   *
   * The harness keeps its writing craft several hops away from any one skill:
   * `section-writing` mentions `scientific-writing.md`, routes substantial
   * drafting to the `ccf-paper-writer` wrapper, which routes on to a vendored
   * skill, which holds the references that actually describe how to write a
   * section. Every hop is phrased as a permission ("load as a sidecar when…"),
   * and the vendored skill adds an explicit rule against loading its
   * references "merely because they exist".
   *
   * A stage prompt that says only "read the owner skill" therefore leaves the
   * deepest material unreached. Naming the files here is the signal the
   * vendored rule asks for — this task does need them — and turns an optional
   * chain into a stated expectation.
   */
  requiredReading?: string[];
  /**
   * Drive this stage one manuscript section per turn.
   *
   * `section-writing` is written for a single active section: it asks for the
   * section and its immediate neighbours, and says not to load the whole
   * manuscript. Running it once for an entire paper makes that discipline
   * impossible to follow, so the model skims the skill and drafts everything
   * in one pass — the shape that produces uniform, flat prose.
   */
  perSection?: boolean;
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

  paper_plan: {
    id: "paper_plan",
    name: "Paper plan",
    objective:
      "Decide what the paper claims, how the argument is staged, and what each section must accomplish.",
    harnessSkill: ".agents/skills/style-alignment/SKILL.md",
    // One turn, not three. Positioning, contribution framing, and the
    // narrative arc are the same decision seen from different angles, and
    // splitting them meant re-reading every contract three times to write
    // three sections of one document.
    requiredReading: [
      ".agents/vendor/ccfa-skills/ccf-paper-writer/references/storyline-blueprint.md",
      ".agents/vendor/ccfa-skills/ccf-paper-writer/references/ccf-a-venue-map.md",
      ".agents/knowledge/venues/README.md",
    ],
    expectedOutputs: [
      "PAPER.md ## Paper identity",
      "PAPER.md ## What readers should believe, including central thesis and contributions",
      "PAPER.md ## Story and structure: the narrative arc, plus a "
        + "### Section responsibilities row for every section this paper will actually have",
      "The section responsibilities table is the manuscript's outline — drafting builds "
        + "exactly the sections it lists, so include one the venue needs even when the "
        + "template ships no file for it, and leave out template sections this paper does not want",
      "EXPERIMENTS.md ## Experimental setup inventory: a Markdown table with columns "
        + "Entity | Kind | Evidence | Bib key, enumerating every model, dataset, benchmark, "
        + "metric, tool, framework, and calibration set the supplied code, configs, and scripts "
        + "actually name — read them, do not infer from the result tables, whose column headers "
        + "aggregate what the code names individually",
      "Each inventory row cites the material file it was read from, and carries the "
        + "bibliography key for that work when the supplied bibliography has one; leave the key "
        + "column empty rather than guessing",
      "A venue knowledge file under .agents/knowledge/venues/ for the target venue, "
        + "filled from the brief and materials with every unverified field marked UNVERIFIED",
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
        type: "contract_section",
        contract: "PAPER.md",
        heading: "## Story and structure",
        required: true,
        message:
          "PAPER.md ## Story and structure is missing or empty — drafting reads its "
          + "### Section responsibilities table to decide which sections to write",
      },
      // Drafting reads this table to decide which sections exist. A table that
      // does not parse would silently degrade the next stage to a single
      // whole-manuscript turn, which is the failure this pipeline was
      // restructured to remove.
      {
        type: "section_plan",
        required: true,
        message: "PAPER.md ### Section responsibilities does not yield a usable outline",
      },
      // The apparatus channel. A results table bounds what the paper may
      // claim; it does not bound what the paper must describe. On pwb-0011
      // the supplied table's header read "Benchmark Average" and the
      // manuscript wrote "benchmark-average accuracy" -- while the five
      // benchmark names, the eval harness, and the serving engine sat in the
      // supplied code, which the run read and never wrote from.
      {
        type: "setup_inventory",
        minEntities: 3,
        required: true,
        message: "The experimental setup inventory is missing or unusable",
      },
      {
        type: "check_script",
        script: "check-paper-contracts.py",
        required: true,
        message: "Paper contracts failed structural validation",
      },
      // Advisory: a brief that names no venue should still be able to position
      // the paper.
      {
        type: "check_script",
        script: "check-venue-knowledge.py",
        required: false,
        message: "Venue knowledge is missing or incomplete",
      },
    ],
    timeoutMs: 12 * MINUTES,
    retries: 2,
  },

  full_draft: {
    id: "full_draft",
    name: "Full draft",
    objective:
      "Write the complete manuscript — every section the plan calls for, with the citations and figures the materials supply.",
    harnessSkill: ".agents/skills/section-writing/SKILL.md",
    // ccf-humanization is the writing engine's own "first manuscript-facing
    // preflight"; lieflat-less-ai-tone is a final pass and belongs later.
    sidecarSkills: [
      ".agents/skills/ccf-paper-writer/SKILL.md",
      ".agents/skills/ccf-humanization/SKILL.md",
    ],
    requiredReading: [
      ".agents/knowledge/scientific-writing.md",
      ".agents/vendor/ccfa-skills/ccf-paper-writer/references/section-modules.md",
      ".agents/vendor/ccfa-skills/ccf-paper-writer/references/prose-quality-guardrails.md",
      ".agents/vendor/ccfa-skills/ccf-paper-writer/references/length-budget-policy.md",
    ],
    perSection: true,
    expectedOutputs: [
      "Draft prose for every section named in PAPER.md ### Section responsibilities",
      "A complete manuscript, not a skeleton: use the venue's page budget rather than stopping early",
      "Citations placed from the bibliography the repository already contains, using keys that exist in it",
      "The experimental section names and cites every entity in EXPERIMENTS.md "
        + "## Experimental setup inventory that carries a bibliography key — the benchmarks "
        + "the models were evaluated on, the harness that ran them, the frameworks they were "
        + "served with, the corpora used for calibration",
      "Every supplied figure and table either placed in the manuscript or recorded under PAPER.md ## Unresolved with a reason",
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
      {
        type: "inputs_unmodified",
        required: true,
        message: "Supplied inputs were modified",
      },
      // A supplied figure that the paper neither places nor argues against is
      // a figure nobody decided about.
      {
        type: "figure_coverage",
        required: true,
        message: "Supplied figures are missing from the manuscript",
      },
      {
        type: "section_substance",
        required: true,
        message: "The manuscript inputs a section that says nothing",
      },
      // Before the length check, so length can be measured rather than
      // estimated -- and so a manuscript that does not compile is caught by
      // the stage that wrote it rather than eight stages later.
      {
        type: "manuscript_compiles",
        required: true,
        message: "The manuscript does not compile",
      },
      // Only checked when a human actually stated a budget; silent otherwise.
      {
        type: "manuscript_length",
        required: true,
        message: "The manuscript is far short of its stated page budget",
      },
      // Advisory until the harness can accept a citation without retrieved
      // passages. Today `check-reference-integrity.py` errors on every cited
      // key that has no ledger record, and the writer cannot create one -- so
      // requiring citations here and integrity later would deadlock the run.
      // Promoted to required with the upstream fix.
      {
        type: "citation_floor",
        minFiles: 3,
        required: false,
        message: "The manuscript cites too little of the bibliography it was given",
      },
      // Coverage, where citation_floor is count. A manuscript can clear a
      // floor of eleven with twenty-two keys piled into related work and
      // still cite three works in its experimental section, which is what
      // pwb-0011 did against a ground truth that cites twenty-one there.
      {
        type: "apparatus_cited",
        required: true,
        message: "The manuscript does not cite the apparatus it says it used",
      },
      // Advisory: mechanical tells, not a verdict on the argument.
      {
        type: "prose_quality",
        required: false,
        message: "Draft prose shows mechanical writing patterns",
      },
    ],
    // The longest stage in the pipeline. With perSection set the controller
    // divides this budget across the sections the plan named.
    timeoutMs: 50 * MINUTES,
    retries: 2,
  },

  evidence_reconciliation: {
    id: "evidence_reconciliation",
    name: "Evidence reconciliation",
    objective:
      "Bind every claim the draft makes to the evidence behind it, and record what nothing supports.",
    // Deliberately after drafting. Inventorying evidence before any prose
    // existed produced a contract nobody wrote against; doing it now means
    // every binding is checked against a sentence that is actually in the paper.
    harnessSkill: ".agents/skills/citation-support-review/SKILL.md",
    sidecarSkills: [".agents/skills/ccf-integrity-auditor/SKILL.md"],
    requiredReading: [".agents/vendor/ccfa-skills/ccf-paper-writer/references/citation-workflow.md"],
    expectedOutputs: [
      "EXPERIMENTS.md ## Experiment overview populated from the available materials",
      "EXPERIMENTS.md ## Claim-evidence bindings tracing each contribution to specific evidence",
      "Claims the materials cannot support marked unresolved — never softened into sounding supported",
      "Do not edit the locked PAPER.md ### Central thesis or ### Contributions sections",
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
      {
        type: "inputs_unmodified",
        required: true,
        message: "Supplied inputs were modified",
      },
      {
        type: "citation_floor",
        minFiles: 3,
        required: false,
        message: "The manuscript cites too little of the bibliography it was given",
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
    // The final whitelist pass belongs here, over text that is finished.
    sidecarSkills: [".agents/skills/lieflat-less-ai-tone/SKILL.md"],
    requiredReading: [".agents/vendor/ccfa-skills/ccf-paper-writer/references/prose-quality-guardrails.md"],
    // "Re-read and fix what is inconsistent" was the whole brief, and it
    // produced nothing: the independent review that followed found a
    // TODO-only appendix, a figure caption with no experimental conditions,
    // and a caption omitting a curve its own figure plots -- all of them
    // visible to anyone re-reading the draft. A review without a checklist is
    // a review of whatever caught the eye.
    expectedOutputs: [
      "Every section checked against its own row in PAPER.md ### Section responsibilities: "
        + "does it do the reader task that row assigns, and does it preserve what the row says "
        + "must be preserved",
      "Every float checked against its caption: a caption states the conditions of what it "
        + "shows — the model, the configuration, the setting — and names every series the "
        + "figure actually plots",
      "Every entity in EXPERIMENTS.md ## Experimental setup inventory that this paper used "
        + "named in the prose where it belongs, not folded into an aggregate the reader "
        + "cannot unpack",
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
      {
        type: "inputs_unmodified",
        required: true,
        message: "Supplied inputs were modified",
      },
      // A review turn must not shrink the paper below the floor it reached.
      {
        type: "manuscript_length",
        required: true,
        message: "Self review left the manuscript short of its stated page budget",
      },
      {
        type: "prose_quality",
        required: false,
        message: "Manuscript prose still shows mechanical writing patterns",
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
      ".paper-run/review-findings.json carrying the same findings as data: "
        + 'schema_version "paper-run-review-findings-v1", reviewed_at, and a findings array '
        + "where each entry has id, severity (blocker|major|minor), location, summary, and evidence",
      "Both files must describe the same findings — the JSON is the record the "
        + "revision stage is checked against, the Markdown is for the human",
      "Unsupported claims and fabrication risks called out explicitly",
      "A verdict on every section named in PAPER.md ### Section responsibilities, against "
        + "that row and against what a section of its kind must contain — a section that is "
        + "internally consistent and uniformly missing something a reader needs is the "
        + "failure a consistency review is least likely to see, so look for it deliberately",
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
        type: "review_findings",
        required: true,
        message: "Independent review did not produce valid .paper-run/review-findings.json",
      },
      {
        type: "check_script",
        script: "check-paper-contracts.py",
        required: true,
        message: "Paper contracts failed structural validation",
      },
    ],
    timeoutMs: 25 * MINUTES,
    // One extra attempt over the old budget: the stage now has to satisfy a
    // schema as well as write a report, and a malformed first attempt is a
    // cheap thing to fix.
    retries: 2,
  },

  revision: {
    id: "revision",
    name: "Revision",
    objective: "Address the review findings.",
    harnessSkill: ".agents/skills/section-writing/SKILL.md",
    sidecarSkills: [".agents/skills/control-review/SKILL.md"],
    expectedOutputs: [
      "Every blocker and major finding either fixed or explicitly deferred with a reason",
      "For each of those findings, a resolution recorded in .paper-run/review-findings.json: "
        + '{ "status": "fixed" | "deferred", "note": "what changed, or why it cannot be settled yet" }',
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
      // Before findings were structured, the only thing standing between a
      // revision turn and the next stage was that the contracts still parsed.
      // Skipping the hardest finding cost nothing.
      {
        type: "findings_addressed",
        severities: ["blocker", "major"],
        // A blocker cannot be deferred. If the evidence genuinely cannot
        // settle it, that is a run that should stop and say so, not one that
        // ships a candidate with the objection filed away.
        maxDeferred: { blocker: 0, major: 2 },
        required: true,
        message: "Review findings were left unaddressed",
      },
      // Revision needs write access to record how it disposed of each finding,
      // and that access is equally sufficient to soften a blocker into a minor
      // note. Nothing else stops it.
      {
        type: "findings_integrity",
        required: true,
        message: "The review findings were altered after the review",
      },
      {
        type: "inputs_unmodified",
        required: true,
        message: "Supplied inputs were modified",
      },
      {
        type: "figure_coverage",
        required: true,
        message: "Supplied figures are missing from the revised manuscript",
      },
      {
        type: "manuscript_compiles",
        required: true,
        message: "The manuscript does not compile",
      },
      {
        type: "manuscript_length",
        required: true,
        message: "Revision left the manuscript short of its stated page budget",
      },
      {
        type: "citation_floor",
        minFiles: 3,
        required: false,
        message: "The revised manuscript cites too little of the bibliography it was given",
      },
      // Regression guard: the review half must not be able to hand back a
      // manuscript that quietly dropped an apparatus citation.
      {
        type: "apparatus_cited",
        required: true,
        message: "The manuscript does not cite the apparatus it says it used",
      },
      {
        type: "prose_quality",
        required: false,
        message: "Revised prose still shows mechanical writing patterns",
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
    requiredReading: [
      ".agents/vendor/ccfa-skills/ccf-paper-writer/references/length-budget-policy.md",
    ],
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
      {
        type: "inputs_unmodified",
        required: true,
        message: "Supplied inputs were modified",
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

/**
 * Look up a stage without throwing.
 *
 * Reading an old run means meeting ids this version no longer runs. Callers
 * that only need to *display* or *reconcile* history use this; callers that are
 * about to execute a stage use `getStage` and want the throw.
 */
export function findStage(id: string): Stage | null {
  return STAGES[id as StageId] ?? null;
}

/**
 * Position of a stage id, or -1 when this version does not know it.
 *
 * `reconcileHistory` compares positions to decide which history records survive
 * a rewind. A retired id has no position in the current pipeline, and throwing
 * there turned `paper-run status` on an older run into a stack trace.
 */
export function stagePosition(id: string): number {
  return PIPELINE_STAGES.indexOf(id as StageId);
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
