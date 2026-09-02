/**
 * Compiling the manuscript while it is still being written.
 *
 * The pipeline measured length in words because it had no page count to
 * measure: nothing compiled the document until `publication_build`, the last
 * stage. So `manuscript_length` estimated pages from a words-per-page constant
 * and drafting worked against a proxy, while the baseline it lost to compiled
 * after every substantial edit, rendered the pages to PNG, looked at them, and
 * adjusted — reaching its page target exactly.
 *
 * A build costs seconds and no tokens. Running one at the end of drafting
 * turns two guesses into facts: whether the manuscript compiles at all, and
 * how many pages it actually is.
 *
 * The output goes to a scratch directory under `.paper-run/`, never to
 * `paper/`. A draft-time build is a measurement, not an artifact; publication
 * variants remain the only PDFs the repository keeps.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { execa } from "execa";

import { PAPER_RUN_DIR } from "../utils/constants.js";
import { isSuppliedBibliography } from "./inputs.js";

export interface CompileResult {
  /** A PDF was produced. */
  ok: boolean;
  /** Pages in that PDF, when they could be counted. */
  pages: number | null;
  /** Why it failed, when it did. Empty on success. */
  diagnostic: string;
  /** A defect in a supplied input that the build survived. */
  warning?: string;
}

/** Where draft-time builds go. Gitignored with the rest of `.paper-run/`. */
export const DRAFT_BUILD_DIR = join(PAPER_RUN_DIR, "build");

/**
 * Compile the canonical manuscript and count its pages.
 *
 * Never throws: a missing LaTeX toolchain, a broken document, and a clean
 * build are all reported the same way, because the caller is a validator and
 * "no toolchain" must not read as "the paper is broken".
 */
export async function compileDraft(
  projectDir: string,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<CompileResult> {
  const root = resolve(projectDir);
  const paperDir = join(root, "paper");
  const entrypoint = join(paperDir, "main.tex");

  if (!existsSync(entrypoint)) {
    return { ok: false, pages: null, diagnostic: "paper/main.tex is missing" };
  }

  const outDir = join(root, DRAFT_BUILD_DIR);
  mkdirSync(outDir, { recursive: true });

  const run = (tolerant: boolean) =>
    execa("latexmk", [
      "-norc",
      "-no-shell-escape",
      "-pdf",
      "-jobname=draft-preview",
      `-outdir=${outDir}`,
      "-interaction=nonstopmode",
      ...(tolerant ? ["-f"] : ["-halt-on-error"]),
      "main.tex",
    ], {
      cwd: paperDir,
      timeout: options.timeoutMs ?? 4 * 60_000,
      ...(options.signal ? { cancelSignal: options.signal } : {}),
      env: {
        ...process.env,
        openin_any: "p",
        openout_any: "p",
        shell_escape: "f",
        // TeX wraps its output at 79 columns by default, which cuts its own
        // error messages mid-word: a real run received "File `x.jpg' not f"
        // and the matcher below never fired, so the guidance appended to it
        // never reached the agent. Widen the line so a diagnostic survives.
        max_print_line: "1000",
      },
    });

  const pdf = join(outDir, "draft-preview.pdf");
  rmSync(pdf, { force: true });

  let warning: string | undefined;
  try {
    await run(false);
  } catch (err) {
    const failure = err as { code?: string; timedOut?: boolean };
    if (failure.code === "ENOENT") {
      return { ok: false, pages: null, diagnostic: "latexmk is unavailable" };
    }
    if (failure.timedOut) {
      return { ok: false, pages: null, diagnostic: "compilation timed out" };
    }

    const complaint = suppliedBibliographyComplaint(root, err);
    if (complaint === null) {
      return { ok: false, pages: null, diagnostic: firstLatexError(err) };
    }

    try {
      await run(true);
    } catch {
      // `-f` exits non-zero whenever a rule failed, PDF or no PDF. The
      // artifact below is the verdict.
    }
    if (!existsSync(pdf) || statSync(pdf).size === 0) {
      return { ok: false, pages: null, diagnostic: firstLatexError(err) };
    }
    warning = complaint;
  }

  if (!existsSync(pdf) || statSync(pdf).size === 0) {
    return { ok: false, pages: null, diagnostic: "no PDF was produced" };
  }

  return {
    ok: true,
    pages: await countPages(pdf),
    diagnostic: "",
    ...(warning ? { warning } : {}),
  };
}

/**
 * Whether a failed build is BibTeX objecting to a bibliography we may not edit.
 *
 * Returns a one-line description when it is, and null when the failure is
 * anything else — a LaTeX error, a missing file, a timeout.
 *
 * A task may supply a read-only bibliography containing malformed entries.
 * BibTeX reports them, skips them, and still writes a usable `.bbl`; latexmk
 * under `-halt-on-error` then refuses to produce a PDF. The agent cannot
 * repair the file because `inputs_unmodified` forbids editing supplied inputs.
 * That is a deadlock assembled from two individually correct rules, and it is
 * what blocked pwb-0011 at `publication_build` after all eight writing stages
 * had passed — while the same manuscript recompiled cleanly under the
 * benchmark verifier's own flow, which does not halt on BibTeX.
 *
 * Deliberately narrow: it requires both that the bibliography is
 * supplied-and-closed and that the transcript carries BibTeX's own complaint
 * about it. A LaTeX error in the manuscript still fails the build.
 */
export function suppliedBibliographyComplaint(root: string, err: unknown): string | null {
  const transcript = transcriptOf(err);

  if (!/bibtex/i.test(transcript)) return null;

  const bibComplaint =
    /(missing a field name|I was expecting|I'm skipping whatever remains|repeated entry)/i;
  if (!bibComplaint.test(transcript)) return null;

  // A LaTeX-side error is not something a bibliography caused.
  if (/^! /m.test(transcript)) return null;

  const candidates = [profileBibliography(root), "paper/refs.bib", "paper/references.bib"].filter(
    (path): path is string => typeof path === "string" && path.length > 0,
  );

  for (const candidate of candidates) {
    if (!isSuppliedBibliography(root, candidate)) continue;
    const count = (transcript.match(/missing a field name/gi) ?? []).length;
    return count > 0
      ? `${count} malformed entr${count === 1 ? "y" : "ies"} in the supplied read-only bibliography ${candidate}`
      : `BibTeX complaints about the supplied read-only bibliography ${candidate}`;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Remembering the measurement
// ---------------------------------------------------------------------------

/**
 * The page count of the last successful draft build, if it is still true.
 *
 * Returns null when nothing has been compiled, when the last compile failed,
 * or when any manuscript source has changed since — a stale page count is
 * worse than none, because a validator would report it as fact.
 */
export function lastMeasuredPages(projectDir: string): number | null {
  const root = resolve(projectDir);
  const path = join(root, DRAFT_BUILD_DIR, "pages.json");
  if (!existsSync(path)) return null;

  try {
    const record = JSON.parse(readFileSync(path, "utf-8")) as {
      pages?: unknown;
      sources_mtime_ns?: unknown;
    };
    if (typeof record.pages !== "number" || !Number.isFinite(record.pages)) return null;
    if (typeof record.sources_mtime_ns !== "string") return null;
    if (BigInt(record.sources_mtime_ns) !== newestManuscriptMtime(root)) return null;
    return record.pages;
  } catch {
    return null;
  }
}

/** Record a page count against the manuscript that produced it. */
export function recordMeasuredPages(projectDir: string, pages: number | null): void {
  const root = resolve(projectDir);
  const dir = join(root, DRAFT_BUILD_DIR);
  const path = join(dir, "pages.json");

  if (pages === null) {
    rmSync(path, { force: true });
    return;
  }

  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path,
      `${JSON.stringify(
        {
          pages,
          measured_at: new Date().toISOString(),
          sources_mtime_ns: newestManuscriptMtime(root).toString(),
        },
        null,
        2,
      )}\n`,
    );
  } catch {
    // A page count we could not persist is a page count we do without.
  }
}

/** Newest mtime across the manuscript's own sources. */
function newestManuscriptMtime(root: string): bigint {
  let newest = 0n;

  const walk = (dir: string, depth: number): void => {
    if (depth > 4) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "generated") continue;
        walk(path, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!/\.(tex|bib|sty|cls|bst)$/.test(entry.name)) continue;
      try {
        const stat = statSync(path, { bigint: true });
        if (stat.mtimeNs > newest) newest = stat.mtimeNs;
      } catch {
        continue;
      }
    }
  };

  walk(join(root, "paper"), 0);
  return newest;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function transcriptOf(err: unknown): string {
  return [(err as { stdout?: string }).stdout ?? "", (err as { stderr?: string }).stderr ?? ""].join(
    "\n",
  );
}

/**
 * The first `! ...` TeX reports, which is the one that stopped the run.
 *
 * A missing-graphic error gets the fix appended, because the message alone is
 * not enough to act on: TeX names the path it could not find but not the path
 * it would have accepted, and a run burned both remediation attempts moving a
 * figure between two wrong prefixes.
 */
export function latexDiagnostic(err: unknown): string {
  return firstLatexError(err);
}

function firstLatexError(err: unknown): string {
  const transcript = transcriptOf(err);
  const line = transcript.split("\n").find((candidate) => candidate.startsWith("! "));
  if (!line) return "the manuscript does not compile";

  const message = line.trim();

  // Match against the de-wrapped transcript as well as the raw line. TeX wraps
  // at 79 columns by inserting a newline *without* a space, so "not found"
  // arrives as "not f\nound" -- joining the lines with nothing restores the
  // original stream. Older runs, and any writer ignoring `max_print_line`,
  // still produce this, and it hid the guidance below from a real run exactly
  // when it was needed.
  const flattened = transcript.replace(/\r?\n/g, "");
  const graphic =
    message.match(/File [`'"]([^`'"]+)['"`] not found/)
    ?? flattened.match(/File [`'"]([^`'"]+)['"`] not found/);

  if (graphic && /\.(pdf|png|jpe?g|eps|svg)$/i.test(graphic[1] ?? "")) {
    const name = graphic[1]!.split("/").pop();
    const shown = message.length >= 78 && !/ not found/.test(message)
      ? `! Package pdftex.def Error: File \`${graphic[1]}\` not found`
      : message;
    return `${shown} — the document compiles from \`paper/\`, so reference it as `
      + `\`figures/${name}\``;
  }

  return message;
}

function profileBibliography(root: string): string | undefined {
  try {
    const raw = JSON.parse(readFileSync(join(root, ".agents", "paper-build.json"), "utf-8")) as {
      bibliography?: unknown;
    };
    return typeof raw.bibliography === "string" ? raw.bibliography : undefined;
  } catch {
    return undefined;
  }
}

async function countPages(pdf: string): Promise<number | null> {
  try {
    const { stdout } = await execa("pdfinfo", [pdf], { timeout: 30_000 });
    const match = stdout.match(/^Pages:\s+(\d+)/m);
    return match ? Number(match[1]) : null;
  } catch {
    return pagesFromRawPdf(pdf);
  }
}

/** Fallback for a machine with no poppler: count `/Type /Page` objects. */
function pagesFromRawPdf(pdf: string): number | null {
  try {
    const text = readFileSync(pdf, "latin1");
    const count = (text.match(/\/Type\s*\/Page[^s]/g) ?? []).length;
    return count > 0 ? count : null;
  } catch {
    return null;
  }
}
