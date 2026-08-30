---
description: Approve the current gate and let the pipeline continue
agent: paper-writer
---

Approve the gate the pipeline is waiting at, if it is waiting at one.

## Steps

Request the exact bash command `paper-run approve`. Do not add arguments, shell
operators, environment assignments, or wrappers. Do not use the
`paper-run-state` tool to mutate state and do not edit `.paper-run/run.json`
directly.

The command intentionally falls through OpenCode's `*` bash permission rule.
The bash request must be shown for explicit human approval; do not pre-approve
or bypass it. After the approved command completes, report its result. If the
pipeline is not currently at `gate_waiting`, the native command will refuse and
leave state unchanged.
