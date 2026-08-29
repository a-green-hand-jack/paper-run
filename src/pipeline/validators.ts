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

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

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

/** Run every validator for a stage. */
export async function validateStage(
  stage: Stage,
  projectDir: string,
): Promise<ValidationResult> {
  const checks: CheckOutcome[] = [];

  for (const validator of stage.validators) {
    const outcome = await runValidator(validator, projectDir);
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
): Promise<CheckOutcome> {
  switch (validator.type) {
    case "check_script": {
      const result = await runCheck(projectDir, validator.script, validator.args ?? []);
      return {
        name: validator.script,
        passed: result.passed,
        required: validator.required,
        // Prefer the script's own output: it is far more specific than our
        // generic message, and it is what the agent needs in order to fix it.
        message: result.passed
          ? undefined
          : `${validator.message}${formatScriptOutput(result.stdout, result.stderr)}`,
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

/** Trim script output down to something worth putting in a prompt. */
function formatScriptOutput(stdout: string, stderr: string): string {
  const raw = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
  if (!raw) return "";

  const MAX_LINES = 20;
  const lines = raw.split("\n");
  const shown = lines.slice(0, MAX_LINES);
  if (lines.length > MAX_LINES) shown.push(`… ${lines.length - MAX_LINES} more line(s)`);

  return `\n${shown.join("\n")}`;
}
