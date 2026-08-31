# Changelog

All notable changes to `paper-run` are documented here.

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
