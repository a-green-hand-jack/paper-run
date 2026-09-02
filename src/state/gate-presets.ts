/**
 * Gate policy presets for autonomous and collaborative modes.
 */

import type { GatePolicy } from "./schema.js";
import type { Mode } from "../utils/constants.js";

/**
 * The 13 pipeline stages, in order.
 * This is the canonical ordering used everywhere.
 */
export const PIPELINE_STAGES = [
  "bootstrap",
  "material_assessment",
  "evidence_inventory",
  "paper_positioning",
  "claim_evidence",
  "story_outline",
  "canonical_drafting",
  "citation_integration",
  "self_review",
  "independent_review",
  "revision",
  "publication_build",
  "paper_candidate",
] as const;

export type StageId = (typeof PIPELINE_STAGES)[number];

/**
 * Stage ids this pipeline no longer runs.
 *
 * Stage ids are part of the on-disk contract: `git.ts` puts one in every
 * checkpoint commit's `Paper-Run-Stage` trailer, and `stage-history.json`
 * records one per completed stage. Dropping an id from `PIPELINE_STAGES`
 * without remembering it would make the entire checkpoint history of an
 * in-flight run unparseable — before any state file is even read.
 *
 * So retired ids stay readable forever. What they do not get is execution: a
 * run whose next stage is retired stops with an explanation instead of being
 * silently reinterpreted.
 */
export const RETIRED_STAGE_IDS = [
  "evidence_inventory",
  "paper_positioning",
  "claim_evidence",
  "story_outline",
  "canonical_drafting",
  "citation_integration",
] as const;

export type RetiredStageId = (typeof RETIRED_STAGE_IDS)[number];

/** Every stage id that may legitimately appear in a repository's history. */
export const KNOWN_STAGE_IDS: readonly string[] = [
  ...PIPELINE_STAGES,
  ...RETIRED_STAGE_IDS,
];

/**
 * True when `id` is a stage this version records but will not run.
 *
 * Membership in `RETIRED_STAGE_IDS` is not enough: an id may be listed there
 * and still be live during a staged rollout. Retirement is the conjunction —
 * historically known, currently absent — so this predicate stays correct
 * whichever order the two lists are edited in.
 */
export function isRetiredStage(id: string): boolean {
  return (
    (RETIRED_STAGE_IDS as readonly string[]).includes(id) &&
    !(PIPELINE_STAGES as readonly string[]).includes(id)
  );
}

/**
 * Stages where collaborative mode defaults to `await_human`.
 * These represent key decision points the human should weigh in on.
 */
const COLLABORATIVE_GATES: ReadonlySet<string> = new Set([
  "material_assessment",
  "paper_positioning",
  "story_outline",
  "canonical_drafting",
  "independent_review",
  "paper_candidate",
]);

/**
 * Generate a gate policy preset for the given mode.
 *
 * - autonomous: all gates are "auto"
 * - collaborative: key decision-point gates are "await_human", others "auto"
 */
export function generateGatePreset(mode: Mode): GatePolicy {
  const gates: GatePolicy["gates"] = {};

  for (const stage of PIPELINE_STAGES) {
    if (mode === "collaborative" && COLLABORATIVE_GATES.has(stage)) {
      gates[stage] = { policy: "await_human" };
    } else {
      gates[stage] = { policy: "auto" };
    }
  }

  return {
    schema_version: "paper-run-gate-policy-v1",
    mode,
    gates,
  };
}

/**
 * Update a gate policy's mode and regenerate defaults, but preserve
 * user-customized gate overrides (any gate whose current policy differs
 * from the OLD mode's default).
 */
export function switchGatePreset(current: GatePolicy, newMode: Mode): GatePolicy {
  const oldDefaults = generateGatePreset(current.mode);
  const newDefaults = generateGatePreset(newMode);

  const gates: GatePolicy["gates"] = {};

  for (const stage of PIPELINE_STAGES) {
    const currentPolicy = current.gates[stage]?.policy;
    const oldDefault = oldDefaults.gates[stage]?.policy;

    if (currentPolicy !== undefined && currentPolicy !== oldDefault) {
      // User override — preserve it.
      gates[stage] = { policy: currentPolicy };
    } else {
      // Use new mode's default.
      gates[stage] = newDefaults.gates[stage] ?? { policy: "auto" };
    }
  }

  return {
    schema_version: "paper-run-gate-policy-v1",
    mode: newMode,
    gates,
  };
}
