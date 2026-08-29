/**
 * Harness integration: detect the agent-writing-harness template,
 * invoke its scripts, and read paper contracts.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { execa } from "execa";

import { HARNESS, CONTRACTS } from "../utils/constants.js";
import type { ContractName } from "../utils/constants.js";
import { MissingDependencyError } from "../utils/errors.js";

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

/** Run a single check script from .agents/tools/. */
export async function runCheck(
  dir: string,
  script: string,
  args: string[] = [],
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<CheckResult> {
  const d = resolve(dir);
  const scriptPath = join(d, HARNESS.toolsDir, script);

  if (!existsSync(scriptPath)) {
    return {
      exitCode: 127,
      stdout: "",
      stderr: `Script not found: ${scriptPath}`,
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
      stdout: result.stdout,
      stderr: result.stderr,
      passed: result.exitCode === 0,
      scriptName: script,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      exitCode: 1,
      stdout: "",
      stderr: msg,
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
  const script = join(d, HARNESS.verifyScript);

  if (!existsSync(script)) {
    return {
      passed: false,
      checks: [],
      summary: `verify.sh not found at ${script}`,
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
          stdout: result.stdout,
          stderr: result.stderr,
          passed,
          scriptName: "verify.sh",
        },
      ],
      summary: passed ? "All checks passed" : `verify.sh exited with code ${result.exitCode}`,
    };
  } catch (err: unknown) {
    return {
      passed: false,
      checks: [],
      summary: err instanceof Error ? err.message : String(err),
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
  const script = join(d, HARNESS.paperInit);

  if (!existsSync(script)) {
    throw new MissingDependencyError(
      HARNESS.paperInit,
      "The harness template was not properly initialized. Try re-running paper-run init.",
    );
  }

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
  const script = join(d, HARNESS.paperBrief);

  if (!existsSync(script)) {
    throw new MissingDependencyError(
      HARNESS.paperBrief,
      "paper-brief.py not found. The harness template may be incomplete.",
    );
  }

  await ensurePython();

  const result = await execa("python3", [script, "validate", "--brief", briefPath], {
    cwd: d,
    reject: false,
  });

  return {
    exitCode: result.exitCode ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
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
  const script = join(d, HARNESS.paperBrief);

  if (!existsSync(script)) {
    throw new MissingDependencyError(
      HARNESS.paperBrief,
      "paper-brief.py not found. The harness template may be incomplete.",
    );
  }

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
