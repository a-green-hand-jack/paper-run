# Changelog

All notable changes to `paper-run` are documented here.

## Unreleased

### Writing quality

The harness carries far more writing craft than the pipeline was reaching: a
329-line section-writing knowledge file and roughly 2,600 lines of vendored
references, all of it several optional hops behind the owner skill. These
changes close the distance and make the result checkable.

- Stages can now declare **required reading**. The stage prompt names the exact
  guidance files — `scientific-writing.md`, `section-modules.md`,
  `prose-quality-guardrails.md`, `storyline-blueprint.md`,
  `citation-workflow.md`, `length-budget-policy.md`, `ccf-a-venue-map.md` — as
  part of the method rather than leaving them behind "load as a sidecar when…"
  conditionals.
- **Canonical drafting runs one turn per manuscript section**, the granularity
  `section-writing` is written for. The stage's time budget is divided across
  the sections it finds rather than multiplied, and a repository without a
  `paper/sections/` layout falls back to a single turn.
- **`ccf-humanization` and `lieflat-less-ai-tone` swapped stages.** The vendored
  writing engine calls humanization "the first manuscript-facing preflight" and
  lieflat a final whitelist pass over finished text; they had been attached the
  other way round.
- **Prose quality is now a validator.** Filler openers, promotional vocabulary,
  template enumerations, em-dash density, and uniform sentence and paragraph
  rhythm are checked on drafting, self review, and revision. Advisory by
  design: these are mechanical tells, not a judgement about the argument.
- **Positioning records the target venue** under `.agents/knowledge/venues/`,
  validated by the harness's own `check-venue-knowledge.py` — a script that
  shipped in `.agents/tools/` but no stage had ever run.

### Review findings are now data

- Independent review writes `.paper-run/review-findings.json` alongside the
  Markdown report: id, severity, location, summary, and evidence per finding.
- Revision must record a `resolution` for every blocker and major finding —
  `fixed` or `deferred`, each with a reason. Deferral is legitimate; silence is
  not. Previously the only check on a revision turn was that the contracts
  still parsed, so the hardest finding could be skipped for free.
- Runs with no structured findings file still pass, so work recorded before
  this change is not stranded mid-pipeline.

### Observability

- `.paper-run/performance.json` records `files_read` and `guidance_read` per
  attempt, recovered from the session transcript. Whether a stage actually
  loaded the skills it was pointed at was previously unanswerable from the
  run's own record; every change above can now be checked rather than assumed.

## v0.5.0 - 2026-08-31

### Added

- `paper-run review` creates an isolated, report-only workspace for reviewing external TeX manuscripts without entering revision.
- `paper-run transfer` and `paper-run adopt` import external TeX repositories into a resumable `existing-manuscript` production workspace.
- Entrypoint/source-graph detection and metadata mapping for bibliography, figures, tables, styles, build files, and evidence surfaces.

### Safety

- External imports reject symlinks, special files, sensitive credential paths, and source/control-directory escapes.
- Standalone review verifies the imported paper tree against an immutable Git checkpoint baseline.

## v0.4.0 - 2026-08-31

### Added

- Validated execution profiles and custom ordered stage plans, with fixed plans persisted in `run.json` and omitted stages recorded in stage history.
- `paper-run validate` and `paper-run publication status` diagnostics for preflight checks and resumable publication builds.
- Per-variant publication build state in `.paper-run/publication.json`; completed variants are reused after resume and failed or timed-out variants are retried.

### Reliability

- Execution plans are bound to checkpoint state, skipped history survives resume reconciliation, and selective runs only create candidate tags when the candidate stage was selected.
- Publication artifacts are reused only when their declaration, digest, structure, and freshness still match.
- Added an ESLint 9 flat configuration and restored `npm run lint`.

## v0.3.0 - 2026-08-31

### Added

- Best-effort per-stage performance telemetry in `.paper-run/performance.json`, including model calls, token and cache usage, cost, transcript message count, validator time, checkpoint time, and turn duration.
- Headless permission diagnostics now report the requested command, patterns, stage, session, and request ID, and remain visible after resume.

### Reliability

- Performance telemetry is runtime-only, ignored by writing repositories, and cannot block the pipeline when the OpenCode usage endpoint is unavailable or slow.

## v0.2.0 - 2026-08-31

### Added

- `--stage-timeout-multiplier` and `PAPER_RUN_STAGE_TIMEOUT_MULTIPLIER` for slower model gateways.
- Run-state and checkpoint provenance for the selected timeout multiplier, including deterministic resume behavior.
- A version-pinned, checksum-verified installer for CI, Docker, and agent containers.
- Python 3.11 as the validated harness-script runtime.

### Fixed

- Timeout failures now record an actionable retry reason instead of returning only exit code 2.
- Integration fixtures no longer inherit a cloned harness Git directory or require host Git identity.

## v0.1.0 - 2026-08-30

Initial public release.

### Added

- Globally installable CLI for initializing and running `agent-writing-harness` repositories.
- Autonomous and collaborative operation over one validated 13-stage paper-production pipeline.
- Native OpenCode TUI/headless integration, persistent sessions, gate policies, and bounded resume.
- Git-native stage checkpoints, provenance trailers, locked-contract authorization, and candidate tags.
- Material assessment with usable, partial, and unusable outcomes.
- Independent review, revision, controller-owned publication builds, and four publication variants.

### Safety

- Fail-closed protection for `BRIEF.md` and structurally mapped locked paper commitments.
- Session-lineage checks and bounded cleanup for primary and delegated OpenCode sessions.
- Controller-owned publication builds using fixed `latexmk` arguments without shell escape.
- Primary writer denial of web fetch/search and protected-surface edits, with shell requests approval-gated and rejected unattended.
- Claim-evidence routing to `EXPERIMENTS.md ## Claim-evidence bindings` without modifying locked thesis or contribution sections.

### Verification

- 466 unit and integration tests, TypeScript typecheck, and production build pass.
- Clean PaperWrite-Bench `pwb-0002` run completed 13/13 stages from one autonomous headless start.
- The acceptance run produced a completed candidate tag and four structurally valid 10-page PDFs.
- The candidate remains subject to Human review; no external submission or release-instance approval is implied.
