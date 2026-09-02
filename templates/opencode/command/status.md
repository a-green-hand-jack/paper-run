---
description: Show paper-run pipeline status
agent: paper-writer
---

Report the current state of the paper-run pipeline.

Current run state:

!`cat .paper-run/run.json 2>/dev/null || echo "MISSING: .paper-run/run.json"`

Stage history:

!`cat .paper-run/stage-history.json 2>/dev/null || echo "MISSING: .paper-run/stage-history.json"`

Working tree:

!`git status --short 2>/dev/null | head -30`

The snapshots above are a convenience. If either state file is missing, empty, or
looks truncated, read it yourself with the `read` tool (or the `paper-run-state`
tool) before reporting — do not report on a file you could not actually see.

Then tell the user, concisely:

1. **Current stage** — its id, and where it falls in the pipeline
   (`bootstrap`, `material_assessment`, `evidence_inventory`, `paper_positioning`,
   `claim_evidence`, `story_outline`, `canonical_drafting`, `citation_integration`,
   `self_review`, `independent_review`, `revision`, `publication_build`,
   `paper_candidate`).
2. **Stage status** — `pending`, `running`, `validating`, `gate_waiting`,
   `approved`, `blocked`, or `completed`. Say what that status means for what
   happens next.
3. **Operating mode** — `autonomous` or `collaborative`.
4. **Progress** — completed stages out of the run's plan, counted from
   `stage-history.json` (entries with status `completed`).
5. **Last checkpoint** — the `completed_at` timestamp and short `commit_sha` of
   the most recent history entry.
6. **Blockers** — if `stage_status` is `blocked`, or `run.json` has an `error`
   field, report the stage, the message, and when it happened. If the latest
   history entry is `blocked`, report that too.
7. **Waiting on you** — if `stage_status` is `gate_waiting`, say so plainly and
   mention that `/approve` releases the gate.

Keep it to a short status block. Do not start any pipeline work from this
command — it is read-only reporting.
