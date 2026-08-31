import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { execa } from "execa";

import { installAdapter } from "../adapter/install.js";
import { initializeHarnessTrust } from "../harness/harness.js";
import { fetchTemplate, verifyTemplateTree } from "../harness/template.js";
import { generateGatePreset } from "../state/gate-presets.js";
import { createRunPlan } from "../state/plans.js";
import { ensurePaperRunDir, writeGatePolicy, writeRunState, writeStageHistory } from "../state/store.js";
import type { RunState } from "../state/schema.js";
import { startCommand, type StartOptions } from "./start.js";
import { DEFAULT_TEMPLATE_VERSION, GIT, MODES, PAPER_RUN_DIR } from "../utils/constants.js";
import type { Mode } from "../utils/constants.js";
import { commitCheckpoint, createRunBranch, generateRunId } from "../utils/git.js";
import { PaperRunError } from "../utils/errors.js";
import { log, printKeyValues } from "../utils/logger.js";
import { reviewTreeDigest } from "../utils/review-integrity.js";

const EXCLUDED_SOURCE_ENTRIES = new Set([".git", PAPER_RUN_DIR]);
const SENSITIVE_SOURCE_NAME = /(^|\/)(\.env(?:\.|$)|\.npmrc$|\.netrc$|.*\.(?:pem|key|p12|pfx|secret|secrets)$|credentials?(?:\.|$)|(?:id_rsa|token|service-account|application_default_credentials)(?:\.|$)|.*(?:token|secret|credential|service[-_]?account).*(?:\.json|\.ya?ml|\.toml)?$)/i;

export interface ReviewOptions extends StartOptions {
  output?: string;
  entry?: string;
  mode?: string;
  template?: string;
  prepareOnly?: boolean;
}

export interface ReviewWorkspaceResult {
  workspace: string;
  entrypoint: string;
  files: string[];
}

export type ImportedWorkspacePurpose = "review" | "adoption";

export interface ReviewSourceInspection {
  entrypoint: string;
  sourceGraph: string[];
  bibliography: string[];
  figures: string[];
  tables: string[];
  styles: string[];
  buildFiles: string[];
  evidenceFiles: string[];
  missingSourceFiles: Array<{ from: string; requested: string }>;
}

export async function reviewCommand(source: string, opts: ReviewOptions): Promise<void> {
  if (opts.headless && (opts.mode ?? "collaborative") === "collaborative") {
    throw new PaperRunError("Headless standalone review requires autonomous mode.", {
      hint: "Pass --mode autonomous, or omit --headless to review the gate in the TUI.",
    });
  }
  const prepared = await prepareReviewWorkspace(source, opts);
  reportPrepared(prepared);
  if (opts.prepareOnly) return;

  const previous = process.cwd();
  try {
    process.chdir(prepared.workspace);
    await startCommand({
      ...(opts.headless !== undefined ? { headless: opts.headless } : {}),
      ...(opts.model !== undefined ? { model: opts.model } : {}),
      ...(opts.variant !== undefined ? { variant: opts.variant } : {}),
      ...(opts.port !== undefined ? { port: opts.port } : {}),
      ...(opts.stageTimeoutMultiplier !== undefined
        ? { stageTimeoutMultiplier: opts.stageTimeoutMultiplier }
        : {}),
    });
  } finally {
    process.chdir(previous);
  }
}

export async function prepareReviewWorkspace(
  source: string,
  opts: Pick<ReviewOptions, "output" | "entry" | "mode" | "template" | "model"> = {},
): Promise<ReviewWorkspaceResult> {
  return prepareImportedWorkspace(source, opts, "review");
}

export async function prepareImportedWorkspace(
  source: string,
  opts: Pick<ReviewOptions, "output" | "entry" | "mode" | "template" | "model">,
  purpose: ImportedWorkspacePurpose,
): Promise<ReviewWorkspaceResult> {
  const sourceDir = resolve(source);
  assertSourceDirectory(sourceDir);
  const workspace = resolve(opts.output ?? `${sourceDir}-${purpose === "review" ? "review" : "adopted"}`);
  assertWorkspaceUsable(sourceDir, workspace);
  const mode = parseMode(opts.mode ?? "collaborative");
  const version = opts.template ?? DEFAULT_TEMPLATE_VERSION;
  const entrypoint = detectEntrypoint(sourceDir, opts.entry);
  const staging = mkdtempSync(join(realpathSync(nearestExistingParent(workspace)), ".paper-run-import-"));

  try {
    log.step(`Preparing an isolated review workspace at ${workspace}`);
    await fetchTemplate({ targetDir: staging, version, source: "local" });
    const missing = verifyTemplateTree(staging);
    if (missing.length > 0) throw new PaperRunError(`The fetched template is missing expected files: ${missing.join(", ")}`);

    const paperDir = join(staging, "paper");
    rmSync(paperDir, { recursive: true, force: true });
    mkdirSync(paperDir, { recursive: true });
    const files = copyPaperSource(sourceDir, paperDir);
    const relativeEntry = toPosix(relative(sourceDir, entrypoint));
    if (relativeEntry !== "main.tex" && !files.includes("main.tex")) {
      writeFileSync(join(paperDir, "main.tex"), `% Generated by paper-run for isolated review.\n\\input{${relativeEntry}}\n`);
      files.push("main.tex");
    }
    const inspection = inspectReviewSource(sourceDir, relativeEntry, files);
    if (purpose === "review") {
      writeReviewContext(staging, basenamePosix(toPosix(sourceDir)), inspection, files, reviewTreeDigest(staging), mode);
    } else {
      writeAdoptionContext(staging, sourceDir, inspection, files, mode);
      replaceModeInContracts(staging, mode);
      writeExternalBuildProfile(staging, inspection);
    }
    await initializeImportedRepository(
      staging,
      version,
      mode,
      opts.model,
      purpose === "review" ? "review-report" : "existing-manuscript",
    );
    if (existsSync(workspace)) throw new PaperRunError(`Review workspace was created during preparation: ${workspace}`);
    mkdirSync(dirname(workspace), { recursive: true });
    renameSync(staging, workspace);
    return { workspace, entrypoint: relativeEntry, files: files.sort() };
  } catch (error) {
    if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

function assertSourceDirectory(sourceDir: string): void {
  if (!existsSync(sourceDir) || !statSync(sourceDir).isDirectory() || lstatSync(sourceDir).isSymbolicLink()) {
    throw new PaperRunError(`Paper source is not a directory: ${sourceDir}`);
  }
}

function assertWorkspaceUsable(sourceDir: string, workspace: string): void {
  const sourceReal = realpathSync(sourceDir);
  const workspacePath = resolve(workspace);
  const parentReal = realpathSync(nearestExistingParent(workspacePath));
  const canonicalWorkspace = join(parentReal, relative(nearestExistingParent(workspacePath), workspacePath));
  if (canonicalWorkspace === sourceReal || canonicalWorkspace.startsWith(`${sourceReal}${sep}`)) {
    throw new PaperRunError("The review workspace must be outside the source repository.");
  }
  if (existsSync(workspace) && lstatSync(workspace).isSymbolicLink()) {
    throw new PaperRunError("The review workspace cannot be a symbolic link.");
  }
  if (existsSync(workspace)) {
    throw new PaperRunError(`Review workspace already exists: ${workspace}`, { hint: "Choose an absent directory with --output." });
  }
}

function nearestExistingParent(path: string): string {
  let current = path;
  while (!existsSync(current)) {
    const parent = resolve(current, "..");
    if (parent === current) break;
    current = parent;
  }
  return current;
}

export function detectEntrypoint(sourceDir: string, requested?: string): string {
  if (requested) {
    const candidate = resolve(sourceDir, requested);
    assertPathInside(sourceDir, candidate);
    if (!existsSync(candidate) || !statSync(candidate).isFile() || !candidate.endsWith(".tex")) {
      throw new PaperRunError(`TeX entrypoint not found: ${requested}`);
    }
    return candidate;
  }
  const texFiles = listSourceFiles(sourceDir).filter((path) => path.endsWith(".tex"));
  const candidates = texFiles.filter((path) => {
    const content = readFileSync(join(sourceDir, path), "utf-8");
    return /(^|\n)\s*\\documentclass(?:\[[^\]]*\])?\s*\{/m.test(stripTexComments(content));
  });
  if (candidates.length === 1) return join(sourceDir, candidates[0]!);
  if (candidates.length === 0) throw new PaperRunError("Could not find a TeX entrypoint containing \\documentclass.", { hint: "Pass --entry with the main .tex file relative to the source directory." });
  throw new PaperRunError(`Multiple TeX entrypoints found: ${candidates.join(", ")}`, { hint: "Pass --entry to select the manuscript to review." });
}

export function inspectReviewSource(
  sourceDir: string,
  entrypoint: string,
  files = listSourceFiles(sourceDir),
): ReviewSourceInspection {
  const fileSet = new Set(files);
  const sourceGraph: string[] = [];
  const missingSourceFiles: Array<{ from: string; requested: string }> = [];
  const visited = new Set<string>();

  const visit = (file: string) => {
    if (visited.has(file) || !fileSet.has(file)) return;
    visited.add(file);
    sourceGraph.push(file);
    const content = stripTexComments(readFileSync(join(sourceDir, file), "utf-8"));
    const directory = dirnamePosix(file);
    for (const match of content.matchAll(/\\(?:input|include|subfile)\s*\{([^}]+)\}/g)) {
      const raw = match[1]!.trim();
      const candidate = toPosix(join(directory, raw.endsWith(".tex") ? raw : `${raw}.tex`));
      if (!fileSet.has(candidate)) missingSourceFiles.push({ from: file, requested: candidate });
      else visit(candidate);
    }
  };
  visit(entrypoint);

  const byExtension = (extensions: readonly string[]) => files.filter((file) => extensions.some((ext) => file.toLowerCase().endsWith(ext)));
  return {
    entrypoint,
    sourceGraph,
    bibliography: byExtension([".bib"]),
    figures: byExtension([".pdf", ".png", ".jpg", ".jpeg", ".eps", ".svg"]),
    tables: files.filter((file) => /(^|\/)(tables?|tabs?)(\/|$)/i.test(file) || /table/i.test(basenamePosix(file))),
    styles: byExtension([".sty", ".cls", ".bst"]),
    buildFiles: files.filter((file) => /(^|\/)(makefile|latexmkrc|tectonic\.toml|\.github\/workflows\/[^/]+)$/i.test(file)),
    evidenceFiles: files.filter((file) => /(^|\/)(experiments?|results?|evaluation|eval)(\/|$)/i.test(file) || /(^|\/)(experiments?|results?)\.(md|json|csv|tsv)$/i.test(file)),
    missingSourceFiles,
  };
}

function copyPaperSource(sourceDir: string, paperDir: string): string[] {
  validateSourceLinks(sourceDir);
  const files = importManifest(sourceDir);
  for (const file of files) {
    const target = join(paperDir, file);
    mkdirSync(resolve(target, ".."), { recursive: true });
    cpSync(join(sourceDir, file), target, { recursive: false, dereference: false });
  }
  return files;
}

function importManifest(sourceDir: string): string[] {
  let files: string[];
  try {
    files = execFileSync("git", ["-C", sourceDir, "ls-files", "-co", "--exclude-standard", "-z"], { encoding: "utf8" })
      .split("\0").filter(Boolean).map(toPosix).filter((file) => !EXCLUDED_SOURCE_ENTRIES.has(file.split("/")[0] ?? ""));
  } catch {
    files = listSourceFiles(sourceDir);
  }
  const unsafe = files.find((file) => SENSITIVE_SOURCE_NAME.test(file));
  if (unsafe) throw new PaperRunError(`Refusing to import a sensitive source file: ${unsafe}`);
  return files.sort();
}

function validateSourceLinks(sourceDir: string, current = sourceDir): void {
  for (const entry of readdirSync(current)) {
    if (current === sourceDir && EXCLUDED_SOURCE_ENTRIES.has(entry)) continue;
    const path = join(current, entry);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new PaperRunError(`Symbolic links are not supported in an imported paper repo: ${path}`);
    else if (stat.isDirectory()) validateSourceLinks(sourceDir, path);
    else if (!stat.isFile()) throw new PaperRunError(`Special files are not supported in an imported paper repo: ${path}`);
  }
}

function listSourceFiles(sourceDir: string, current = sourceDir): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(current).sort()) {
    if (current === sourceDir && EXCLUDED_SOURCE_ENTRIES.has(entry)) continue;
    const path = join(current, entry);
    const stat = lstatSync(path);
    if (stat.isDirectory()) files.push(...listSourceFiles(sourceDir, path));
    else if (stat.isFile()) files.push(toPosix(relative(sourceDir, path)));
    else throw new PaperRunError(`Special files are not supported in an imported paper repo: ${path}`);
  }
  return files;
}

function assertPathInside(root: string, path: string): void {
  const rel = relative(resolve(root), resolve(path));
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new PaperRunError(`Paper source contains a path outside its repository: ${path}`);
}

function stripTexComments(content: string): string {
  return content.split("\n").map((line) => line.replace(/(^|[^\\])%.*/, "$1")).join("\n");
}

function writeReviewContext(
  workspace: string,
  source: string,
  inspection: ReviewSourceInspection,
  files: string[],
  paperDigest: string,
  mode: Mode,
): void {
  ensurePaperRunDir(workspace);
  writeFileSync(join(workspace, PAPER_RUN_DIR, "review-source.json"), `${JSON.stringify({ schema_version: "paper-run-review-source-v1", source, ...inspection, paperDigest, mode, imported_at: new Date().toISOString(), files: files.sort() }, null, 2)}\n`);
  writeFileSync(join(workspace, "BRIEF.md"), `# Independent manuscript review\n\n## Objective\n\nReview the imported manuscript without editing it.\n\n## Source\n\n- Entrypoint: \`paper/${inspection.entrypoint}\`\n- TeX source graph: ${inspection.sourceGraph.length} file(s)\n- Imported files: ${files.length}\n- Mode: ${mode}\n- Missing source inputs: ${inspection.missingSourceFiles.length > 0 ? inspection.missingSourceFiles.map((item) => `\`${item.from}\` -> \`${item.requested}\``).join(", ") : "None detected."}\n- Evidence coverage: only files copied into \`paper/\` are available; missing experimental records or external references must be reported as not assessable.\n`);
  writeFileSync(join(workspace, "PAPER.md"), completeReviewPaperContract(inspection));
  writeFileSync(join(workspace, "EXPERIMENTS.md"), completeReviewExperimentsContract(inspection));
  writeFileSync(join(workspace, "REFERENCES.md"), `# References\n\n## Imported bibliography\n\nBibliography files are listed in .paper-run/review-source.json.\n`);
  replaceModeInContracts(workspace, mode);
}

function completeReviewPaperContract(inspection: ReviewSourceInspection): string {
  return `# Paper Contract\n\nImported manuscript review contract. The imported TeX under paper/ is the primary scientific source.\n\n## Collaboration cues\n\n- **locked** means the reviewer must not change the manuscript or its meaning.\n- **bounded** means analysis stays within the imported files.\n- **free** applies only to the review report.\n- **unresolved** means the source does not provide enough evidence to assess the item.\n\n## Paper identity\n\n- Working title: Imported manuscript; verify from paper/${inspection.entrypoint}\n- Target venue: unresolved\n- Paper type: unresolved\n- Intended readers: unresolved\n- One-sentence positioning: unresolved\n\n## Operating mode\n\n- Mode: collaborative\n- Collaboration: bounded\n\n## What readers should believe\n\n### Central thesis\n\nAssess only claims stated in the imported manuscript.\n\n### Contributions\n\nUnresolved; identify only contributions supported by the imported source.\n\n## What must not change silently\n\n- The imported manuscript source and its scientific meaning.\n\n## What may evolve\n\n- Review report wording and organization only.\n\n## Unresolved\n\n- External paper contracts were not available during transfer.\n- See .paper-run/review-source.json for source graph and coverage.\n\n## Story and structure\n\n### Narrative arc\n\nUnresolved; source graph contains ${inspection.sourceGraph.length} file(s).\n\n### Section responsibilities\n\nAssess the responsibilities expressed by the imported manuscript.\n\n## Writing style\n\n### Current style\n\nUnresolved; evaluate the imported manuscript as written.\n\n## Human decisions required\n\n- Any correction, revision, claim change, or evidence addition.\n`;
}

function completeReviewExperimentsContract(inspection: ReviewSourceInspection): string {
  return `# Experiment Contract\n\nThis contract records imported evidence coverage for review only.\n\n## Experiment overview\n\n${inspection.evidenceFiles.length > 0 ? inspection.evidenceFiles.map((file) => `- Imported evidence surface: \`paper/${file}\``).join("\n") : "No separate experiment or result files were detected; manuscript-only evidence remains unresolved."}\n\n## Evidence-question template\n\nNo normalized evidence question was created during report-only transfer.\n\n## Result interpretation\n\nResults must be assessed only when the imported manuscript and supplied evidence define the measurement, conditions, aggregation, uncertainty, and limits of interpretation.\n\n## Relationship to the code repository\n\nNo code repository relationship was inferred during report-only transfer.\n\n## Claim-evidence bindings\n\nNot normalized during report-only transfer; assess the imported manuscript and available files directly.\n`;
}

function writeAdoptionContext(
  workspace: string,
  sourceDir: string,
  inspection: ReviewSourceInspection,
  files: string[],
  mode: Mode,
): void {
  const metadata = extractManuscriptMetadata(sourceDir, inspection);
  ensurePaperRunDir(workspace);
  writeFileSync(
    join(workspace, PAPER_RUN_DIR, "transfer-source.json"),
    `${JSON.stringify({
      schema_version: "paper-run-transfer-source-v1",
      source: basenamePosix(toPosix(sourceDir)),
      ...inspection,
      metadata,
      imported_at: new Date().toISOString(),
      files: files.sort(),
    }, null, 2)}\n`,
  );

  const title = metadata.title ?? "Unresolved imported manuscript title";
  const thesis = metadata.abstract ?? "Unresolved; derive the central thesis from the imported manuscript before changing it.";
  const authors = metadata.authors.length > 0 ? metadata.authors.join(", ") : "Unresolved";
  writeFileSync(join(workspace, "PAPER.md"), `# Paper Contract\n\nThis contract was generated from verifiable imported manuscript metadata.\n\n## Collaboration cues\n\n- **locked** means the imported manuscript and scientific meaning must not change silently.\n- **bounded** means work stays within the documented evidence.\n- **free** applies to low-risk wording and organization.\n- **unresolved** means a Human decision or source evidence is missing.\n\n## Paper identity\n\n- Working title: ${title}\n- Target venue: Unresolved\n- Paper type: Imported existing manuscript\n- Intended readers: Unresolved\n- One-sentence positioning: Unresolved\n\n## What readers should believe\n\n### Central thesis\n\n${thesis}\n\n### Contributions\n\n- Unresolved; validate contributions against \`paper/${inspection.entrypoint}\`.\n\n## Authors and identity\n\n${authors}\n\n## Operating mode\n\n- Mode: collaborative\n- Collaboration: bounded\n\n## What must not change silently\n\nThe imported manuscript source and claims derived from it.\n\n## What may evolve\n\nPositioning, structure, prose, and unresolved metadata after evidence-based review.\n\n## Unresolved\n\n- Confirm title, venue, contributions, authorship, and target constraints.\n- Reconcile generated contracts with the imported manuscript before revision.\n\n## Story and structure\n\n### Narrative arc\n\nThe imported TeX source graph contains ${inspection.sourceGraph.length} file(s):\n${inspection.sourceGraph.map((file) => `- \`paper/${file}\``).join("\n")}\n\n### Section responsibilities\n\nUnresolved; derive from the imported manuscript before revision.\n\n## Writing style\n\n### Current style\n\nUnresolved; preserve the imported manuscript's style until reviewed.\n\n## Human decisions required\n\n- Central contributions and claims.\n- Target venue, primary metrics, baselines, and interpretation.\n- Any changes to the imported scientific meaning.\n`);
  writeFileSync(join(workspace, "BRIEF.md"), `# Imported Manuscript Brief\n\n## Paper identity\n\n${title}\n\n## What readers should believe\n\n${thesis}\n\n## Operating mode\n\n- Mode: collaborative\n\n## Evidence and materials\n\n- Entrypoint: \`paper/${inspection.entrypoint}\`\n- Bibliography files: ${formatPaths(inspection.bibliography)}\n- Evidence files: ${formatPaths(inspection.evidenceFiles)}\n- Figures: ${formatPaths(inspection.figures)}\n- Tables: ${formatPaths(inspection.tables)}\n\n## What must not change silently\n\nThe imported manuscript and any claims or results extracted from it.\n\n## What may evolve\n\nPositioning, structure, prose, and unresolved metadata after evidence-based review.\n\n## Target and delivery\n\nUnresolved.\n\n## Authors and identity\n\n${authors}\n\n## Constraints\n\nUnresolved.\n\n## First deliverable\n\nAssess and reconcile the imported manuscript contracts before revision.\n\n## Template usage note\n\nAdopted from an external TeX repository by paper-run transfer.\n`);
  writeFileSync(join(workspace, "EXPERIMENTS.md"), `# Experiment Contract\n\nThis contract maps imported evidence surfaces without inventing results.\n\n## Experiment overview\n\n${inspection.evidenceFiles.length > 0 ? inspection.evidenceFiles.map((file) => `- Imported evidence surface: \`paper/${file}\``).join("\n") : "No separate experiment or result files were detected; manuscript-only evidence remains unresolved."}\n\n## Claim-evidence bindings\n\nUnresolved. Bind manuscript claims to imported evidence before revision.\n\n## Result interpretation\n\nUnresolved. Record measurement, conditions, aggregation, uncertainty, supported interpretation, and limitations before changing claims.\n\n## Relationship to the code repository\n\nNo code repository relationship was inferred. Imported evidence surfaces remain under \`paper/\`.\n\n## Figures and tables\n\n### Figures\n\n${formatPaths(inspection.figures)}\n\n### Tables\n\n${formatPaths(inspection.tables)}\n`);
  writeFileSync(join(workspace, "REFERENCES.md"), `# References\n\n## Imported bibliography\n\n${formatPaths(inspection.bibliography)}\n\n## Coverage\n\nCitation correctness and bibliography completeness remain unresolved until reviewed against the imported manuscript.\n`);
  writeFileSync(join(workspace, "PUBLICATION.md"), `# Publication Contract\n\nThis contract preserves imported build information while publication decisions remain unresolved.\n\n## Canonical paper\n\n\`paper/\` contains the imported authored source.\n\n## Active variants\n\nOnly the imported source variant is active; additional variants are unresolved.\n\n## Allowed differences\n\nLow-risk publication presentation only after Human review.\n\n## Must not diverge silently\n\nClaims, results, experiment interpretation, terminology, limitations, and canonical section content.\n\n## Human review triggers\n\nAny venue, identity, appendix, build, or publication variant decision.\n\n## Build interface\n\nImported build surfaces: ${formatPaths(inspection.buildFiles)}\n\nExisting style files: ${formatPaths(inspection.styles)}\n\n## Release instances\n\nNone. Release identity and delivery targets remain unresolved.\n`);
  replaceModeInContracts(workspace, mode);
}

function replaceModeInContracts(workspace: string, mode: Mode): void {
  for (const file of ["PAPER.md", "BRIEF.md"]) {
    const path = join(workspace, file);
    writeFileSync(path, readFileSync(path, "utf-8").replaceAll("Mode: collaborative", `Mode: ${mode}`));
  }
}

function writeExternalBuildProfile(workspace: string, inspection: ReviewSourceInspection): void {
  const command = ["make", "pdf"];
  if (!inspection.buildFiles.some((file) => /makefile/i.test(file))) {
    writeFileSync(join(workspace, "Makefile"), `pdf:\n\tlatexmk -pdf -interaction=nonstopmode ${inspection.entrypoint}\n`);
  }
  writeFileSync(join(workspace, ".agents", "paper-build.json"), `${JSON.stringify({
    schema_version: "paper-build-profile-v1",
    bibliography: inspection.bibliography.find((file) => file.toLowerCase().endsWith(".bib")) ? `paper/${inspection.bibliography.find((file) => file.toLowerCase().endsWith(".bib"))}` : null,
    builds: [{ name: "imported", command, output: "paper/main.pdf" }],
    entrypoint: `paper/${inspection.entrypoint}`,
    layout: "external-latex",
    source_root: "paper",
  }, null, 2)}\n`);
}

export function extractManuscriptMetadata(
  sourceDir: string,
  inspection: ReviewSourceInspection,
): { title?: string; authors: string[]; abstract?: string; readme?: string } {
  const content = inspection.sourceGraph
    .map((file) => stripTexComments(readFileSync(join(sourceDir, file), "utf-8")))
    .join("\n");
  const title = extractTexArgument(content, "title");
  const author = extractTexArgument(content, "author");
  const abstract = /\\begin\{abstract\}([\s\S]*?)\\end\{abstract\}/m.exec(content)?.[1]?.replace(/\s+/g, " ").trim();
  const readmePath = ["README.md", "readme.md", "README.txt"].find((file) => existsSync(join(sourceDir, file)));
  const readme = readmePath ? readFileSync(join(sourceDir, readmePath), "utf-8").slice(0, 4_000).trim() : undefined;
  return {
    ...(title ? { title: title.replace(/\s+/g, " ").trim() } : {}),
    authors: author ? author.split(/\\and|,|;/).map((item) => item.replace(/\\[a-zA-Z]+\*?(?:\[[^\]]*\])?\{([^}]*)\}/g, "$1").trim()).filter(Boolean) : [],
    ...(abstract ? { abstract } : {}),
    ...(readme ? { readme } : {}),
  };
}

async function initializeImportedRepository(
  workspace: string,
  version: string,
  mode: Mode,
  model: string | undefined,
  profile: "review-report" | "existing-manuscript",
): Promise<void> {
  await execa("git", ["init"], { cwd: workspace });
  await execa("git", ["add", "-A"], { cwd: workspace });
  await execa("git", ["add", "-f", "paper"], { cwd: workspace });
  await execa("git", ["commit", "-m", "Initialize isolated manuscript review workspace"], { cwd: workspace });
  await initializeHarnessTrust(workspace, version);
  const runId = generateRunId();
  const branch = `${GIT.runBranchPrefix}${runId}`;
  const now = new Date().toISOString();
  const plan = createRunPlan(profile);
  const state: RunState = { schema_version: "paper-run-v1", run_id: runId, run_branch: branch, mode, current_stage: "bootstrap", stage_status: "completed", started_at: now, updated_at: now, template_version: version, plan };
  writeRunState(workspace, state);
  writeGatePolicy(workspace, generateGatePreset(mode));
  writeStageHistory(workspace, { schema_version: "paper-run-stage-history-v1", stages: [{ stage_id: "bootstrap", status: "completed", started_at: now, completed_at: now, commit_sha: "prepared" }, ...plan.skipped.map((item) => ({ stage_id: item.stage, status: "skipped" as const, started_at: now, completed_at: now, commit_sha: "planned", skip_reason: item.reason }))] });
  await installAdapter(workspace, model !== undefined ? { model } : {});
  await createRunBranch(runId, workspace);
  await commitCheckpoint({ stageId: "bootstrap", status: "completed", runId, mode, templateVersion: version }, workspace);
}

function extractTexArgument(content: string, command: string): string | undefined {
  const match = new RegExp(`\\\\${command}(?:\\[[^\\]]*\\])?\\s*\\{`, "m").exec(content);
  if (!match) return undefined;
  let depth = 1;
  for (let index = match.index + match[0].length; index < content.length; index += 1) {
    if (content[index] === "{" && content[index - 1] !== "\\") depth += 1;
    if (content[index] === "}" && content[index - 1] !== "\\") {
      depth -= 1;
      if (depth === 0) return content.slice(match.index + match[0].length, index).trim();
    }
  }
  return undefined;
}

function formatPaths(paths: string[]): string {
  return paths.length > 0 ? paths.map((file) => `\`paper/${file}\``).join(", ") : "None detected; unresolved.";
}

function parseMode(value: string): Mode {
  if ((MODES as readonly string[]).includes(value)) return value as Mode;
  throw new PaperRunError(`Invalid mode "${value}".`, { hint: `Must be one of: ${MODES.join(", ")}` });
}

function reportPrepared(result: ReviewWorkspaceResult): void {
  log.blank();
  log.success("Isolated review workspace prepared.");
  printKeyValues([["Workspace", result.workspace], ["Entrypoint", `paper/${result.entrypoint}`], ["Imported files", String(result.files.length)], ["Plan", "review-report (no revision)"]]);
}

function toPosix(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}

function dirnamePosix(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? "." : path.slice(0, index);
}

function basenamePosix(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? path : path.slice(index + 1);
}
