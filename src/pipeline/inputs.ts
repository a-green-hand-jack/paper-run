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
import { constants, accessSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { discoverMaterials } from "./material-assessment.js";
import type { InputBaseline } from "../state/schema.js";

/** Files that are inputs by definition, whatever else is discovered. */
const ALWAYS_INPUTS = ["BRIEF.md"];

/**
 * Contracts the pipeline writes, which `discoverMaterials` also reports.
 *
 * Material discovery answers "what is there to write from", and a contract
 * carrying evidence counts. This answers a different question — "what may this
 * run not alter" — and a contract the pipeline exists to fill in is the wrong
 * answer. Conflating them blocked a live run: `evidence_reconciliation`, whose
 * whole job is to write `EXPERIMENTS.md ## Claim-evidence bindings`, failed for
 * modifying a supplied input.
 *
 * `BRIEF.md` stays an input. It is the human's statement of intent, nothing
 * downstream is meant to edit it, and the locked-contract check already
 * enforces that independently.
 */
const PIPELINE_OWNED_CONTRACTS = new Set([
  "EXPERIMENTS.md",
  "PAPER.md",
  "PAPER_INTERFACES.md",
  "PUBLICATION.md",
  "DECISIONS.md",
  "REFERENCES.md",
]);

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
  for (const relative of discoverMaterials(projectDir, 400)) {
    if (PIPELINE_OWNED_CONTRACTS.has(relative)) continue;
    record(relative);
  }

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

/**
 * The reference-integrity activation marker the harness looks for in `refs.bib`.
 *
 * Mirrored from `.agents/tools/check-reference-integrity.py`. Duplicating a
 * constant is not ideal, but the alternative is executing the checker to ask
 * it a question, and this string is part of the harness's durable contract.
 */
const ACTIVATION_MARKER = "% REFERENCE_INTEGRITY_REQUIRED: references/ledger.json";

/**
 * Switch reference-integrity adoption off when the bibliography cannot carry it.
 *
 * The harness template ships `reference_integrity.adopted: true`, and
 * `check-reference-integrity.py` then requires an activation marker *inside*
 * `paper/refs.bib`. When a task supplies its own read-only bibliography, that
 * marker cannot be added: `inputs_unmodified` forbids editing supplied inputs,
 * and the file is usually mode 444 anyway. The stage fails with
 *
 *     ERROR adopted reference integrity requires the refs.bib activation marker
 *
 * and no remediation turn has a legal move. It is the third deadlock of this
 * exact shape — two correct rules, an input nobody may touch — after the
 * BibTeX build failure and the appendix anchor.
 *
 * A previous run only got past it because the eval harness hand-edited the
 * adoption flag during setup. That is the controller's job, not the operator's:
 * paper-run is what decides to seed a supplied bibliography, so paper-run is
 * what should record that the repository cannot adopt a check requiring a
 * marker in it.
 *
 * Returns a note when it changed something, so bootstrap can log the reason.
 * Never throws: a repository without the harness metadata simply has nothing to
 * reconcile.
 */
export function reconcileReferenceIntegrityAdoption(projectDir: string): string | null {
  const root = resolve(projectDir);
  const bibliography = join(root, "paper", "refs.bib");
  if (!existsSync(bibliography)) return null;

  // A bibliography that already carries the marker is adoptable, whatever its
  // origin, and a bibliography the paper owns can have the marker added.
  let text: string;
  try {
    text = readFileSync(bibliography, "utf-8");
  } catch {
    return null;
  }
  if (text.includes(ACTIVATION_MARKER)) return null;
  if (!isSuppliedBibliography(root, "paper/refs.bib")) return null;

  const syncPath = join(root, ".agents", "template-sync.json");
  if (!existsSync(syncPath)) return null;

  let sync: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(readFileSync(syncPath, "utf-8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    sync = parsed as Record<string, unknown>;
  } catch {
    return null;
  }

  const state = sync["reference_integrity"];
  const adopted =
    typeof state === "object" && state !== null && !Array.isArray(state)
      ? (state as Record<string, unknown>)["adopted"]
      : undefined;
  if (adopted !== true) return null;

  sync["reference_integrity"] = {
    ...(state as Record<string, unknown>),
    adopted: false,
    adoption_note:
      "paper/refs.bib is a task-supplied read-only bibliography and cannot carry the "
      + "activation marker; reference integrity runs in its unadopted profile.",
  };

  try {
    writeFileSync(syncPath, `${JSON.stringify(sync, null, 2)}\n`, "utf-8");
  } catch {
    return null;
  }

  return "reference integrity set to its unadopted profile: the supplied bibliography is read-only";
}
