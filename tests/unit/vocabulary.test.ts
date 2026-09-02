/**
 * The stage vocabulary as an on-disk contract.
 *
 * Stage ids leave the process: one goes into every checkpoint commit's
 * trailers, one into every history record. Retiring an id therefore has to keep
 * old repositories *readable* while refusing to reinterpret them, and the
 * adapter's copy of the list has to stay in step with the controller's. Both
 * are easy to get wrong silently, which is why they are pinned here.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  PIPELINE_STAGES,
  RETIRED_STAGE_IDS,
  KNOWN_STAGE_IDS,
  isRetiredStage,
} from "../../src/state/gate-presets.js";
import { findStage, getStage, stagePosition } from "../../src/pipeline/stages.js";
import { planStages } from "../../src/state/plans.js";

describe("retired stage ids", () => {
  it("keeps every retired id readable", () => {
    for (const id of RETIRED_STAGE_IDS) {
      expect(KNOWN_STAGE_IDS).toContain(id);
      expect(isRetiredStage(id)).toBe(true);
    }
  });

  it("treats an id as retired only while it is absent from the pipeline", () => {
    // During a rollout an id can appear in both lists. Retirement is the
    // conjunction, so the predicate cannot report a live stage as retired.
    for (const id of PIPELINE_STAGES) {
      expect(isRetiredStage(id)).toBe(false);
    }
    expect(isRetiredStage("not_a_stage_at_all")).toBe(false);
  });

  it("looks up a retired id without throwing, and refuses to resolve it", () => {
    const retired = RETIRED_STAGE_IDS[0]!;
    expect(findStage(retired)).toBeNull();
    expect(stagePosition(retired)).toBe(-1);
    // The throwing lookup is for callers about to execute a stage.
    expect(() => getStage(retired)).toThrow(/Unknown pipeline stage/);
  });

  it("trusts a plan recorded under the older vocabulary", () => {
    // Recomputing this plan's skipped metadata against the current list would
    // reject it outright, stranding a run that is otherwise inspectable.
    const stages = planStages({
      profile: "full",
      stages: ["bootstrap", "material_assessment", RETIRED_STAGE_IDS[0]!, "self_review"],
      skipped: [{ stage: RETIRED_STAGE_IDS[1]!, reason: "omitted by an older profile" }],
    });

    expect(stages).toContain("bootstrap");
    expect(stages).not.toContain(RETIRED_STAGE_IDS[0]);
  });
});

describe("the adapter's copy of the stage list", () => {
  const templatePath = join(process.cwd(), "templates/opencode/tools/paper-run-state.ts");

  it("holds no literal stage id of its own", () => {
    // A second hand-maintained list is a second source of truth that nothing
    // type-checks. The installer substitutes it instead.
    const template = readFileSync(templatePath, "utf-8");
    expect(template).toContain("{{PIPELINE_STAGES}}");
    for (const id of PIPELINE_STAGES) {
      expect(template).not.toContain(`"${id}"`);
    }
  });
});
