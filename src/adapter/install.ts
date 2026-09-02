/**
 * Installing the OpenCode adapter into a writing repository.
 *
 * paper-run drives OpenCode, but OpenCode only knows what a project's own
 * `.opencode/` directory tells it. The adapter is the bridge: agent
 * definitions, slash commands, a state tool and a gate plugin that together
 * teach a generic OpenCode session how to behave as a paper-writing harness.
 *
 * Those files ship as static templates under `templates/opencode/` rather than
 * as string literals in this module, so they stay readable, diffable, and
 * editable by the user after installation. This module's whole job is to find
 * that template tree (which lives at a different depth in `src/` than in the
 * built `dist/`), copy it in, and substitute a small set of `{{PLACEHOLDER}}`
 * values.
 *
 * Installation is deliberately non-destructive: once a file is on disk the
 * user may have tuned it, so a plain re-install reports it as `skipped`
 * instead of clobbering the edit. `force` is the explicit opt-in to overwrite.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { OPENCODE_DIR, OPENCODE_CONFIG, PAPER_RUN_DIR, STATE_FILES } from "../utils/constants.js";
import { PaperRunError } from "../utils/errors.js";
import { PIPELINE_STAGES } from "../state/gate-presets.js";
import { log } from "../utils/logger.js";

// ---------------------------------------------------------------------------
// Options and results
// ---------------------------------------------------------------------------

/**
 * Directories that must be duplicated under a second name.
 *
 * OpenCode 1.18.25 loads project agents and commands from the SINGULAR
 * `.opencode/agent/` and `.opencode/command/` — verified by `opencode agent
 * list`, which does not see paper-writer until the singular directory exists.
 * The published docs show the plural form, and plugins/tools genuinely are
 * plural. Rather than bet on one reading, both names are written: a duplicate
 * directory is harmless, whereas an agent that never loads takes the whole
 * adapter down silently — no paper-writer, no /status, no /approve.
 */
const DIRECTORY_ALIASES: Record<string, string> = {
  agent: "agents",
  command: "commands",
};

/** Default model used by the adapter's agents when the caller does not pick one. */
export const DEFAULT_MODEL = "anthropic/claude-sonnet-4-20250514";

export interface InstallOptions {
  /** Model id substituted for `{{MODEL}}` in the templates. */
  model?: string;
  /** Overwrite files that already exist instead of skipping them. */
  force?: boolean;
}

export interface InstallResult {
  /** Project-relative paths written by this call. */
  installed: string[];
  /** Project-relative paths left untouched because they already existed. */
  skipped: string[];
}

/**
 * The line appended to the writing repo's `.gitignore`.
 *
 * `session.json` holds an ephemeral server URL and PID; committing it would
 * make every run dirty the working tree and leak a local port into history.
 */
const SESSION_IGNORE_LINE = `${PAPER_RUN_DIR}/${STATE_FILES.session}`;

/** Runtime-only paths a writing repo should never commit. */
const IGNORE_LINES = [
  SESSION_IGNORE_LINE,
  `${PAPER_RUN_DIR}/run.log`,
  `${PAPER_RUN_DIR}/${STATE_FILES.performance}`,
  `${PAPER_RUN_DIR}/${STATE_FILES.publication}`,
];

// ---------------------------------------------------------------------------
// Locating the shipped templates
// ---------------------------------------------------------------------------

/**
 * Find `templates/opencode/` relative to this module.
 *
 * The depth differs between layouts — `src/adapter/install.ts` is two levels
 * below the package root, `dist/index.js` is one — so instead of hardcoding a
 * `../..` we walk upward until the template tree appears. That also survives
 * any future reshuffling of the build output.
 */
export function findTemplatesDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));

  for (;;) {
    const candidate = join(dir, "templates", "opencode");
    if (existsSync(candidate)) return candidate;

    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  throw new PaperRunError("Could not locate the bundled `templates/opencode/` directory.", {
    hint: "The paper-run installation looks incomplete. Reinstall the package.",
  });
}

// ---------------------------------------------------------------------------
// Placeholder substitution
// ---------------------------------------------------------------------------

/**
 * Replace `{{KEY}}` occurrences using `values`.
 *
 * Unknown placeholders are left verbatim on purpose: a template may legitimately
 * want to show `{{...}}` syntax to the agent, and silently blanking it would be
 * harder to debug than leaving it visible.
 */
export function substitutePlaceholders(content: string, values: Record<string, string>): string {
  return content.replace(/\{\{(\w+)\}\}/g, (match, key: string) => values[key] ?? match);
}

// ---------------------------------------------------------------------------
// Copying
// ---------------------------------------------------------------------------

/** Collect every file under `dir`, as paths relative to `dir`, depth-first and sorted. */
function listFilesRecursive(dir: string, prefix = ""): string[] {
  const out: string[] = [];

  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      out.push(...listFilesRecursive(join(dir, entry.name), rel));
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }

  return out;
}

/** Marks a template revision so an installed copy can be recognised as stale. */
/**
 * The template revision, in whichever comment syntax the file speaks.
 *
 * Markdown templates carry an HTML comment; the TypeScript tool and plugin
 * carry a line comment. Matching only the former meant the state tool could
 * never age out of an existing repository — it would keep reporting a stage
 * list the controller had stopped using, which is the quietest possible way
 * for an upgrade to do nothing.
 */
const REVISION_MARKER = /(?:<!--|\/\/)\s*paper-run-adapter-revision:\s*(\d+)\s*(?:-->)?/;

/**
 * True when an installed file predates the template's current revision.
 *
 * Install is non-destructive so a human's edit to an agent file survives an
 * upgrade. The cost is that a template change never reaches an existing
 * repository — which for behaviour-carrying files like the writer's
 * instructions means an upgrade silently changes nothing, and any measurement
 * of the change reports "no effect" for the wrong reason.
 *
 * A revision marker resolves both: files carrying one are refreshed when the
 * template's number is higher, and files without one keep the old
 * skip-unless-force behaviour.
 */
function isStaleAdapterFile(sourcePath: string, targetPath: string): boolean {
  const source = readFileSync(sourcePath, "utf-8").match(REVISION_MARKER);
  if (!source) return false;
  let installed: RegExpMatchArray | null;
  try {
    installed = readFileSync(targetPath, "utf-8").match(REVISION_MARKER);
  } catch {
    return false;
  }
  // No marker means the file is not a recognisable template copy -- most
  // likely a human rewrote it. Refreshing it would break the promise that an
  // edit survives an upgrade, and "old template" is indistinguishable from
  // "hand-written" here. Those repositories need an explicit --force.
  if (!installed) return false;
  return Number(source[1]) > Number(installed[1]);
}

/**
 * Write one template file, honouring the skip-unless-force rule.
 * Returns whether the file was written.
 */
function writeTemplate(
  sourcePath: string,
  targetPath: string,
  values: Record<string, string>,
  force: boolean,
): boolean {
  if (existsSync(targetPath) && !force && !isStaleAdapterFile(sourcePath, targetPath)) return false;

  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, substitutePlaceholders(readFileSync(sourcePath, "utf-8"), values));
  return true;
}

/** Normalise a path for reporting, so results read the same on every platform. */
function toPosix(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}

// ---------------------------------------------------------------------------
// .gitignore
// ---------------------------------------------------------------------------

/**
 * Ensure the writing repo ignores `.paper-run/session.json`.
 *
 * Creates `.gitignore` when absent and appends only when the line is missing,
 * so repeated installs never duplicate it.
 *
 * Returns true when the file was created or modified.
 */
export function ensureGitignore(projectDir: string): boolean {
  const path = join(resolve(projectDir), ".gitignore");
  const header = "# paper-run runtime state";

  if (!existsSync(path)) {
    writeFileSync(path, `${header}\n${IGNORE_LINES.join("\n")}\n`);
    return true;
  }

  const current = readFileSync(path, "utf-8");
  const present = new Set(current.split("\n").map((line) => line.trim()));
  const missing = IGNORE_LINES.filter((line) => !present.has(line));

  if (missing.length === 0) return false;

  const separator = current === "" || current.endsWith("\n") ? "" : "\n";
  writeFileSync(path, `${current}${separator}\n${header}\n${missing.join("\n")}\n`);
  return true;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Install the OpenCode adapter into `projectDir`.
 *
 * Everything under `templates/opencode/` lands in `<projectDir>/.opencode/`,
 * except `opencode.json`, which OpenCode expects at the project root.
 */
export async function installAdapter(
  projectDir: string,
  opts: InstallOptions = {},
): Promise<InstallResult> {
  const root = resolve(projectDir);
  const templatesDir = findTemplatesDir();
  const force = opts.force ?? false;
  const values: Record<string, string> = {
    MODEL: opts.model ?? DEFAULT_MODEL,
    // The adapter tool reports pipeline position to the model. Substituting the
    // list keeps it from drifting out of step with the controller's own.
    PIPELINE_STAGES: JSON.stringify([...PIPELINE_STAGES], null, 2),
  };

  const installed: string[] = [];
  const skipped: string[] = [];

  log.step(`Installing OpenCode adapter into ${relative(process.cwd(), root) || "."}`);

  for (const rel of listFilesRecursive(templatesDir)) {
    // `opencode.json` is project config, not an `.opencode/` asset.
    const target =
      rel === OPENCODE_CONFIG ? join(root, OPENCODE_CONFIG) : join(root, OPENCODE_DIR, rel);

    const wrote = writeTemplate(join(templatesDir, rel), target, values, force);
    (wrote ? installed : skipped).push(toPosix(relative(root, target)));

    // Mirror agents and commands under their alternate directory name, so the
    // adapter works whichever form this OpenCode build reads.
    const alias = aliasFor(rel);
    if (alias) {
      const aliasTarget = join(root, OPENCODE_DIR, alias);
      const aliasWrote = writeTemplate(join(templatesDir, rel), aliasTarget, values, force);
      (aliasWrote ? installed : skipped).push(toPosix(relative(root, aliasTarget)));
    }
  }

  if (ensureGitignore(root)) {
    log.debug(`Added ${SESSION_IGNORE_LINE} to .gitignore`);
  }

  if (skipped.length > 0) {
    log.warn(`${skipped.length} adapter file(s) already existed and were left unchanged.`);
    log.hint("Re-run with --force to overwrite them.");
  }
  log.success(`Adapter installed (${installed.length} file(s) written).`);

  return { installed, skipped };
}

/** Map a template path onto its alias directory, when it has one. */
function aliasFor(rel: string): string | null {
  const parts = toPosix(rel).split("/");
  const head = parts[0];
  if (!head) return null;
  const alias = DIRECTORY_ALIASES[head];
  if (!alias) return null;
  return [alias, ...parts.slice(1)].join("/");
}

/**
 * True when `projectDir` already carries an adapter installation.
 *
 * The primary agent is the marker: without it OpenCode has no paper-run
 * behaviour at all, so its presence is what "installed" actually means.
 */
export function isAdapterInstalled(projectDir: string): boolean {
  const root = resolve(projectDir);
  return (
    existsSync(join(root, OPENCODE_DIR, "agent", "paper-writer.md")) &&
    existsSync(join(root, OPENCODE_CONFIG))
  );
}

/**
 * Refresh an existing installation to the current package's templates.
 *
 * This is `installAdapter` with `force`, exposed separately so callers state
 * their intent — an upgrade overwrites local edits, and that should be a
 * deliberate word in the calling code rather than a boolean flag.
 */
export async function updateAdapter(
  projectDir: string,
  opts: Omit<InstallOptions, "force"> = {},
): Promise<InstallResult> {
  return installAdapter(projectDir, { ...opts, force: true });
}
