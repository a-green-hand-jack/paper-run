import { existsSync } from "node:fs";
import { join } from "node:path";
import { readRunState, readPublication } from "../state/store.js";
import { planStages } from "../state/plans.js";
import { detectHarness, runVerify } from "../harness/harness.js";
import { capturePublicationBaseline } from "../pipeline/validators.js";
import { PAPER_RUN_DIR, STATE_FILES } from "../utils/constants.js";
import { requireProjectRoot } from "../utils/paths.js";
import { PaperRunError } from "../utils/errors.js";
import { printKeyValues } from "../utils/logger.js";
import { EXIT_CODES } from "../utils/errors.js";

export async function validateCommand(opts: { json?: boolean } = {}): Promise<void> {
  const projectDir = requireProjectRoot();
  const state = readRunState(projectDir);
  const checks: Array<{ name: string; passed: boolean; detail: string }> = [];
  checks.push({ name: "harness", passed: detectHarness(projectDir), detail: "agent-writing-harness detected" });
  let planValid = false;
  try {
    if (state.plan) {
      planStages(state.plan);
      planValid = true;
    }
  } catch {
    planValid = false;
  }
  checks.push({ name: "run-plan", passed: planValid, detail: state.plan?.profile ?? "missing" });
  let buildProfileDetail = "fallback profile";
  let buildProfileValid = true;
  try {
    capturePublicationBaseline(projectDir);
    if (existsSync(join(projectDir, ".agents", "paper-build.json"))) buildProfileDetail = "valid";
  } catch (error) {
    buildProfileValid = false;
    buildProfileDetail = error instanceof Error ? error.message : String(error);
  }
  checks.push({ name: "build-profile", passed: buildProfileValid, detail: buildProfileDetail });
  const verify = await runVerify(projectDir).catch((error) => ({ passed: false, summary: String(error) }));
  checks.push({ name: "harness-verify", passed: verify.passed, detail: verify.summary });
  const publication = readPublication(projectDir);
  const result = { valid: checks.every((check) => check.passed), checks, ...(publication ? { publication } : {}) };
  if (opts.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    if (!result.valid) process.exitCode = EXIT_CODES.BLOCKED;
  } else {
    printKeyValues(checks.map((check) => [check.name, `${check.passed ? "pass" : "fail"}: ${check.detail}`]));
    if (!result.valid) throw new PaperRunError("Project validation failed.");
  }
}

export async function publicationStatusCommand(opts: { json?: boolean } = {}): Promise<void> {
  const projectDir = requireProjectRoot();
  const publication = readPublication(projectDir);
  if (!publication) throw new PaperRunError(`No ${PAPER_RUN_DIR}/${STATE_FILES.publication} exists yet.`, {
    hint: "Run the publication_build stage first.",
  });
  if (opts.json) {
    process.stdout.write(JSON.stringify(publication, null, 2) + "\n");
    return;
  }
  printKeyValues(publication.variants.map((variant) => [variant.name, `${variant.status} -> ${variant.output}`]));
}
