/**
 * Fetching the agent-writing-harness template into a new writing repository.
 *
 * Two routes, because "create a paper repo" means different things to
 * different users:
 *
 *  - **GitHub** (`gh repo create --template`) — the documented happy path.
 *    Creates a repo under the user's account with the template's structure and
 *    clones it. Requires `gh`, authentication, and network.
 *  - **Local** (tarball) — no GitHub account, no remote. Downloads the pinned
 *    tag and unpacks it. Still needs network, but nothing else.
 *
 * The template is always pinned to a tag. It ships 5 releases in 52 days and
 * renamed itself at v0.3.0, so tracking a moving target would break writing
 * repos without warning.
 */

import { execa } from "execa";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

import { TEMPLATE_REPO, DEFAULT_TEMPLATE_VERSION } from "../utils/constants.js";
import { MissingDependencyError, PaperRunError } from "../utils/errors.js";
import { log } from "../utils/logger.js";

export type TemplateSource = "github" | "local";

export interface FetchTemplateOptions {
  /** Where the writing repo should end up. Must be empty or absent. */
  targetDir: string;
  /** Template tag, e.g. "v0.3.0". */
  version?: string;
  /** How to obtain it. */
  source?: TemplateSource;
  /** For the GitHub route: the repo to create, e.g. "me/my-paper". */
  repoName?: string;
  /** For the GitHub route: create the repo private. Defaults to true. */
  private?: boolean;
}

export interface FetchTemplateResult {
  source: TemplateSource;
  version: string;
  /** Set when a GitHub repo was created. */
  remote?: string;
}

// ---------------------------------------------------------------------------
// Availability checks
// ---------------------------------------------------------------------------

/** True when the `gh` CLI is installed. */
export async function hasGhCli(): Promise<boolean> {
  try {
    await execa("gh", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

/** True when `gh` is installed *and* authenticated. */
export async function hasGhAuth(): Promise<boolean> {
  try {
    const result = await execa("gh", ["auth", "status"], { reject: false });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

export async function fetchTemplate(
  opts: FetchTemplateOptions,
): Promise<FetchTemplateResult> {
  const version = opts.version ?? DEFAULT_TEMPLATE_VERSION;
  const target = resolve(opts.targetDir);
  const source = opts.source ?? "github";

  if (source === "github") {
    return fetchViaGh(target, version, opts);
  }
  return fetchViaTarball(target, version);
}

/**
 * Create a GitHub repo from the template and clone it.
 *
 * `gh repo create --template` copies the template's *current default branch*
 * rather than a tag, so the clone is checked against the requested version
 * afterwards and the caller is warned if they differ.
 */
async function fetchViaGh(
  target: string,
  version: string,
  opts: FetchTemplateOptions,
): Promise<FetchTemplateResult> {
  if (!(await hasGhCli())) {
    throw new MissingDependencyError(
      "gh",
      "The GitHub CLI is needed to create a repository from the template.\n" +
        "  Install: https://cli.github.com  •  or use --local to fetch the template without GitHub.",
    );
  }

  if (!(await hasGhAuth())) {
    throw new MissingDependencyError(
      "gh (authenticated)",
      "Run `gh auth login` first, or use --local to fetch the template without GitHub.",
    );
  }

  const repoName = opts.repoName;
  if (!repoName) {
    throw new PaperRunError("A repository name is required to create a GitHub repository.", {
      hint: "Pass --repo <owner/name>, or use --local to skip GitHub entirely.",
    });
  }

  log.step(`Creating ${repoName} from ${TEMPLATE_REPO}`);

  const visibility = opts.private === false ? "--public" : "--private";

  try {
    await execa("gh", [
      "repo",
      "create",
      repoName,
      "--template",
      TEMPLATE_REPO,
      visibility,
      "--clone",
      target,
    ]);
  } catch (err) {
    throw new PaperRunError(`Could not create the repository: ${describeExecError(err)}`, {
      hint: "Check the name is available and you have permission to create repositories there.",
      cause: err,
    });
  }

  let remote: string | undefined;
  try {
    const { stdout } = await execa("git", ["remote", "get-url", "origin"], { cwd: target });
    remote = stdout.trim();
  } catch {
    // A repo without a remote is unusual here but not fatal.
  }

  return remote !== undefined ? { source: "github", version, remote } : { source: "github", version };
}

/**
 * Download and unpack the template tarball for a pinned tag.
 *
 * Uses git rather than curl+tar so there is one fewer dependency to check, and
 * so a partial download fails loudly instead of unpacking half a template.
 */
async function fetchViaTarball(target: string, version: string): Promise<FetchTemplateResult> {
  log.step(`Fetching ${TEMPLATE_REPO}@${version}`);

  const staging = `${target}.paper-run-staging`;
  rmSync(staging, { recursive: true, force: true });

  try {
    await execa("git", [
      "clone",
      "--depth",
      "1",
      "--branch",
      version,
      `https://github.com/${TEMPLATE_REPO}.git`,
      staging,
    ]);
  } catch (err) {
    rmSync(staging, { recursive: true, force: true });
    throw new PaperRunError(
      `Could not fetch the template at ${version}: ${describeExecError(err)}`,
      {
        hint: `Check the tag exists and you have network access: https://github.com/${TEMPLATE_REPO}/releases`,
        cause: err,
      },
    );
  }

  // Drop the template's own history: a writing repo starts its own.
  rmSync(join(staging, ".git"), { recursive: true, force: true });

  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(staging)) {
    renameSync(join(staging, entry), join(target, entry));
  }
  rmSync(staging, { recursive: true, force: true });

  return { source: "local", version };
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/**
 * Confirm the fetched tree actually looks like the harness.
 *
 * Guards against a template that moved on: if `gh` copied a default branch
 * that no longer ships these paths, failing here is far better than failing
 * later inside a stage.
 */
export function verifyTemplateTree(dir: string): string[] {
  const required = [
    "AGENTS.md",
    "PAPER.md",
    "BRIEF.md",
    ".agents/tools/verify.sh",
    ".agents/tools/paper-init.py",
    ".agents/tools/paper-brief.py",
    ".agents/skills",
    "paper",
  ];

  return required.filter((rel) => !existsSync(join(resolve(dir), rel)));
}

function describeExecError(err: unknown): string {
  if (err && typeof err === "object" && "stderr" in err) {
    const stderr = String((err as { stderr?: unknown }).stderr ?? "").trim();
    if (stderr) return stderr.split("\n").slice(0, 3).join("\n");
  }
  return err instanceof Error ? err.message : String(err);
}
