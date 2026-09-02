---
description: Show details of the current pipeline stage
agent: paper-writer
---

Explain the pipeline stage the run is currently on.

Current run state:

!`cat .paper-run/run.json 2>/dev/null || echo "MISSING: .paper-run/run.json"`

Gate policy:

!`cat .paper-run/gate-policy.json 2>/dev/null || echo "MISSING: .paper-run/gate-policy.json"`

Harness task router:

!`head -60 AGENTS.md 2>/dev/null || echo "MISSING: AGENTS.md"`

## What to report

Take `current_stage` from `run.json`. If `$ARGUMENTS` names a stage id instead,
report on that stage rather than the current one, and say you are doing so.

Then read `AGENTS.md` in full and the owner skill's file under `.agents/skills/`
before answering — the snapshots above are a starting point, not the source of
truth. Report:

1. **Stage** — its id, its position in the pipeline sequence, and one or
   two sentences on what this stage is for.
2. **Owner skill** — the single harness skill that owns this stage's work,
   as routed by `AGENTS.md`, with its path under `.agents/skills/`. If the router
   names no skill for this stage, say so rather than picking one.
3. **Expected outputs** — the concrete artifacts the stage must produce: files
   created or modified, contract sections filled in, state files written. Take
   these from the owner skill, not from memory.
4. **Validation** — which harness checks apply (`.agents/tools/check-*.py`, or
   `make pdf` for build stages), and what "passing" means for this stage.
5. **Gate policy** — this stage's entry in `gate-policy.json`: `auto`,
   `await_human`, or `skip`. Say in plain terms what happens when the stage
   finishes: proceed straight on, or stop and wait for `/approve`.
6. **Current status** — `stage_status`, and what the immediate next action is
   (start work, keep going, run validators, wait for approval, unblock).

This command is read-only. Report the stage; do not begin its work.
