/**
 * Rendering a stage into the prompt the agent actually receives.
 *
 * The prompt's job is orientation, not instruction. It says which stage this
 * is, what came before, which harness skill owns the work, and what must be
 * true when the turn ends. The skill supplies the method — duplicating it here
 * would create a second, competing account of how to write a paper, which is
 * exactly the boundary violation the harness warns against.
 *
 * One rule is repeated in every prompt despite that: never fabricate. It is
 * the single failure mode where a plausible-looking result is worse than no
 * result, so it is worth the redundancy.
 */

import type { Stage } from "./stages.js";
import { stageNumber, TOTAL_STAGES } from "./stages.js";
import type { StageRecord } from "../state/schema.js";
import type { Mode } from "../utils/constants.js";

export interface PromptContext {
  mode: Mode;
  /** Completed stages, most recent last. */
  history: StageRecord[];
  /** Material verdict, once assessed — it changes how the agent must write. */
  materialVerdict?: "usable" | "partial" | "unusable";
  /** Findings from a prior attempt, when this is a remediation turn. */
  validationFailures?: string[];
  /** Free-text guidance the human gave at a gate. */
  humanGuidance?: string;
}

/** Render the prompt for a stage's first attempt. */
export function renderStagePrompt(stage: Stage, ctx: PromptContext): string {
  const sections: string[] = [];

  sections.push(
    `# Stage ${stageNumber(stage.id)}/${TOTAL_STAGES}: ${stage.name}`,
    "",
    stage.objective,
  );

  const priorWork = describeHistory(ctx.history);
  if (priorWork) sections.push("", "## Where the run stands", "", priorWork);

  if (ctx.materialVerdict) {
    const note = materialNote(ctx.materialVerdict);
    if (note) sections.push("", "## Material constraints", "", note);
  }

  if (stage.harnessSkill) {
    const lines = [
      `Read \`${stage.harnessSkill}\` and follow it. It owns this task.`,
    ];
    if (stage.sidecarSkills?.length) {
      lines.push(
        "",
        "You may load these as sidecars alongside the owner skill, never instead of it:",
        ...stage.sidecarSkills.map((s) => `  - \`${s}\``),
      );
    }
    sections.push("", "## Method", "", ...lines);
  } else {
    sections.push(
      "",
      "## Method",
      "",
      "This stage has no harness skill — it belongs to paper-run. Follow the instructions here.",
    );
  }

  sections.push(
    "",
    "## Expected outputs",
    "",
    ...stage.expectedOutputs.map((o) => `- ${o}`),
  );

  if (ctx.humanGuidance) {
    sections.push(
      "",
      "## Guidance from the human",
      "",
      ctx.humanGuidance,
      "",
      "Treat this as the priority for this turn.",
    );
  }

  sections.push("", "## Ground rules", "", ...groundRules(ctx.mode));

  return sections.join("\n");
}

/**
 * Render the prompt for a retry after validation failed.
 *
 * Deliberately concrete: it names the checks that failed rather than asking
 * the agent to go looking, because a vague "it didn't work" turn tends to
 * produce a vague fix.
 */
export function renderRemediationPrompt(stage: Stage, ctx: PromptContext): string {
  const failures = ctx.validationFailures ?? [];

  return [
    `# Stage ${stageNumber(stage.id)}/${TOTAL_STAGES}: ${stage.name} — validation failed`,
    "",
    "The following checks did not pass:",
    "",
    ...failures.map((f) => `- ${f}`),
    "",
    "Fix these specifically. Do not start unrelated work.",
    "",
    "If a check cannot be satisfied honestly — for example it wants evidence that does",
    "not exist — say so plainly instead of writing something that would make the check",
    "pass. A failing check is recoverable; a fabricated result is not.",
  ].join("\n");
}

/** Render the prompt asking the agent to summarize a finished stage. */
export function renderSummaryRequest(stage: Stage): string {
  return [
    `Summarize what you just did in stage "${stage.name}" in 2-3 sentences.`,
    "State what changed, and name anything you left unresolved or marked TODO.",
    "Do not do further work in this turn.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Fragments
// ---------------------------------------------------------------------------

function describeHistory(history: StageRecord[]): string {
  if (history.length === 0) return "";

  const recent = history.slice(-4);
  const lines = recent.map((record) => {
    const verdict = record.material_verdict ? ` (materials: ${record.material_verdict})` : "";
    return `- ${record.stage_id}: ${record.status}${verdict}`;
  });

  const omitted = history.length - recent.length;
  if (omitted > 0) lines.unshift(`- …${omitted} earlier stage(s) completed`);

  return ["Completed so far:", ...lines].join("\n");
}

function materialNote(verdict: "usable" | "partial" | "unusable"): string {
  switch (verdict) {
    case "partial":
      return [
        "The material assessment returned **partial**. Some claims cannot be supported by",
        "what is available. Write what the evidence supports, and carry everything else as",
        "an explicit `% TODO(paper-run):` marker. Do not paper over a gap with hedged",
        "language that reads as though the evidence exists.",
      ].join("\n");
    case "unusable":
      return [
        "The material assessment returned **unusable**. Manuscript work must not proceed.",
        "If you have been asked to draft, stop and report the block instead.",
      ].join("\n");
    case "usable":
      return "";
  }
}

function groundRules(mode: Mode): string[] {
  const rules = [
    "- Read `.paper-run/run.json` if you need to know where the pipeline stands.",
    "- Honour the collaboration cues in the contracts: `locked` items are proposed, never",
    "  silently changed; `bounded` items move only inside their stated boundary.",
    "- Never invent facts, numbers, results, or citations. If something is missing, mark it",
    "  `% TODO(paper-run):` or record it as unresolved. An honest gap is a usable draft;",
    "  a fabricated one is not.",
    "- Validation runs after this turn. Leave the repository in a state where the harness",
    "  checks can pass, or where their failure is genuinely informative.",
  ];

  if (mode === "collaborative") {
    rules.push(
      "- This run is collaborative: the human is reviewing at gates. When a decision is",
      "  genuinely theirs to make, surface it rather than choosing for them.",
    );
  } else {
    rules.push(
      "- This run is autonomous: no one is approving each step. That is not licence to",
      "  guess — it means unresolved items must be recorded rather than resolved by",
      "  invention.",
    );
  }

  return rules;
}
