/**
 * Running a stage's validators.
 *
 * This is the mechanism that makes stage completion a fact rather than a claim.
 * The controller never reads the agent's prose for a "done" signal; it comes
 * here and checks the repository.
 *
 * Validators are split into required and optional. A failed optional check is
 * reported and recorded but does not block — useful for checks that are
 * advisory (BibTeX formatting) or that depend on tooling the user may not have
 * installed. A failed required check sends the stage back for remediation.
 */

import { closeSync, existsSync, lstatSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, join, posix, resolve, win32 } from "node:path";

import { runCheck } from "../harness/harness.js";
import { PAPER_RUN_DIR } from "../utils/constants.js";
import { log } from "../utils/logger.js";

import type { Stage, Validator } from "./stages.js";

export interface CheckOutcome {
  name: string;
  passed: boolean;
  required: boolean;
  message?: string;
}

export interface ValidationResult {
  /** True when every *required* check passed. */
  passed: boolean;
  checks: CheckOutcome[];
  /** Messages for the required checks that failed, for the remediation prompt. */
  failures: string[];
}

export type PublicationBaseline = Readonly<Record<string, string | null>>;

export interface ValidationOptions {
  publicationBaseline?: PublicationBaseline;
}

/** Run every validator for a stage. */
export async function validateStage(
  stage: Stage,
  projectDir: string,
  options: ValidationOptions = {},
): Promise<ValidationResult> {
  const checks: CheckOutcome[] = [];

  for (const validator of stage.validators) {
    if (
      validator.type === "publication_build" &&
      checks.some((check) => check.required && !check.passed)
    ) {
      checks.push({
        name: "publication-build",
        passed: false,
        required: validator.required,
        message: "Publication build skipped because a required validator failed",
      });
      continue;
    }
    const outcome = await runValidator(validator, projectDir, options);
    checks.push(outcome);

    if (!outcome.passed) {
      const level = outcome.required ? "required" : "optional";
      log.debug(`validator failed (${level}): ${outcome.name} — ${outcome.message ?? ""}`);
    }
  }

  const failures = checks
    .filter((c) => c.required && !c.passed)
    .map((c) => c.message ?? c.name);

  return { passed: failures.length === 0, checks, failures };
}

async function runValidator(
  validator: Validator,
  projectDir: string,
  options: ValidationOptions,
): Promise<CheckOutcome> {
  switch (validator.type) {
    case "check_script": {
      const result = await runCheck(projectDir, validator.script, validator.args ?? []);
      return {
        name: validator.script,
        passed: result.passed,
        required: validator.required,
        message: result.passed
          ? undefined
          : `${validator.message} (${validator.script} exited with code ${result.exitCode})`,
      };
    }

    case "file_exists": {
      const path = join(resolve(projectDir), validator.path);
      const exists = existsSync(path);
      const bigEnough =
        exists && validator.minBytes !== undefined
          ? statSync(path).size >= validator.minBytes
          : exists;

      return {
        name: `file:${validator.path}`,
        passed: bigEnough,
        required: validator.required,
        message: bigEnough ? undefined : validator.message,
      };
    }

    case "contract_section": {
      const path = join(resolve(projectDir), validator.contract);
      const passed = existsSync(path) && hasNonEmptySection(readFileSync(path, "utf-8"), validator.heading);

      return {
        name: `${validator.contract}${validator.heading}`,
        passed,
        required: validator.required,
        message: passed ? undefined : validator.message,
      };
    }

    case "dir_has_content": {
      const dir = join(resolve(projectDir), validator.dir);
      const passed = dirHasContent(dir, validator.extension, validator.minBytes ?? 1);

      return {
        name: `dir:${validator.dir}`,
        passed,
        required: validator.required,
        message: passed ? undefined : validator.message,
      };
    }

    case "state_file": {
      const path = join(resolve(projectDir), PAPER_RUN_DIR, validator.file);
      let passed = existsSync(path);
      if (passed) {
        try {
          JSON.parse(readFileSync(path, "utf-8"));
        } catch {
          passed = false;
        }
      }

      return {
        name: `state:${validator.file}`,
        passed,
        required: validator.required,
        message: passed ? undefined : validator.message,
      };
    }

    case "publication_build": {
      const result = validatePublicationArtifacts(projectDir, options.publicationBaseline);
      return {
        name: "publication-build",
        passed: result.passed,
        required: validator.required,
        message: result.passed ? undefined : `${validator.message}: ${result.diagnostic}`,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * True when a markdown heading exists and has substantive content under it.
 *
 * "Substantive" excludes the harness's own placeholder text: a template
 * section that still says `TODO` has not been filled in, and treating it as
 * done would let an empty contract pass validation.
 */
export function hasNonEmptySection(markdown: string, heading: string): boolean {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line.trim() === heading.trim());
  if (start === -1) return false;

  const headingLevel = (heading.match(/^#+/) ?? ["#"])[0].length;

  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();

    // Stop at the next heading of the same or higher level.
    const match = trimmed.match(/^(#+)\s/);
    if (match && match[1] && match[1].length <= headingLevel) break;

    if (trimmed === "") continue;
    // Bare placeholders do not count as content.
    if (/^(TODO|TBD|_?\(?to be (written|filled|decided)\)?_?)\.?$/i.test(trimmed)) continue;
    if (/^<!--.*-->$/.test(trimmed)) continue;

    return true;
  }

  return false;
}

/** True when a directory contains at least one file meeting the size bar. */
function dirHasContent(dir: string, extension: string | undefined, minBytes: number): boolean {
  if (!existsSync(dir)) return false;

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return false;
  }

  return entries.some((entry) => {
    if (extension && !entry.endsWith(extension)) return false;
    const path = join(dir, entry);
    try {
      const stat = statSync(path);
      return stat.isFile() && stat.size >= minBytes;
    } catch {
      return false;
    }
  });
}

interface BuildCommand {
  name: string;
  command: string[];
  output: string;
}

interface BuildProfile {
  sourceRoot: string;
  entrypoint: string;
  bibliography: string | null;
  builds: BuildCommand[];
}

const BUILD_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const VARIANT_RE = /^VARIANT=[a-z0-9][a-z0-9._-]{0,63}$/;
const PROFILE_SCHEMA = "paper-build-profile-v1";
const PROFILE_LAYOUTS = new Set(["canonical-variants", "external-latex"]);
const CONTROL_ROOTS = new Set([".agents", ".git", ".paper-run", "dist", "release", "releases"]);
const CANONICAL_BUILDS: BuildCommand[] = [
  { name: "draft", command: ["make", "pdf", "VARIANT=draft"], output: "paper/main.pdf" },
  {
    name: "anonymous",
    command: ["make", "pdf", "VARIANT=anonymous"],
    output: "paper/main-anonymous.pdf",
  },
  {
    name: "camera-ready",
    command: ["make", "pdf", "VARIANT=camera-ready"],
    output: "paper/main-camera-ready.pdf",
  },
  { name: "arxiv", command: ["make", "pdf", "VARIANT=arxiv"], output: "paper/main-arxiv.pdf" },
];

const FALLBACK_PROFILE: BuildProfile = {
  sourceRoot: "paper",
  entrypoint: "paper/main.tex",
  bibliography: "paper/refs.bib",
  builds: [{ name: "pdf", command: ["make", "pdf"], output: "paper/main.pdf" }],
};

/** Validate declared build artifacts without executing repository-controlled code. */
function validatePublicationArtifacts(
  projectDir: string,
  baseline?: PublicationBaseline,
): { passed: boolean; diagnostic: string } {
  const root = resolve(projectDir);
  const profilePath = join(root, ".agents", "paper-build.json");
  let profile = FALLBACK_PROFILE;
  const profileStat = lstatSync(profilePath, { throwIfNoEntry: false });

  if (profileStat) {
    try {
      if (profileStat.isSymbolicLink() || !profileStat.isFile()) {
        throw new Error("profile must be a regular file");
      }
      profile = parseBuildProfile(JSON.parse(readFileSync(profilePath, "utf-8")));
    } catch (err) {
      return {
        passed: false,
        diagnostic: `invalid .agents/paper-build.json (${safeErrorMessage(err)})`,
      };
    }
  }

  try {
    const newestSource = newestSourceMtime(root, profile);
    for (const build of profile.builds) {
      if (!build.output.endsWith(".pdf")) {
        return { passed: false, diagnostic: `[${build.name}] output must be a .pdf file` };
      }
      const artifact = inspectRegularFile(root, build.output);
      if (artifact === null || artifact.size === 0n) {
        return { passed: false, diagnostic: `[${build.name}] output is missing or empty` };
      }
      if (artifact.mtimeNs < newestSource) {
        return { passed: false, diagnostic: `[${build.name}] output is stale` };
      }
      if (!hasBasicPdfStructure(join(root, build.output), artifact.size)) {
        return { passed: false, diagnostic: `[${build.name}] output is not a structurally valid PDF` };
      }
      if (baseline) {
        if (!Object.prototype.hasOwnProperty.call(baseline, build.output)) {
          return { passed: false, diagnostic: `[${build.name}] output declaration changed during this stage` };
        }
        if (baseline[build.output] === digestFile(join(root, build.output))) {
          return { passed: false, diagnostic: `[${build.name}] output was not rebuilt during this stage` };
        }
      }
    }
  } catch (err) {
    return { passed: false, diagnostic: safeErrorMessage(err) };
  }

  return { passed: true, diagnostic: "" };
}

/** Capture configured artifact digests before an agent turn. */
export function capturePublicationBaseline(projectDir: string): PublicationBaseline {
  const root = resolve(projectDir);
  const profilePath = join(root, ".agents", "paper-build.json");
  const profileStat = lstatSync(profilePath, { throwIfNoEntry: false });
  let profile = FALLBACK_PROFILE;
  if (profileStat) {
    if (profileStat.isSymbolicLink() || !profileStat.isFile()) {
      throw new Error("invalid .agents/paper-build.json (profile must be a regular file)");
    }
    profile = parseBuildProfile(JSON.parse(readFileSync(profilePath, "utf-8")));
  }

  const baseline: Record<string, string | null> = {};
  for (const build of profile.builds) {
    const artifact = inspectRegularFile(root, build.output);
    baseline[build.output] = artifact ? digestFile(join(root, build.output)) : null;
  }
  return Object.freeze(baseline);
}

function parseBuildProfile(value: unknown): BuildProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("profile must be an object");
  }
  const profile = value as Record<string, unknown>;
  requireExactKeys(profile, [
    "schema_version",
    "layout",
    "source_root",
    "entrypoint",
    "bibliography",
    "builds",
  ], "profile");
  if (profile["schema_version"] !== PROFILE_SCHEMA) {
    throw new Error("unsupported schema_version");
  }
  if (typeof profile["layout"] !== "string" || !PROFILE_LAYOUTS.has(profile["layout"])) {
    throw new Error("layout is invalid");
  }

  const sourceRoot = parseSafePath(profile["source_root"], "source_root", true);
  const entrypoint = parseSafePath(profile["entrypoint"], "entrypoint");
  if (!entrypoint.toLowerCase().endsWith(".tex") || !pathIsWithin(sourceRoot, entrypoint)) {
    throw new Error("entrypoint must be a .tex file inside source_root");
  }
  const bibliography =
    profile["bibliography"] === null || profile["bibliography"] === undefined
      ? null
      : parseSafePath(profile["bibliography"], "bibliography");
  if (
    bibliography !== null &&
    (!bibliography.toLowerCase().endsWith(".bib") || !pathIsWithin(sourceRoot, bibliography))
  ) {
    throw new Error("bibliography must be a .bib file inside source_root");
  }
  for (const [label, path] of [
    ["source_root", sourceRoot],
    ["entrypoint", entrypoint],
    ["bibliography", bibliography],
  ] as const) {
    if (path !== null && CONTROL_ROOTS.has(posix.parse(path).dir.split("/")[0] || path)) {
      throw new Error(`${label} must not use a generated or control directory`);
    }
  }

  if (!Array.isArray(profile["builds"]) || profile["builds"].length === 0) {
    throw new Error("builds must be a non-empty array");
  }
  const builds = profile["builds"].map((build, index) => parseBuildCommand(build, index));
  if (new Set(builds.map((build) => build.name)).size !== builds.length) {
    throw new Error("build names must be unique");
  }
  const outputs = builds.map((build) => build.output);
  if (new Set(outputs).size !== outputs.length) throw new Error("build outputs must be unique");
  for (const output of outputs) {
    if (
      output === entrypoint ||
      output === bibliography ||
      CONTROL_ROOTS.has(output.split("/")[0] ?? "")
    ) {
      throw new Error(`build output collides with a protected path: ${output}`);
    }
  }

  if (profile["layout"] === "canonical-variants") {
    if (
      sourceRoot !== "paper" ||
      entrypoint !== "paper/main.tex" ||
      bibliography !== "paper/refs.bib" ||
      JSON.stringify(builds) !== JSON.stringify(CANONICAL_BUILDS)
    ) {
      throw new Error("canonical-variants profile must use the standard declarations");
    }
  }
  return { sourceRoot, entrypoint, bibliography, builds };
}

function parseBuildCommand(value: unknown, index: number): BuildCommand {
  if (!value || typeof value !== "object") throw new Error(`builds[${index}] must be an object`);
  const build = value as Record<string, unknown>;
  requireExactKeys(build, ["name", "command", "output"], `builds[${index}]`);
  if (typeof build["name"] !== "string" || !BUILD_NAME_RE.test(build["name"])) {
    throw new Error(`builds[${index}].name is invalid`);
  }
  if (
    !Array.isArray(build["command"]) ||
    (build["command"].length !== 2 && build["command"].length !== 3) ||
    build["command"][0] !== "make" ||
    build["command"][1] !== "pdf" ||
    (build["command"].length === 3 &&
      (typeof build["command"][2] !== "string" || !VARIANT_RE.test(build["command"][2])))
  ) {
    throw new Error(`builds[${index}].command must be make pdf with an optional VARIANT assignment`);
  }
  const output = parseSafePath(build["output"], `builds[${index}].output`);

  return {
    name: build["name"],
    command: build["command"] as string[],
    output,
  };
}

function parseSafePath(value: unknown, label: string, allowDot = false): string {
  if (typeof value !== "string" || value.trim() === "" || value.includes("\0")) {
    throw new Error(`${label} must be a non-empty relative path`);
  }
  if (value.includes("\\") || isAbsolute(value) || win32.isAbsolute(value)) {
    throw new Error(`${label} must be a safe repository-relative path`);
  }
  const normalized = posix.normalize(value);
  if (value.split("/").includes("..") || normalized.startsWith("../") || (!allowDot && normalized === ".")) {
    throw new Error(`${label} must be a safe repository-relative path`);
  }
  return normalized;
}

function pathIsWithin(parent: string, child: string): boolean {
  return parent === "." || child === parent || child.startsWith(`${parent}/`);
}

function requireExactKeys(value: Record<string, unknown>, keys: string[], label: string): void {
  const expected = new Set(keys);
  const unknown = Object.keys(value).find((key) => !expected.has(key));
  if (unknown) throw new Error(`${label} contains unknown field ${unknown}`);
  const missing = keys.find((key) => !(key in value));
  if (missing) throw new Error(`${label} is missing ${missing}`);
}

/** Return regular-file metadata, rejecting every symlink in the path. */
function inspectRegularFile(
  root: string,
  relativePath: string,
): { size: bigint; mtimeNs: bigint } | null {
  let current = root;
  for (const part of relativePath.split("/")) {
    current = join(current, part);
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (!stat) return null;
    if (stat?.isSymbolicLink()) {
      throw new Error("declared path traverses a symlink");
    }
  }
  const stat = statSync(current, { bigint: true });
  return stat.isFile() ? { size: stat.size, mtimeNs: stat.mtimeNs } : null;
}

function digestFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function hasBasicPdfStructure(path: string, size: bigint): boolean {
  if (size < 11n || size > BigInt(Number.MAX_SAFE_INTEGER)) return false;
  const fd = openSync(path, "r");
  try {
    const header = Buffer.alloc(5);
    if (readSync(fd, header, 0, header.length, 0) !== header.length || header.toString() !== "%PDF-") {
      return false;
    }
    const tailLength = Math.min(Number(size), 1024);
    const tail = Buffer.alloc(tailLength);
    readSync(fd, tail, 0, tailLength, Number(size) - tailLength);
    return /%%EOF\s*$/.test(tail.toString("latin1"));
  } finally {
    closeSync(fd);
  }
}

function newestSourceMtime(root: string, profile: BuildProfile): bigint {
  const sourceRoot = join(root, profile.sourceRoot);
  assertPathHasNoSymlinks(root, profile.sourceRoot);
  const sourceStat = statSync(sourceRoot, { bigint: true, throwIfNoEntry: false });
  if (!sourceStat?.isDirectory()) throw new Error("source_root is missing or not a directory");

  const outputs = new Set(profile.builds.map((build) => join(root, build.output)));
  let newest = 0n;
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (outputs.has(path)) continue;
      const stat = lstatSync(path, { bigint: true });
      if (entry.isDirectory()) visit(path);
      else if (stat.mtimeNs > newest) newest = stat.mtimeNs;
    }
  };
  visit(sourceRoot);

  for (const [label, path] of [
    ["entrypoint", profile.entrypoint],
    ["bibliography", profile.bibliography],
  ] as const) {
    if (path === null) continue;
    const stat = inspectRegularFile(root, path);
    if (!stat) throw new Error(`${label} is missing or not a regular file`);
    if (stat.mtimeNs > newest) newest = stat.mtimeNs;
  }
  return newest;
}

function assertPathHasNoSymlinks(root: string, relativePath: string): void {
  let current = root;
  for (const part of relativePath.split("/")) {
    current = join(current, part);
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (!stat) return;
    if (stat.isSymbolicLink()) throw new Error("declared path traverses a symlink");
  }
}

function safeErrorMessage(err: unknown): string {
  if (!(err instanceof Error)) return "publication artifact check failed";
  return err.message.slice(0, 240).replace(/[\r\n\t]/g, " ");
}
