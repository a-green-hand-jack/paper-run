import { PIPELINE_STAGES, type StageId } from "./gate-presets.js";
import type { RunPlan } from "./schema.js";
import { PaperRunError } from "../utils/errors.js";

export const PLAN_PROFILES: Readonly<Record<string, readonly StageId[]>> = {
  full: PIPELINE_STAGES,
  "existing-manuscript": [
    "bootstrap",
    "material_assessment",
    "paper_positioning",
    "claim_evidence",
    "self_review",
    "independent_review",
    "revision",
    "publication_build",
    "paper_candidate",
  ],
  "review-and-revise": [
    "bootstrap",
    "material_assessment",
    "self_review",
    "independent_review",
    "revision",
  ],
  // Compatibility alias for runs created before the profile was renamed.
  "review-only": [
    "bootstrap",
    "material_assessment",
    "self_review",
    "independent_review",
    "revision",
  ],
  "review-report": ["bootstrap", "independent_review"],
  "build-only": ["bootstrap", "publication_build"],
};

export function createRunPlan(profile = "full", stages?: string): RunPlan {
  const selected = stages === undefined
    ? PLAN_PROFILES[profile]
    : stages.split(",").map((stage) => stage.trim()).filter(Boolean);
  if (!selected) {
    throw new PaperRunError(`Unknown run profile "${profile}".`, {
      hint: `Choose one of: ${Object.keys(PLAN_PROFILES).join(", ")}.`,
    });
  }
  const normalized = [...selected] as string[];
  validateRunPlan(normalized);
  const selectedSet = new Set(normalized);
  return {
    profile: stages === undefined ? profile : "custom",
    stages: normalized,
    skipped: PIPELINE_STAGES
      .filter((stage) => !selectedSet.has(stage))
      .map((stage) => ({ stage, reason: stages === undefined ? `omitted by profile ${profile}` : "omitted by custom stage selection" })),
  };
}

export function validateRunPlan(stages: readonly string[]): void {
  if (stages.length === 0) throw new PaperRunError("Run plan must contain at least one stage.");
  const known = new Set<string>(PIPELINE_STAGES);
  const seen = new Set<string>();
  let previous = -1;
  for (const stage of stages) {
    const index = PIPELINE_STAGES.indexOf(stage as StageId);
    if (!known.has(stage)) throw new PaperRunError(`Unknown pipeline stage "${stage}".`);
    if (seen.has(stage)) throw new PaperRunError(`Run plan contains duplicate stage "${stage}".`);
    if (index <= previous) throw new PaperRunError("Run plan stages must follow pipeline order.");
    seen.add(stage);
    previous = index;
  }
  if (!seen.has("bootstrap")) {
    throw new PaperRunError("Run plans must include bootstrap.", {
      hint: "Bootstrap validates the writing repository before any other stage runs.",
    });
  }
  if (seen.has("revision") && !seen.has("independent_review")) {
    throw new PaperRunError("revision requires independent_review in the same run plan.");
  }
  if (seen.has("paper_candidate") && !seen.has("publication_build")) {
    throw new PaperRunError("paper_candidate requires publication_build in the same run plan.");
  }
}

export function planStages(plan: RunPlan): StageId[] {
  validateRunPlan(plan.stages);
  return plan.stages as StageId[];
}
