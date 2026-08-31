# paper-run

An OpenCode-native paper writing harness for autonomous and collaborative end-to-end manuscript production.

## Overview

`paper-run` is a globally-installed CLI that orchestrates end-to-end paper writing by driving [OpenCode](https://opencode.ai) as the agent runtime. It works with the [agent-writing-harness](https://github.com/a-green-hand-jack/agent-writing-harness) template to provide a complete paper production pipeline.

Version `v0.1.0` has completed a clean 13/13 autonomous headless acceptance run on
PaperWrite-Bench `pwb-0002`; see [issue #21](https://github.com/a-green-hand-jack/paper-run/issues/21)
for the run configuration, checkpoints, timing, and publication artifacts.

## Installation

```bash
curl -fsSL https://raw.githubusercontent.com/a-green-hand-jack/paper-run/v0.2.0/install.sh | sh
```

The tag, release tarball, and checksum are version-pinned for reproducible CI, Docker,
and agent-container installs. The installer requires `curl`, Node.js, and npm.

**Prerequisites:**
- Node.js ≥ 20
- [OpenCode](https://opencode.ai) ≥ 1.18.25
- Python ≥ 3.10 (for harness validation scripts)
- Git ≥ 2.30
- [GitHub CLI](https://cli.github.com/) (`gh`), only when creating a GitHub repository

## Quick Start

```bash
# Initialize a local paper writing repository
paper-run init ~/papers/my-paper --brief ~/briefs/my-paper.md --mode autonomous --local

# Enter the repo and start the pipeline
cd ~/papers/my-paper
paper-run
```

To create a GitHub repository from the harness template instead, authenticate `gh` and pass
the new repository name. Repositories are private unless `--public` is also supplied:

```bash
gh auth login
paper-run init ~/papers/my-paper --brief ~/briefs/my-paper.md \
  --mode autonomous --repo owner/my-paper
```

## Usage

```bash
paper-run init [directory]    # Create a new writing repo from the harness template
paper-run [start]             # Launch OpenCode TUI and start the pipeline
paper-run start --headless --mode autonomous \
  --model openai/gpt-5.6-sol --variant high \
  --stage-timeout-multiplier 2
paper-run status              # Print current pipeline status
paper-run mode [mode]         # Show or switch operating mode
paper-run resume              # Resume from the last checkpoint
paper-run checkpoint          # Force a checkpoint commit
```

`--stage-timeout-multiplier` scales every stage's default budget for slower model
gateways. `PAPER_RUN_STAGE_TIMEOUT_MULTIPLIER` provides the same setting for container
wrappers. The selected value is recorded in run state and checkpoint trailers; resumes
reuse it and reject a conflicting override.

## Checkpoints and resume

`paper-run` creates a Git checkpoint commit after each completed or blocked pipeline stage.
Each checkpoint records the run, stage, status, mode, template version, and OpenCode session
when one is available. Use `paper-run checkpoint` to create the same kind of checkpoint
manually at the current pipeline position.

Use `paper-run resume` after an interruption. It resumes the recorded run from its latest
checkpoint and reuses the recorded OpenCode session when available. Completed stages are not
repeated; a stage interrupted before its checkpoint is retried. `paper-run start` remains the
normal way to start or continue a run.

Natural-language locked commitments keep their declaration protected without freezing unrelated
`PAPER.md` fields. Structurally mapped locked fields and `BRIEF.md` still fail closed. When a Human
intentionally changes one, the error prints an exact base commit and candidate digest. Review and
stage that candidate, then use the printed command:

```bash
paper-run checkpoint --authorize-locked-change <base-commit>:<candidate-digest>
```

The authorization must match both values and is recorded in the manual checkpoint trailers. A
normal stage approval never authorizes a locked-contract change.

Headless runs fail immediately when an unlisted permission requires human approval instead of
waiting invisibly. Run without `--headless` to review such a request, or add a narrow project rule.
The installed primary writer explicitly denies web fetch/search and edits to protected controller,
harness, and Makefile surfaces. Shell execution remains approval-gated, and headless mode fails
instead of auto-approving a request. Validation and publication builds remain controller-owned; the
writer must use supplied local materials or record an unresolved gap rather than seek broader permissions.

## Modes

Both modes share one pipeline; the difference is the **gate policy** — when the controller pauses to ask the human:

- **`autonomous`** — all gates proceed automatically; hard-stops only on unusable materials or locked-field violations.
- **`collaborative`** — key gates pause and ask for approval (material assessment, positioning, outline, drafting, review, candidate).

Switch at any time — it takes effect at the next gate:

```bash
paper-run mode autonomous
# or from within the OpenCode TUI:
# /mode collaborative
```

## Pipeline

Every run follows the same validated 13-stage sequence:

```text
bootstrap -> material assessment -> evidence inventory -> paper positioning
-> claim-evidence organization -> story and outline -> canonical drafting
-> citation, figure and table integration -> self review -> independent review
-> revision -> publication variant build -> paper candidate
```

Claim-evidence qualification belongs in `EXPERIMENTS.md ## Claim-evidence bindings`;
locked thesis and contribution sections remain fail-closed. The final candidate is a reviewable
artifact, not an assertion that a Human has approved submission or an external release.

## Architecture

```
paper-run (global)              agent-writing-harness (in repo)
├── CLI + controller            ├── Paper contracts (PAPER.md, ...)
├── Stage sequencing            ├── Writing skills (.agents/skills/)
├── Gate policy                 ├── Validators (check-*.py)
├── Git checkpoints             ├── Publication build profiles
├── Safe publication builds     └── Release machinery
└── OpenCode integration
```

## Development

```bash
git clone https://github.com/a-green-hand-jack/paper-run.git
cd paper-run
npm install
npm run build
npm run test
npm run typecheck
```

See [CHANGELOG.md](CHANGELOG.md) for release notes.

## License

MIT
