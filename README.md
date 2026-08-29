# paper-run

An OpenCode-native paper writing harness for autonomous and collaborative end-to-end manuscript production.

## Overview

`paper-run` is a globally-installed CLI that orchestrates end-to-end paper writing by driving [OpenCode](https://opencode.ai) as the agent runtime. It works with the [agent-writing-harness](https://github.com/a-green-hand-jack/agent-writing-harness) template to provide a complete paper production pipeline.

## Installation

```bash
npm install -g paper-run
```

**Prerequisites:**
- Node.js ≥ 20
- [OpenCode](https://opencode.ai) ≥ 1.18.25
- Python ≥ 3.10 (for harness validation scripts)
- Git ≥ 2.30
- [GitHub CLI](https://cli.github.com/) (`gh`)

## Quick Start

```bash
# Initialize a new paper writing repository
paper-run init ~/papers/my-paper --brief ~/briefs/my-paper.md --mode autonomous

# Enter the repo and start the pipeline
cd ~/papers/my-paper
paper-run
```

## Usage

```bash
paper-run init [directory]    # Create a new writing repo from the harness template
paper-run [start]             # Launch OpenCode TUI and start the pipeline
paper-run status              # Print current pipeline status
paper-run mode [mode]         # Show or switch operating mode
paper-run resume              # Resume from the last checkpoint
paper-run checkpoint          # Force a checkpoint commit
```

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

## Architecture

```
paper-run (global)              agent-writing-harness (in repo)
├── CLI + controller            ├── Paper contracts (PAPER.md, ...)
├── Stage sequencing            ├── Writing skills (.agents/skills/)
├── Gate policy                 ├── Validators (check-*.py)
├── Git checkpoints             ├── LaTeX build (Makefile)
└── OpenCode integration        └── Release machinery
```

## Development

```bash
git clone https://github.com/a-green-hand-jack/paper-run.git
cd paper-run
npm install
npm run build
npm run test
```

## License

MIT
