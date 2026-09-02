import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
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
    expect(TRAILER_KEYS).toContain("Paper-Run-Kind");
    expect(TRAILER_KEYS).toContain("Paper-Run-Locked-Authorization");
    expect(TRAILER_KEYS.length).toBe(11);
    for (const key of TRAILER_KEYS) {
      expect(key.startsWith("Paper-Run-")).toBe(true);
    }
  });

  it("TEMPLATE_REPO points to correct repo", () => {
    expect(TEMPLATE_REPO).toBe("a-green-hand-jack/agent-writing-harness");
  });

  it("DEFAULT_TEMPLATE_VERSION is v0.3.1", () => {
    // v0.3.1 is the first release in which a supplied, read-only bibliography
    // can be cited offline. Against v0.3.0 the citation floors this pipeline
    // now enforces are unsatisfiable: the Draft citation-support profile
    // requires retrieved passages the writer has no way to fetch.
    expect(DEFAULT_TEMPLATE_VERSION).toBe("v0.3.1");
  });
});

describe("the CLI's template default", () => {
  it("is the pinned constant, not a second copy of it", async () => {
    // The constant was bumped to v0.3.1 and the CLI option default was left at
    // v0.3.0. Commander's default always wins, so every `paper-run init`
    // silently fetched the older harness -- including the one whose supplied-
    // bibliography citation fix was the whole point of the bump. Only a run
    // pinned by hand got what the constant said it would.
    const cli = await readFile(new URL("../../src/cli.ts", import.meta.url), "utf-8");
    const hardcoded = cli.match(/"harness template version",\s*"v\d+\.\d+\.\d+"/g);

    expect(hardcoded).toBeNull();
    expect(cli).toContain('"harness template version", DEFAULT_TEMPLATE_VERSION');
  });
});
