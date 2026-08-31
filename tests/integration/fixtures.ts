/**
 * Shared fixtures for integration tests.
 *
 * The harness template is cloned once per test run and reused, because a
 * fresh clone per test would dominate the runtime and hammer GitHub. Tests get
 * a copy of the cached tree, never the cache itself, so one test cannot
 * corrupt another's starting point.
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execaSync } from "execa";

import { TEMPLATE_REPO, DEFAULT_TEMPLATE_VERSION } from "../../src/utils/constants.js";

process.env.GIT_AUTHOR_NAME ??= "Paper Run Integration Test";
process.env.GIT_AUTHOR_EMAIL ??= "paper-run@example.test";
process.env.GIT_COMMITTER_NAME ??= "Paper Run Integration Test";
process.env.GIT_COMMITTER_EMAIL ??= "paper-run@example.test";

/** Where the template is cached for the duration of a test run. */
const CACHE_DIR = join(tmpdir(), `paper-run-template-cache-${DEFAULT_TEMPLATE_VERSION}`);

/**
 * A harness checkout that tests can copy from.
 *
 * Honours PAPER_RUN_HARNESS so CI can clone once, outside the test run, and
 * point every suite at it.
 */
export function templateCache(): string {
  const provided = process.env["PAPER_RUN_HARNESS"];
  if (provided && existsSync(join(provided, "AGENTS.md"))) return provided;

  if (existsSync(join(CACHE_DIR, "AGENTS.md"))) return CACHE_DIR;

  rmSync(CACHE_DIR, { recursive: true, force: true });
  execaSync("git", [
    "clone",
    "--depth",
    "1",
    "--branch",
    DEFAULT_TEMPLATE_VERSION,
    `https://github.com/${TEMPLATE_REPO}.git`,
    CACHE_DIR,
  ]);
  rmSync(join(CACHE_DIR, ".git"), { recursive: true, force: true });

  return CACHE_DIR;
}

/** True when a template checkout is obtainable without hitting the network. */
export function templateAvailableOffline(): boolean {
  const provided = process.env["PAPER_RUN_HARNESS"];
  if (provided && existsSync(join(provided, "AGENTS.md"))) return true;
  return existsSync(join(CACHE_DIR, "AGENTS.md"));
}

/** A throwaway directory, removed by {@link cleanupTmp}. */
export function makeTmpDir(prefix = "paper-run-it-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function cleanupTmp(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOTEMPTY") throw error;
  }
}

/**
 * A writing repository laid out like a real one, without the network.
 *
 * Copies the cached template, initializes git, and commits — the state a repo
 * is in immediately after `paper-run init` fetches the template.
 */
export function makeWritingRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  cpSync(templateCache(), dir, { recursive: true });
  rmSync(join(dir, ".git"), { recursive: true, force: true });

  execaSync("git", ["init"], { cwd: dir });
  execaSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execaSync("git", ["config", "user.name", "Integration Test"], { cwd: dir });
  execaSync("git", ["add", "-A"], { cwd: dir });
  execaSync("git", ["commit", "-m", "Initialize from template"], { cwd: dir });
}

/**
 * A brief in the format the harness validator accepts.
 *
 * Note the `- Mode:` list item: the validator's MODE_RE requires a list
 * marker, and a bare `Mode:` line is reported as "does not declare a Mode".
 */
export function writeBrief(
  path: string,
  opts: { mode?: "autonomous" | "collaborative" | "unresolved" } = {},
): string {
  const mode = opts.mode ?? "autonomous";

  writeFileSync(
    path,
    `# Paper Brief

## Paper identity

Gate policies in agent-driven writing pipelines.

## What readers should believe

### Central thesis

A unified gate policy is simpler than dual-mode control flow.

### Contributions

- A gate-policy formulation of human-in-the-loop writing modes

## Operating mode

- Mode: ${mode}

## Evidence and materials

A prototype implementation and its test suite.

## What must not change silently

The central thesis.

## What may evolve

Section ordering and wording.

## Target and delivery

A workshop paper.

## Authors and identity

Integration Test

## Constraints

Eight pages.

## First deliverable

A draft introduction.

## Template usage note

Created by the paper-run integration suite.
`,
  );

  return path;
}
