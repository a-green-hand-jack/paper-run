/**
 * The experimental apparatus a paper used, and whether the manuscript says so.
 *
 * On PaperWrite-Bench pwb-0011 the restructured pipeline produced a manuscript
 * whose Experiments section cited three works. All three were row labels of the
 * supplied results table. The ground truth cites twenty-one there — ARC, MMLU,
 * HellaSwag, GSM8K, HumanEval, the evaluation harness, the serving engine, the
 * calibration corpora — and roughly half of its forty-three citations overall
 * are of that kind: you cite them because you *used* them.
 *
 * None of those names appear in the manuscript at all. Not uncited: absent.
 * The supplied results table's column header reads "Benchmark Average" with no
 * breakdown, so "benchmark-average accuracy" is what got written. The names
 * exist only in the supplied code — `run_benchmark.py`'s `--tasks` default, an
 * `INSPECT_TO_LMEVAL` map, a `vllm_runner.py` — which the run demonstrably
 * read and then did not write from, because `PAPER.md` had scoped Experiments
 * to "all table values and their scope".
 *
 * That is the gap this module closes. The tables bound what may be *claimed*;
 * they do not bound what the paper must *describe*. An experimental section is
 * sourced from the code as much as from the results, so the apparatus gets its
 * own evidence channel: the plan enumerates it, and drafting is measured
 * against the enumeration.
 *
 * The check is deliberately exact rather than clever. It asks whether each
 * enumerated entity's bibliography key is cited — no fuzzy matching of names
 * against prose, which would misfire on notation and abbreviation. You do not
 * cite MMLU without naming it.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** One piece of experimental apparatus the paper used. */
export interface SetupEntity {
  /** How the paper refers to it: `MMLU`, `vLLM`, `Qwen2.5-7B`. */
  name: string;
  /** What kind of thing it is: benchmark, model, tool, calibration set. */
  kind: string;
  /** Where in the materials it was found — a path, ideally with a line. */
  evidence: string;
  /** Its key in the supplied bibliography, or null when the bibliography has none. */
  bibKey: string | null;
}

/** The heading under which the plan records the inventory. */
export const INVENTORY_HEADING = "## Experimental setup inventory";

const EMPTY_CELL = /^(|-+|—+|–+|n\/?a|none|tbd|unknown)$/i;

// ---------------------------------------------------------------------------
// Reading the inventory
// ---------------------------------------------------------------------------

/**
 * Parse `EXPERIMENTS.md ## Experimental setup inventory` into entities.
 *
 * Returns an empty list when the section is missing or holds no table, which
 * the validators treat as "not written yet" rather than "nothing to write".
 */
export function readSetupInventory(projectDir: string): SetupEntity[] {
  const path = join(resolve(projectDir), "EXPERIMENTS.md");
  if (!existsSync(path)) return [];

  const section = extractSection(readFile(path), INVENTORY_HEADING);
  if (!section) return [];

  return parseTable(section);
}

/**
 * Names the plan recorded as deliberately left out.
 *
 * Same escape hatch `figure_coverage` uses: an apparatus entity the paper
 * decided not to describe is a decision, and a decision belongs in
 * `PAPER.md ## Unresolved` where a human can see it — not an omission.
 */
export function excusedApparatus(projectDir: string): string[] {
  const path = join(resolve(projectDir), "PAPER.md");
  if (!existsSync(path)) return [];

  const section = extractSection(readFile(path), "## Unresolved");
  if (!section) return [];

  return section
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

// ---------------------------------------------------------------------------
// Checking the manuscript against it
// ---------------------------------------------------------------------------

/**
 * What is wrong with the inventory itself, if anything.
 *
 * Run at planning time, when the cost of fixing it is one turn. An invented
 * bibliography key is the failure that matters here: the drafting check would
 * otherwise push the writer to cite a key that does not exist, and
 * `check-reference-integrity.py` would reject the manuscript for it.
 */
export function inventoryIssues(
  entities: readonly SetupEntity[],
  bibKeys: readonly string[],
  minEntities: number,
): string[] {
  const issues: string[] = [];

  if (entities.length < minEntities) {
    issues.push(
      `${INVENTORY_HEADING} lists ${entities.length} entit${entities.length === 1 ? "y" : "ies"}, `
        + `expected at least ${minEntities} — enumerate the models, datasets, benchmarks, `
        + `metrics, tools, and calibration sets the supplied code and configs actually name`,
    );
  }

  const unnamed = entities.filter((entity) => entity.name.length === 0);
  if (unnamed.length > 0) {
    issues.push(`${unnamed.length} inventory row(s) have no entity name`);
  }

  const withoutEvidence = entities.filter((entity) => entity.evidence.length === 0);
  if (withoutEvidence.length > 0) {
    issues.push(
      `no evidence path for: ${withoutEvidence.map((entity) => entity.name).join(", ")} — `
        + `every entity must name the material file it was read from`,
    );
  }

  if (bibKeys.length > 0) {
    const invented = entities
      .filter((entity) => entity.bibKey !== null && !bibKeys.includes(entity.bibKey))
      .map((entity) => `${entity.name} → ${entity.bibKey}`);
    if (invented.length > 0) {
      issues.push(
        `bibliography keys that do not exist in the supplied bibliography: ${invented.join("; ")} `
          + `— leave the column empty rather than guessing a key`,
      );
    }
  }

  return issues;
}

/**
 * Inventory entities whose citation the manuscript owes and has not paid.
 *
 * An entity counts as settled when its key is cited anywhere in the
 * manuscript, or when the plan recorded it under `PAPER.md ## Unresolved`.
 * Entities with no bibliography key are never owed — the paper should still
 * name them, but there is nothing mechanical to check.
 */
export function uncitedApparatus(
  entities: readonly SetupEntity[],
  citedKeys: readonly string[],
  bibKeys: readonly string[],
  excused: readonly string[],
): SetupEntity[] {
  const cited = new Set(citedKeys);
  const defined = new Set(bibKeys);
  const excusedText = excused.join("\n").toLowerCase();

  return entities.filter((entity) => {
    if (entity.bibKey === null) return false;
    if (!defined.has(entity.bibKey)) return false; // reported by inventoryIssues instead
    if (cited.has(entity.bibKey)) return false;
    if (entity.name.length > 0 && excusedText.includes(entity.name.toLowerCase())) return false;
    return true;
  });
}

/** One line per entity, for a prompt. */
export function describeInventory(entities: readonly SetupEntity[]): string[] {
  return entities.map((entity) => {
    const key = entity.bibKey === null ? "no bibliography key" : `\`${entity.bibKey}\``;
    return `  - ${entity.name} (${entity.kind || "unspecified"}) — ${key}`;
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readFile(path: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}

/** The body under a `##` heading, up to the next heading of the same level. */
function extractSection(text: string, heading: string): string | null {
  const lines = text.split("\n");
  const wanted = heading.trim().toLowerCase();

  let start = -1;
  for (const [index, line] of lines.entries()) {
    if (line.trim().toLowerCase() === wanted) {
      start = index + 1;
      break;
    }
  }
  if (start === -1) return null;

  const body: string[] = [];
  for (const line of lines.slice(start)) {
    if (/^#{1,2} /.test(line)) break;
    body.push(line);
  }

  return body.join("\n");
}

/**
 * Read the first Markdown table in a section.
 *
 * Columns are located by header name so the plan may reorder them, with a
 * positional fallback for a table whose header we do not recognise.
 */
function parseTable(section: string): SetupEntity[] {
  const rows = section
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|"));

  if (rows.length < 2) return [];

  const header = splitRow(rows[0]!).map((cell) => cell.toLowerCase());
  const columns = {
    name: findColumn(header, ["entity", "name", "item", "apparatus"], 0),
    kind: findColumn(header, ["kind", "type", "category", "role"], 1),
    evidence: findColumn(header, ["evidence", "source", "where", "material", "path"], 2),
    bibKey: findColumn(header, ["bib key", "bibkey", "key", "citation", "bib"], 3),
  };

  const entities: SetupEntity[] = [];
  for (const row of rows.slice(1)) {
    // The `|---|---|` separator, in any of its spellings.
    if (/^\|[\s:|-]+\|?$/.test(row)) continue;

    const cells = splitRow(row);
    if (cells.length === 0) continue;

    const name = cell(cells, columns.name);
    if (name.length === 0) continue;
    // A header repeated inside the body is not a row.
    if (name.toLowerCase() === "entity") continue;

    const bibKey = cell(cells, columns.bibKey);
    entities.push({
      name,
      kind: cell(cells, columns.kind),
      evidence: cell(cells, columns.evidence),
      bibKey: EMPTY_CELL.test(bibKey) ? null : bibKey,
    });
  }

  return entities;
}

function splitRow(row: string): string[] {
  return row
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((piece) => piece.trim());
}

function findColumn(header: readonly string[], names: readonly string[], fallback: number): number {
  for (const [index, label] of header.entries()) {
    if (names.some((name) => label === name || label.startsWith(`${name} `))) return index;
  }
  return fallback;
}

function cell(cells: readonly string[], index: number): string {
  const raw = cells[index] ?? "";
  return raw.replace(/`/g, "").replace(/^\*+|\*+$/g, "").trim();
}
