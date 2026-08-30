/**
 * Harness integration: detect the agent-writing-harness template,
 * invoke its scripts, and read paper contracts.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { execa } from "execa";

import { HARNESS, HARNESS_TRUST, CONTRACTS } from "../utils/constants.js";
import type { ContractName } from "../utils/constants.js";
import { HarnessTrustError, MissingDependencyError } from "../utils/errors.js";

// ---------------------------------------------------------------------------
// Template detection
// ---------------------------------------------------------------------------

/** Check if the directory contains a harness-based writing repo. */
export function detectHarness(dir: string): boolean {
  const d = resolve(dir);
  return (
    existsSync(join(d, HARNESS.agentsRouter)) &&
    existsSync(join(d, HARNESS.verifyScript))
  );
}

/** Read template version from .agents/template-origin.json. */
export function getTemplateVersion(dir: string): string | null {
  const path = join(resolve(dir), HARNESS.templateOrigin);
  if (!existsSync(path)) return null;

  try {
    const data = JSON.parse(readFileSync(path, "utf-8"));
    // The file has template_repository which may contain version info.
    return data.template_repository ?? null;
  } catch {
    return null;
  }
}

/**
 * Validate that the harness's key files are present.
 * Returns a list of missing paths (empty = all good).
 */
export function validateHarnessIntegrity(dir: string): string[] {
  const d = resolve(dir);
  const required = [
    HARNESS.agentsRouter,
    HARNESS.toolsDir,
    HARNESS.skillsDir,
    HARNESS.verifyScript,
  ];

  return required.filter((rel) => !existsSync(join(d, rel)));
}

// ---------------------------------------------------------------------------
// Script execution
// ---------------------------------------------------------------------------

export interface CheckResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  passed: boolean;
  scriptName: string;
}

const DEFAULT_TIMEOUT_MS = 60_000;

interface HarnessTrustManifest {
  schema_version: string;
  template_version: string;
  repository_id: string;
  worktree_git_dir: string;
  project_root: string;
  root_device: number;
  root_inode: number;
  files: Array<{ path: string; sha256: string }>;
}

/** Establish local provenance once, during init, before any fetched script runs. */
export async function initializeHarnessTrust(dir: string, templateVersion: string): Promise<void> {
  const identity = await readGitIdentity(dir);
  const trustDir = join(identity.commonDir, HARNESS_TRUST.directory);
  const manifestPath = manifestFile(trustDir, identity.worktreeGitDir);
  if (existsSync(manifestPath)) {
    throw new HarnessTrustError("trust metadata already exists for this worktree");
  }

  const repositoryIdPath = join(identity.commonDir, HARNESS_TRUST.repositoryIdFile);
  if (!existsSync(repositoryIdPath)) {
    try {
      writeFileSync(repositoryIdPath, `${randomUUID()}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    } catch (err) {
      if (!existsSync(repositoryIdPath)) throw err;
    }
  }
  const repositoryId = readRepositoryId(repositoryIdPath);
  const rootStat = statSync(identity.root);
  const files = collectTrustedTools(identity.root);
  const manifest: HarnessTrustManifest = {
    schema_version: HARNESS_TRUST.schemaVersion,
    template_version: templateVersion,
    repository_id: repositoryId,
    worktree_git_dir: identity.worktreeGitDir,
    project_root: identity.root,
    root_device: rootStat.dev,
    root_inode: rootStat.ino,
    files,
  };

  mkdirSync(trustDir, { recursive: true, mode: 0o700 });
  const temporary = join(trustDir, `.${randomUUID()}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, manifestPath);
}

/** Run a single check script from .agents/tools/. */
export async function runCheck(
  dir: string,
  script: string,
  args: string[] = [],
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<CheckResult> {
  const d = resolve(dir);
  let scriptPath: string;
  try {
    scriptPath = await verifyTrustedHarnessScript(d, join(HARNESS.toolsDir, script));
  } catch (err) {
    return {
      exitCode: 126,
      stdout: "",
      stderr: trustMessage(err),
      passed: false,
      scriptName: script,
    };
  }

  await ensurePython();

  try {
    const result = await execa("python3", [scriptPath, ...args], {
      cwd: d,
      timeout: timeoutMs,
      reject: false,
    });

    return {
      exitCode: result.exitCode ?? 1,
      stdout: "",
      stderr: result.exitCode === 0 ? "" : `${script} exited with code ${result.exitCode ?? 1}`,
      passed: result.exitCode === 0,
      scriptName: script,
    };
  } catch {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `${script} could not be executed`,
      passed: false,
      scriptName: script,
    };
  }
}

export interface VerifyResult {
  passed: boolean;
  checks: CheckResult[];
  summary: string;
}

/** Run the master verification script (verify.sh). */
export async function runVerify(dir: string, timeoutMs = 120_000): Promise<VerifyResult> {
  const d = resolve(dir);
  let script: string;
  try {
    script = await verifyTrustedHarnessScript(d, HARNESS.verifyScript);
  } catch (err) {
    return {
      passed: false,
      checks: [],
      summary: trustMessage(err),
    };
  }

  try {
    const result = await execa("bash", [script], {
      cwd: d,
      timeout: timeoutMs,
      reject: false,
    });

    const passed = result.exitCode === 0;
    return {
      passed,
      checks: [
        {
          exitCode: result.exitCode ?? 1,
          stdout: "",
          stderr: passed ? "" : `verify.sh exited with code ${result.exitCode ?? 1}`,
          passed,
          scriptName: "verify.sh",
        },
      ],
      summary: passed ? "All checks passed" : `verify.sh exited with code ${result.exitCode}`,
    };
  } catch {
    return {
      passed: false,
      checks: [],
      summary: "verify.sh could not be executed",
    };
  }
}

/** Run paper-init.py with a subcommand: status | record-template-origin | clean. */
export async function runPaperInit(
  dir: string,
  subcommand: "status" | "record-template-origin" | "clean",
  opts: { commit?: boolean } = {},
): Promise<void> {
  const d = resolve(dir);
  const script = await verifyTrustedHarnessScript(d, HARNESS.paperInit);

  await ensurePython();

  const args = [script, subcommand];
  if (opts.commit) args.push("--commit");

  await execa("python3", args, { cwd: d });
}

/**
 * Validate a brief before ingesting it.
 *
 * Checks the brief has the required sections and a valid operating mode.
 * Runs against the source path, so it works before the writing repo exists.
 */
export async function runBriefValidate(
  dir: string,
  briefPath: string,
): Promise<CheckResult> {
  const d = resolve(dir);
  const script = await verifyTrustedHarnessScript(d, HARNESS.paperBrief);

  await ensurePython();

  const result = await execa("python3", [script, "validate", "--brief", briefPath], {
    cwd: d,
    reject: false,
  });

  return {
    exitCode: result.exitCode ?? 1,
    stdout: "",
    stderr:
      result.exitCode === 0
        ? ""
        : `paper-brief.py validate exited with code ${result.exitCode ?? 1}`,
    passed: result.exitCode === 0,
    scriptName: "paper-brief.py validate",
  };
}

/**
 * Ingest a brief into an initialized writing repository.
 *
 * The harness copies it to BRIEF.md and fills only the decided PAPER.md fields
 * that have a recognized target — it never invents a title, claim, venue, or
 * author, and leaves anything undecided as unresolved.
 */
export async function runBriefIngest(
  dir: string,
  briefPath: string,
  opts: { commit?: boolean } = {},
): Promise<void> {
  const d = resolve(dir);
  const script = await verifyTrustedHarnessScript(d, HARNESS.paperBrief);

  await ensurePython();

  const args = [script, "ingest", "--brief", briefPath];
  if (opts.commit) args.push("--commit");

  await execa("python3", args, { cwd: d });
}

// ---------------------------------------------------------------------------
// Contract reading
// ---------------------------------------------------------------------------

/** Read the full text of a paper contract file. */
export function readContract(dir: string, name: ContractName): string | null {
  const path = join(resolve(dir), CONTRACTS[name]);
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf-8");
}

/**
 * Extract the operating mode from PAPER.md.
 * Looks for `Mode: <value>` under `## Operating mode`.
 */
export function extractMode(paperMd: string): "autonomous" | "collaborative" | "unresolved" {
  const match = paperMd.match(/Mode:\s*(autonomous|collaborative|unresolved)/i);
  if (!match) return "unresolved";
  return match[1]!.toLowerCase() as "autonomous" | "collaborative" | "unresolved";
}

/**
 * Extract collaboration cues from contract sections.
 * Each section that contains a cue keyword gets recorded.
 */
export function extractCollaborationCues(
  paperMd: string,
): Record<string, "locked" | "bounded" | "free" | "unresolved"> {
  const cues: Record<string, "locked" | "bounded" | "free" | "unresolved"> = {};
  const sectionPattern = /^##\s+(.+)$/gm;
  const cuePattern = /\b(locked|bounded|free|unresolved)\b/i;

  let match: RegExpExecArray | null;
  const sections: Array<{ heading: string; start: number }> = [];

  while ((match = sectionPattern.exec(paperMd)) !== null) {
    sections.push({ heading: match[1]!.trim(), start: match.index });
  }

  for (let i = 0; i < sections.length; i++) {
    const section = sections[i]!;
    const end = i + 1 < sections.length ? sections[i + 1]!.start : paperMd.length;
    const content = paperMd.slice(section.start, end);
    const cueMatch = cuePattern.exec(content);
    if (cueMatch) {
      cues[section.heading] = cueMatch[1]!.toLowerCase() as "locked" | "bounded" | "free" | "unresolved";
    }
  }

  return cues;
}

// ---------------------------------------------------------------------------
// Python availability check
// ---------------------------------------------------------------------------

let pythonChecked = false;

async function verifyTrustedHarnessScript(dir: string, projectPath: string): Promise<string> {
  try {
    return await verifyTrustedHarnessScriptUnchecked(dir, projectPath);
  } catch (err) {
    if (err instanceof HarnessTrustError) throw err;
    throw new HarnessTrustError("trust verification failed");
  }
}

async function verifyTrustedHarnessScriptUnchecked(dir: string, projectPath: string): Promise<string> {
  const identity = await readGitIdentity(dir);
  const rootStat = statSync(identity.root);
  const trustDir = join(identity.commonDir, HARNESS_TRUST.directory);
  const manifestPath = manifestFile(trustDir, identity.worktreeGitDir);
  const repositoryIdPath = join(identity.commonDir, HARNESS_TRUST.repositoryIdFile);

  let manifest: HarnessTrustManifest;
  try {
    const parsed: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (!isHarnessTrustManifest(parsed)) throw new Error("invalid manifest");
    manifest = parsed;
  } catch {
    throw new HarnessTrustError("local trust manifest is missing or invalid");
  }

  if (
    manifest.repository_id !== readRepositoryId(repositoryIdPath) ||
    manifest.worktree_git_dir !== identity.worktreeGitDir ||
    manifest.root_device !== rootStat.dev ||
    manifest.root_inode !== rootStat.ino
  ) {
    throw new HarnessTrustError("local trust manifest does not match this repository worktree");
  }

  const tools = resolve(identity.root, HARNESS.toolsDir);
  const candidate = resolve(identity.root, projectPath);
  const withinTools = relative(tools, candidate);
  if (withinTools === "" || withinTools.startsWith(`..${sep}`) || withinTools === ".." || isAbsolute(withinTools)) {
    throw new HarnessTrustError("requested path is outside the trusted tools directory");
  }

  assertRegularUnsymlinkedPath(tools, candidate);
  if (!isContained(realpathSync(identity.root), realpathSync(candidate))) {
    throw new HarnessTrustError("requested path escapes the repository");
  }

  const relativePath = relative(identity.root, candidate).split(sep).join("/");
  const entry = manifest.files.find((file) => file.path === relativePath);
  if (!entry || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
    throw new HarnessTrustError("requested path is not in the local trust manifest");
  }
  if (sha256File(candidate) !== entry.sha256) {
    throw new HarnessTrustError("trusted harness script has changed");
  }
  return candidate;
}

async function readGitIdentity(dir: string): Promise<{
  root: string;
  commonDir: string;
  worktreeGitDir: string;
}> {
  try {
    const rootResult = await execa("git", ["rev-parse", "--show-toplevel"], { cwd: dir });
    const root = realpathSync(resolve(dir, rootResult.stdout.trim()));
    if (realpathSync(resolve(dir)) !== root) {
      throw new HarnessTrustError("script execution must use the repository root");
    }
    const [commonResult, gitDirResult] = await Promise.all([
      execa("git", ["rev-parse", "--git-common-dir"], { cwd: root }),
      execa("git", ["rev-parse", "--git-dir"], { cwd: root }),
    ]);
    const commonDir = realpathSync(resolve(root, commonResult.stdout.trim()));
    const gitDir = realpathSync(resolve(root, gitDirResult.stdout.trim()));
    const worktreeGitDir = relative(commonDir, gitDir) || ".";
    if (worktreeGitDir === ".." || worktreeGitDir.startsWith(`..${sep}`) || isAbsolute(worktreeGitDir)) {
      throw new HarnessTrustError("Git worktree metadata is outside the common directory");
    }
    return { root, commonDir, worktreeGitDir: worktreeGitDir.split(sep).join("/") };
  } catch (err) {
    if (err instanceof HarnessTrustError) throw err;
    throw new HarnessTrustError("repository identity could not be verified");
  }
}

function collectTrustedTools(root: string): Array<{ path: string; sha256: string }> {
  const tools = resolve(root, HARNESS.toolsDir);
  assertUnsymlinkedDirectoryPath(root, tools);
  if (!isContained(realpathSync(root), realpathSync(tools))) {
    throw new HarnessTrustError("harness tools directory escapes the repository");
  }

  const files: Array<{ path: string; sha256: string }> = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new HarnessTrustError("harness tools cannot contain symlinks");
      if (stat.isDirectory()) {
        visit(path);
      } else if (stat.isFile()) {
        files.push({ path: relative(root, path).split(sep).join("/"), sha256: sha256File(path) });
      } else {
        throw new HarnessTrustError("harness tools cannot contain non-regular files");
      }
    }
  };
  visit(tools);
  return files;
}

function assertRegularUnsymlinkedPath(tools: string, candidate: string): void {
  const root = resolve(tools, "..", "..");
  assertUnsymlinkedDirectoryPath(root, tools);
  let current = tools;
  for (const part of relative(tools, candidate).split(sep)) {
    current = join(current, part);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw new HarnessTrustError("harness script path contains a symlink");
    if (current === candidate && !stat.isFile()) {
      throw new HarnessTrustError("harness script is not a regular file");
    }
  }
}

function assertUnsymlinkedDirectoryPath(root: string, directory: string): void {
  let current = root;
  for (const part of relative(root, directory).split(sep)) {
    current = join(current, part);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new HarnessTrustError("harness tools directory must be a real unsymlinked directory");
    }
  }
}

function manifestFile(trustDir: string, worktreeGitDir: string): string {
  return join(trustDir, `${createHash("sha256").update(worktreeGitDir).digest("hex")}.json`);
}

function isHarnessTrustManifest(value: unknown): value is HarnessTrustManifest {
  if (!value || typeof value !== "object") return false;
  const manifest = value as Partial<HarnessTrustManifest>;
  if (
    manifest.schema_version !== HARNESS_TRUST.schemaVersion ||
    typeof manifest.template_version !== "string" ||
    manifest.template_version.length === 0 ||
    typeof manifest.repository_id !== "string" ||
    typeof manifest.worktree_git_dir !== "string" ||
    typeof manifest.project_root !== "string" ||
    !isAbsolute(manifest.project_root) ||
    typeof manifest.root_device !== "number" ||
    typeof manifest.root_inode !== "number" ||
    !Array.isArray(manifest.files)
  ) {
    return false;
  }
  const paths = new Set<string>();
  for (const file of manifest.files) {
    if (
      !file ||
      typeof file.path !== "string" ||
      !file.path.startsWith(`${HARNESS.toolsDir}/`) ||
      paths.has(file.path) ||
      typeof file.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(file.sha256)
    ) {
      return false;
    }
    paths.add(file.path);
  }
  return true;
}

function readRepositoryId(path: string): string {
  try {
    const value = readFileSync(path, "utf8").trim();
    if (!/^[0-9a-f-]{36}$/i.test(value)) throw new Error("invalid repository id");
    return value;
  } catch {
    throw new HarnessTrustError("local repository identity is missing or invalid");
  }
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function isContained(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function trustMessage(err: unknown): string {
  return err instanceof HarnessTrustError
    ? err.message
    : "Refusing to execute an untrusted harness script: trust verification failed";
}

async function ensurePython(): Promise<void> {
  if (pythonChecked) return;

  try {
    await execa("python3", ["--version"]);
    pythonChecked = true;
  } catch {
    throw new MissingDependencyError(
      "python3",
      "Python 3.10+ is required to run harness validation scripts.\n  Install: https://www.python.org/downloads/ or `apt install python3`",
    );
  }
}
