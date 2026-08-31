import { describe, expect, it } from "vitest";
import { createRunPlan, PLAN_PROFILES, validateRunPlan } from "../../src/state/plans.js";

describe("run plans", () => {
  it("creates a profile and records omitted stages", () => {
    const plan = createRunPlan("review-only");
    expect(plan.profile).toBe("review-only");
    expect(plan.stages).toEqual(PLAN_PROFILES["review-only"]);
    expect(plan.skipped.map((item) => item.stage)).toContain("canonical_drafting");
  });

  it("accepts ordered custom plans", () => {
    expect(createRunPlan("full", "bootstrap,material_assessment,self_review,independent_review,revision").profile)
      .toBe("custom");
  });

  it("requires bootstrap and dependencies", () => {
    expect(() => validateRunPlan(["material_assessment"])).toThrow(/bootstrap/);
    expect(() => validateRunPlan(["bootstrap", "revision"])).toThrow(/independent_review/);
    expect(() => validateRunPlan(["bootstrap", "paper_candidate"])).toThrow(/publication_build/);
  });

  it("rejects duplicates and out-of-order stages", () => {
    expect(() => validateRunPlan(["bootstrap", "bootstrap"])).toThrow(/duplicate/);
    expect(() => validateRunPlan(["bootstrap", "self_review", "material_assessment"])).toThrow(/order/);
  });
});
