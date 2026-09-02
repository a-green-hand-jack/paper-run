/**
 * Recording the inputs a run was given, before it can write over them.
 *
 * Supplied materials are evidence, not workspace. The distinction only became
 * visible when a remediation turn, told that the reference-integrity check had
 * failed, added the marker the checker wanted to `paper/refs.bib` — a file the
 * task had declared read-only. It took the shortest path to a satisfied
 * validator, which happened to run through the evidence.
 *
 * A validator can only notice that if something wrote down what the evidence
 * looked like first. That is all this does: digest the inputs at bootstrap,
 * before any stage has had the chance to be helpful.
 */

import { createHash } from "node:crypto";
import { constants, accessSync, existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { discoverMaterials } from "./material-assessment.js";
import type { InputBaseline } from "../state/schema.js";

/** Files that are inputs by definition, whatever else is discovered. */
const ALWAYS_INPUTS = ["BRIEF.md"];

/**
 * Digest every supplied input this run must not alter.
 *
 * The bibliography is included only when it looks supplied rather than
 * curated: byte-identical to a copy under `materials/`, or not writable by its
 * owner. A paper whose agent legitimately maintains its own bibliography keeps
 * that freedom — locking it unconditionally would break the ordinary case to
 * fix the benchmark one.
 */
export function captureInputBaseline(projectDir: string): InputBaseline {
  const root = resolve(projectDir);
  const files: Record<string, string> = {};

  const record = (relative: string): void => {
    const path = join(root, relative);
    if (!existsSync(path)) return;
    try {
      if (!statSync(path).isFile()) return;
      files[relative] = digest(path);
    } catch {
      // An unreadable input is the structural validators' problem, not this one's.
    }
  };

  for (const relative of ALWAYS_INPUTS) record(relative);
  for (const relative of discoverMaterials(projectDir, 400)) record(relative);

  const bibliography = "paper/refs.bib";
  if (isSuppliedBibliography(root, bibliography)) record(bibliography);

  return {
    schema_version: "paper-run-inputs-v1",
    captured_at: new Date().toISOString(),
    files,
  };
}

/**
 * Whether the bibliography arrived with the task rather than being written here.
 *
 * Two signals, both cheap and both hard to fake: a read-only file, or a byte
 * -identical twin under `materials/`. Either means someone else owns the list
 * of works this paper may cite.
 */
export function isSuppliedBibliography(projectDir: string, relative = "paper/refs.bib"): boolean {
  const root = resolve(projectDir);
  const path = join(root, relative);
  if (!existsSync(path)) return false;

  try {
    accessSync(path, constants.W_OK);
  } catch {
    return true;
  }

  const ours = digest(path);
  for (const candidate of discoverMaterials(root, 400)) {
    if (!candidate.endsWith(".bib")) continue;
    try {
      if (digest(join(root, candidate)) === ours) return true;
    } catch {
      continue;
    }
  }
  return false;
}

function digest(path: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}
