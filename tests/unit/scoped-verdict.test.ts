/**
 * A partial verdict limits claims, not the whole paper.
 *
 * On pwb-0011 the gap was two missing models out of five. The prompt turned
 * that into "carry everything else as an explicit TODO marker", and the run
 * returned a 49-word related work section with markers in every file.
 */

import { describe, it, expect } from "vitest";

import { renderStagePrompt } from "../../src/pipeline/prompts.js";
import { STAGES } from "../../src/pipeline/stages.js";
import type { ScopeLimit } from "../../src/state/schema.js";

const base = { mode: "autonomous" as const, history: [] };

const LIMIT: ScopeLimit = {
  id: "L1",
  claim: "evaluation on five LLMs",
  evidence_gap: "the supplied tables cover three models",
  applies_to: ["paper/sections/01_abstract.tex"],
};

describe("materialNote", () => {
  it("names the limited claim and says the rest is written in full", () => {
    const prompt = renderStagePrompt(STAGES.full_draft, {
      ...base,
      materialVerdict: "partial",
      materialLimits: [LIMIT],
    });

    expect(prompt).toContain("evaluation on five LLMs");
    expect(prompt).toContain("the supplied tables cover three models");
    expect(prompt).toContain("paper/sections/01_abstract.tex");
    expect(prompt).toContain("Everything not listed above is supported");
    expect(prompt).toContain("not licence to defer a section");
  });

  it("no longer tells the writer to mark everything else", () => {
    const prompt = renderStagePrompt(STAGES.full_draft, {
      ...base,
      materialVerdict: "partial",
      materialLimits: [LIMIT],
    });
    expect(prompt).not.toContain("carry everything else");
  });

  it("treats an unscoped partial verdict as usable rather than as licence to hedge", () => {
    const prompt = renderStagePrompt(STAGES.full_draft, {
      ...base,
      materialVerdict: "partial",
    });
    expect(prompt).toContain("Treat the materials as usable");
    expect(prompt).not.toContain("carry everything else");
  });

  it("still stops the run cold on an unusable verdict", () => {
    const prompt = renderStagePrompt(STAGES.full_draft, {
      ...base,
      materialVerdict: "unusable",
    });
    expect(prompt).toContain("must not proceed");
  });

  it("says nothing at all when the materials are usable", () => {
    const prompt = renderStagePrompt(STAGES.full_draft, { ...base, materialVerdict: "usable" });
    expect(prompt).not.toContain("Material constraints");
  });
});

describe("the remediation boundary", () => {
  it("forbids satisfying a check by editing the inputs", () => {
    const prompt = renderStagePrompt(STAGES.full_draft, base);
    expect(prompt).toContain("Supplied inputs are evidence, not workspace");
  });
});
