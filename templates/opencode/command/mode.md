---
description: Switch paper-run operating mode (autonomous | collaborative)
agent: paper-writer
---

Switch the paper-run operating mode to: **$ARGUMENTS**

## Steps

Validate that `$ARGUMENTS` is exactly `autonomous` or `collaborative`. If it is
empty or invalid, report the two valid values and stop without running anything.

Otherwise request the exact bash command `paper-run mode $ARGUMENTS`. Do not add
arguments, shell operators, environment assignments, or wrappers. Do not use the
`paper-run-state` tool. Do not edit `run.json`, `gate-policy.json`, or `PAPER.md` yourself.
The bash permission request must be shown for explicit human approval; do not
pre-approve or bypass it.

After the approved command completes, report its result. The new mode applies at
the next gate evaluation; a stage already running is unaffected. Do not start or
resume pipeline work as part of this command.
