/**
 * Shared constants: directory names, file names, and pipeline identity.
 *
 * Anything that names a path on disk or a value written into a state file
 * belongs here, so the writing repo's on-disk contract has exactly one source
 * of truth.
 */

/** Directory holding paper-run's own state inside a writing repo. */
export const PAPER_RUN_DIR = ".paper-run";

/** State file names inside PAPER_RUN_DIR. */
export const STATE_FILES = {
  run: "run.json",
  gatePolicy: "gate-policy.json",
  stageHistory: "stage-history.json",
  session: "session.json",
  assessment: "assessment.json",
  performance: "performance.json",
  reviewFindings: "review-findings.json",
  publication: "publication.json",
} as const;

/** OpenCode project-level adapter directory. */
export const OPENCODE_DIR = ".opencode";

/** OpenCode project config file. */
export const OPENCODE_CONFIG = "opencode.json";

/** Harness files used to detect a writing repo and read its contracts. */
export const HARNESS = {
  agentsRouter: "AGENTS.md",
  toolsDir: ".agents/tools",
  skillsDir: ".agents/skills",
  verifyScript: ".agents/tools/verify.sh",
  paperInit: ".agents/tools/paper-init.py",
  paperBrief: ".agents/tools/paper-brief.py",
  templateOrigin: ".agents/template-origin.json",
  buildProfile: ".agents/paper-build.json",
} as const;

/** Local-only harness provenance stored below Git's common directory. */
export const HARNESS_TRUST = {
  schemaVersion: "paper-run-harness-trust-v1",
  directory: "paper-run-trust",
  repositoryIdFile: "paper-run-repository-id",
} as const;

/** Harness paper contracts, by logical name. */
export const CONTRACTS = {
  PAPER: "PAPER.md",
  EXPERIMENTS: "EXPERIMENTS.md",
  BRIEF: "BRIEF.md",
  PUBLICATION: "PUBLICATION.md",
  DECISIONS: "DECISIONS.md",
  PAPER_INTERFACES: "PAPER_INTERFACES.md",
  REFERENCES: "REFERENCES.md",
} as const;

export type ContractName = keyof typeof CONTRACTS;

/** Upstream harness template, pinned. */
export const TEMPLATE_REPO = "a-green-hand-jack/agent-writing-harness";
export const DEFAULT_TEMPLATE_VERSION = "v0.3.0";

/** Git naming conventions. */
export const GIT = {
  runBranchPrefix: "paper-run/",
  candidateTagPrefix: "paper-candidate/",
  trailerPrefix: "Paper-Run-",
} as const;

/** Commit trailer keys, in the order they are written. */
export const TRAILER_KEYS = [
  "Paper-Run-Stage",
  "Paper-Run-Status",
  "Paper-Run-Run",
  "Paper-Run-Mode",
  "Paper-Run-Stage-Timeout-Multiplier",
  "Paper-Run-Session",
  "Paper-Run-Template",
  "Paper-Run-Material-Hash",
  "Paper-Run-Locked-Authorization",
  "Paper-Run-Kind",
  "Paper-Run-Timestamp",
] as const;

export type TrailerKey = (typeof TRAILER_KEYS)[number];

/** Operating modes. Mirrors the harness `PAPER.md ## Operating mode` field. */
export const MODES = ["autonomous", "collaborative"] as const;
export type Mode = (typeof MODES)[number];

/** Default OpenCode server settings. */
export const OPENCODE_DEFAULTS = {
  /** 0 = let the OS assign a free port. */
  port: 0,
  hostname: "127.0.0.1",
  /** How long to wait for `opencode serve` to report healthy. */
  startupTimeoutMs: 30_000,
  /** Default per-stage budget for an agent turn. */
  stageTimeoutMs: 10 * 60_000,
  /**
   * How long to allow a session to pick up a prompt before an idle status is
   * read as "finished" rather than "not started yet". promptAsync returns
   * before the agent begins, so without this the controller races past its
   * own prompt.
   */
  startupGraceMs: 15_000,
} as const;
