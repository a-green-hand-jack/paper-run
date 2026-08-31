# Changelog

All notable changes to `paper-run` are documented here.

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
