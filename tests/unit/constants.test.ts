import { describe, it, expect } from "vitest";
import {
  PAPER_RUN_DIR,
  STATE_FILES,
  MODES,
  GIT,
  TRAILER_KEYS,
  TEMPLATE_REPO,
  DEFAULT_TEMPLATE_VERSION,
} from "../../src/utils/constants.js";

describe("constants", () => {
  it("PAPER_RUN_DIR is .paper-run", () => {
    expect(PAPER_RUN_DIR).toBe(".paper-run");
  });

  it("STATE_FILES has all expected keys", () => {
    expect(STATE_FILES.run).toBe("run.json");
    expect(STATE_FILES.gatePolicy).toBe("gate-policy.json");
    expect(STATE_FILES.stageHistory).toBe("stage-history.json");
    expect(STATE_FILES.session).toBe("session.json");
    expect(STATE_FILES.assessment).toBe("assessment.json");
  });

  it("MODES are autonomous and collaborative", () => {
    expect(MODES).toContain("autonomous");
    expect(MODES).toContain("collaborative");
    expect(MODES).toHaveLength(2);
  });

  it("GIT conventions are correct", () => {
    expect(GIT.runBranchPrefix).toBe("paper-run/");
    expect(GIT.candidateTagPrefix).toBe("paper-candidate/");
    expect(GIT.trailerPrefix).toBe("Paper-Run-");
  });

  it("TRAILER_KEYS starts with Paper-Run-Stage", () => {
    expect(TRAILER_KEYS[0]).toBe("Paper-Run-Stage");
    expect(TRAILER_KEYS.length).toBe(8);
    for (const key of TRAILER_KEYS) {
      expect(key.startsWith("Paper-Run-")).toBe(true);
    }
  });

  it("TEMPLATE_REPO points to correct repo", () => {
    expect(TEMPLATE_REPO).toBe("a-green-hand-jack/agent-writing-harness");
  });

  it("DEFAULT_TEMPLATE_VERSION is v0.3.0", () => {
    expect(DEFAULT_TEMPLATE_VERSION).toBe("v0.3.0");
  });
});
