/**
 * `paper-run init` — create a new paper writing repository.
 *
 * The one command that can destroy something. Its central promise is that it
 * never writes into a directory that already has content: an existing paper
 * repository has a separate adoption path, and silently merging a template
 * into someone's work would be unrecoverable.
 *
 * Ordering matters here. The template is fetched first, then the brief is
 * validated against the real harness validator, and only then does anything
 * get committed. A brief that fails validation should leave no repository
 * behind, not a half-initialized one the user has to clean up by hand.
 */

import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { execa } from "execa";

import { installAdapter } from "../adapter/install.js";
import {
  fetchTemplate,
  verifyTemplateTree,
  hasGhCli,
  hasGhAuth,
} from "../harness/template.js";
import {
  runPaperInit,
  runBriefValidate,
  runBriefIngest,
  getTemplateVersion,
  initializeHarnessTrust,
} from "../harness/harness.js";
import { generateGatePreset } from "../state/gate-presets.js";
import { createRunPlan } from "../state/plans.js";
import {
  ensurePaperRunDir,
  writeRunState,
  writeGatePolicy,
  writeStageHistory,
} from "../state/store.js";
import type { RunState } from "../state/schema.js";
import {
  DEFAULT_TEMPLATE_VERSION,
  GIT,
  MODES,
  PAPER_RUN_DIR,
  TEMPLATE_REPO,
} from "../utils/constants.js";
import type { Mode } from "../utils/constants.js";
import { DirectoryNotEmptyError, PaperRunError } from "../utils/errors.js";
import { commitCheckpoint, createRunBranch, generateRunId, isGitRepo } from "../utils/git.js";
import { log, printKeyValues } from "../utils/logger.js";
import { isEmptyDir } from "../utils/paths.js";

export interface InitOptions {
  brief: string;
  mode: string;
  template: string;
  /** Skip GitHub: fetch the template directly instead of creating a repo. */
  local?: boolean;
  /** For the GitHub route: repository to create, "owner/name". */
  repo?: string;
  /** Create the GitHub repo public rather than private. */
  public?: boolean;
  /** Model for the OpenCode adapter. */
  model?: string;
}

export const INITIAL_STAGE_STATUS: RunState["stage_status"] = "pending";

export async function initCommand(directory: string, opts: InitOptions): Promise<void> {
  const target = resolve(directory);
  const mode = parseMode(opts.mode);
  const briefPath = resolveBrief(opts.brief);
  const version = opts.template || DEFAULT_TEMPLATE_VERSION;

  // --- refuse to touch existing work ---
  assertTargetUsable(target);

  // Decide the route before creating anything, so a missing `gh` fails now
  // rather than after the directory exists.
  const useGithub = !opts.local;
  if (useGithub) await assertGhUsable(opts.repo);

  log.step(`Initializing a paper writing repository at ${target}`);

  // Track whether we created the directory, so a failure can clean up after
  // itself without ever deleting something that was already there.
  const weCreatedTarget = !existsSync(target);

  try {
    // --- template ---
    const fetched = await fetchTemplate({
      targetDir: target,
      version,
      source: useGithub ? "github" : "local",
      ...(opts.repo !== undefined ? { repoName: opts.repo } : {}),
      ...(opts.public !== undefined ? { private: !opts.public } : {}),
    });

    const missing = verifyTemplateTree(target);
    if (missing.length > 0) {
      throw new PaperRunError(
        `The fetched template is missing expected files: ${missing.join(", ")}`,
        {
          hint: `The template may have changed since ${version}. Try --template with a known-good tag.`,
        },
      );
    }
    log.success(`Template ready (${fetched.source}, ${fetched.version})`);

    // --- git ---
    if (!isGitRepo(target)) {
      await execa("git", ["init"], { cwd: target });
      await execa("git", ["add", "-A"], { cwd: target });
      await execa("git", ["commit", "-m", "Initialize writing repository from template"], {
        cwd: target,
      });
    }

    // Trust is local Git metadata and must exist before any fetched code runs.
    await initializeHarnessTrust(target, version);

    // --- brief: validate before committing to anything ---
    log.step("Validating the brief");
    const validation = await runBriefValidate(target, briefPath);
    if (!validation.passed) {
      throw new PaperRunError(
        `The brief did not pass validation:\n${indent(validation.stdout || validation.stderr)}`,
        {
          hint: "Fix the brief and run init again. Nothing was written to the target directory.",
        },
      );
    }
    log.success("Brief is valid");

    // --- harness initialization ---
    //
    // record-template-origin and clean are a pair, and both belong to the
    // harness's GitHub-Template creation workflow: the first records a
    // provenance marker proving the repo was stamped from the template, and
    // the second refuses to run without it. A --local repository has no
    // GitHub origin to record, so neither step applies and forcing them
    // would fail the init outright.
    //
    // The cost is that a local repo keeps the template's governance files
    // (CONTRIBUTING.md and friends). That is cosmetic and reversible, so it
    // is worth saying rather than working around.
    if (await hasDistinctRemote(target)) {
      log.step("Recording template provenance");
      await runPaperInit(target, "record-template-origin", { commit: true });

      log.step("Removing template governance residue");
      await runPaperInit(target, "clean", { commit: true });
    } else {
      log.debug("no distinct GitHub origin; skipping template provenance steps");
      log.warn(
        "No GitHub origin: template provenance was not recorded and template governance " +
          "files remain.",
      );
      log.hint(
        "To record provenance later, add a remote and run:\n" +
          "    python3 .agents/tools/paper-init.py record-template-origin --commit\n" +
          "    python3 .agents/tools/paper-init.py clean --commit",
      );
    }

    log.step("Ingesting the brief");
    await runBriefIngest(target, briefPath, { commit: true });

    // --- run state ---
    const runId = generateRunId();
    const branch = `${GIT.runBranchPrefix}${runId}`;

    ensurePaperRunDir(target);

    const now = new Date().toISOString();
    const state: RunState = {
      schema_version: "paper-run-v1",
      run_id: runId,
      run_branch: branch,
      mode,
      current_stage: "bootstrap",
      stage_status: INITIAL_STAGE_STATUS,
      started_at: now,
      updated_at: now,
      template_version: getTemplateVersion(target) ?? version,
    };

    const plan = createRunPlan();
    writeRunState(target, { ...state, plan });
    writeGatePolicy(target, generateGatePreset(mode));
    const planTime = new Date().toISOString();
    writeStageHistory(target, {
      schema_version: "paper-run-stage-history-v1",
      stages: plan.skipped.map((item) => ({
        stage_id: item.stage,
        status: "skipped" as const,
        started_at: planTime,
        completed_at: planTime,
        commit_sha: "planned",
        skip_reason: item.reason,
      })),
    });

    // --- OpenCode adapter ---
    log.step("Installing the OpenCode adapter");
    await installAdapter(target, opts.model !== undefined ? { model: opts.model } : {});

    // --- run branch and first checkpoint ---
    await createRunBranch(runId, target);
    const sha = await commitCheckpoint(
      {
        stageId: "bootstrap",
        status: INITIAL_STAGE_STATUS,
        runId,
        mode,
        templateVersion: state.template_version,
      },
      target,
    );

    reportSuccess({ target, mode, version: state.template_version, runId, branch, sha, fetched });
  } catch (err) {
    // Leave nothing half-built. Only remove a directory this command created:
    // if it already existed we must not touch it, even on failure.
    if (weCreatedTarget && existsSync(target)) {
      rmSync(target, { recursive: true, force: true });
      log.debug(`removed partially initialized ${target}`);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function parseMode(value: string): Mode {
  if ((MODES as readonly string[]).includes(value)) return value as Mode;
  throw new PaperRunError(`Invalid mode "${value}".`, {
    hint: `Must be one of: ${MODES.join(", ")}`,
  });
}

function resolveBrief(brief: string): string {
  const path = isAbsolute(brief) ? brief : resolve(process.cwd(), brief);
  if (!existsSync(path)) {
    throw new PaperRunError(`Brief not found: ${brief}`, {
      hint: "Pass --brief with a path to a brief file, a BRIEF.md, or a brief repository directory.",
    });
  }
  return path;
}

/**
 * Refuse anything that already holds content.
 *
 * A non-empty directory is very likely someone's existing work, and an
 * existing paper repository has its own adoption path. Merging a template
 * over either would be unrecoverable.
 */
function assertTargetUsable(target: string): void {
  if (!existsSync(target)) return;

  const stat = statSync(target);
  if (!stat.isDirectory()) {
    throw new PaperRunError(`Target exists and is not a directory: ${target}`);
  }

  if (!isEmptyDir(target)) {
    // Name the more specific case, since the fix differs.
    if (existsSync(resolve(target, PAPER_RUN_DIR))) {
      throw new PaperRunError(`${target} is already a paper-run project.`, {
        hint: "Use `paper-run start` to continue it, or choose a different directory.",
      });
    }
    throw new DirectoryNotEmptyError(target);
  }
}

async function assertGhUsable(repo: string | undefined): Promise<void> {
  if (!repo) {
    throw new PaperRunError("A repository name is required when creating a GitHub repository.", {
      hint: "Pass --repo <owner/name>, or use --local to initialize without GitHub.",
    });
  }

  if (!(await hasGhCli())) {
    throw new PaperRunError("The GitHub CLI (`gh`) is not installed.", {
      hint: "Install it from https://cli.github.com, or use --local to initialize without GitHub.",
    });
  }

  if (!(await hasGhAuth())) {
    throw new PaperRunError("The GitHub CLI is not authenticated.", {
      hint: "Run `gh auth login`, or use --local to initialize without GitHub.",
    });
  }
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/**
 * True when the repo has a git origin that is not the upstream template.
 *
 * `record-template-origin` records where a writing repo came from, and refuses
 * to run without a distinct GitHub origin — so a `--local` repo, which has no
 * remote at all, must skip that step rather than fail on it.
 */
async function hasDistinctRemote(dir: string): Promise<boolean> {
  let url: string;
  try {
    const { stdout } = await execa("git", ["remote", "get-url", "origin"], { cwd: dir });
    url = stdout.trim();
  } catch {
    return false;
  }

  if (!url) return false;
  // The upstream template itself does not count as a distinct origin.
  return !url.includes(TEMPLATE_REPO);
}

function reportSuccess(info: {
  target: string;
  mode: Mode;
  version: string;
  runId: string;
  branch: string;
  sha: string;
  fetched: { source: string; remote?: string };
}): void {
  log.blank();
  log.success("Writing repository initialized.");
  log.blank();

  const rows: Array<[string, string]> = [
    ["Location", info.target],
    ["Mode", info.mode],
    ["Template", `agent-writing-harness ${info.version}`],
    ["Run", info.runId],
    ["Branch", info.branch],
    ["Checkpoint", info.sha.slice(0, 8)],
  ];
  if (info.fetched.remote) rows.push(["Remote", info.fetched.remote]);
  printKeyValues(rows);

  log.blank();
  log.info("Next:");
  log.info(`  cd ${info.target}`);
  log.info("  paper-run");
}

function indent(text: string, prefix = "  "): string {
  return text
    .trim()
    .split("\n")
    .map((line) => prefix + line)
    .join("\n");
}

/** Exported for the CLI's directory pre-check. */
export { assertTargetUsable };

/** Ensure a directory exists, creating parents. */
export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}
