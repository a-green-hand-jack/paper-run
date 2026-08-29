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
