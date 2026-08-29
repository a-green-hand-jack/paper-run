---
description: Approve the current gate and let the pipeline continue
agent: paper-writer
---

Approve the gate the pipeline is waiting at, if it is waiting at one.

Current run state:

!`cat .paper-run/run.json 2>/dev/null || echo "MISSING: .paper-run/run.json"`

## Steps

**1. Read `.paper-run/run.json`** and check `stage_status`.

**2. If `stage_status` is `gate_waiting`:**

Set `stage_status` to `"approved"` and update `updated_at` to the current UTC
time in ISO-8601 format (e.g. `2026-08-28T14:03:11.000Z`). Change nothing else —
in particular, do not advance `current_stage`; the controller owns stage
transitions and will move on once it sees the approval.

You may use the `paper-run-state` tool's `gate-response` action for this, which
performs exactly this transition and refuses to do anything else. Writing the
file directly is acceptable if the tool is unavailable, but keep every other
field byte-identical.

Then confirm to the user: which stage was approved, and that the controller will
pick it up at its next poll.

**3. If `stage_status` is anything else:**

Do not write to any file. Tell the user the pipeline is not currently waiting for
approval, report the actual `current_stage` and `stage_status`, and say what that
status means:

- `pending` — the stage has not started yet.
- `running` — work is in progress; nothing to approve.
- `validating` — harness checks are running.
- `approved` — a gate was already approved and the controller has not yet
  advanced.
- `blocked` — the pipeline hit a hard stop. Report the `error` field if present.
  This needs the underlying problem fixed, not an approval.
- `completed` — the stage is done.

Never force a stage forward by editing state for a status other than
`gate_waiting`. If the user wants to override a block, that is a decision for
them to make explicitly, not something this command does on their behalf.
