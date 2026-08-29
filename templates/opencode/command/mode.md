---
description: Switch paper-run operating mode (autonomous | collaborative)
agent: paper-writer
---

Switch the paper-run operating mode to: **$ARGUMENTS**

Current gate policy:

!`cat .paper-run/gate-policy.json 2>/dev/null || echo "MISSING: .paper-run/gate-policy.json"`

Current operating mode block in PAPER.md:

!`sed -n '/^## Operating mode/,/^## /p' PAPER.md 2>/dev/null | head -20`

## Steps

**1. Validate the requested mode.**

It must be exactly `autonomous` or `collaborative`. If `$ARGUMENTS` is empty,
report the current mode and the two valid values, then stop — do not guess. If it
is anything else, say it is not a valid mode and stop without writing anything.

**2. Update `.paper-run/gate-policy.json`.**

Set `mode` to the new value and regenerate the gate defaults, **preserving any
gate the user has customised**. A gate counts as customised when its current
policy differs from what the *old* mode's preset would have given it; carry those
forward untouched and apply the new mode's default to all the rest.

The presets are:

- **`autonomous`** — every stage is `auto`.
- **`collaborative`** — `material_assessment`, `paper_positioning`,
  `story_outline`, `canonical_drafting`, `independent_review`, and
  `paper_candidate` are `await_human`; every other stage is `auto`.

Keep `schema_version` as `paper-run-gate-policy-v1` and keep an entry for all
thirteen stages.

**3. Update `PAPER.md`.**

In the `## Operating mode` section, set the `Mode:` value to the new mode. Change
only that value — leave the rest of the section, and its collaboration cues,
exactly as they are.

**4. Report.**

Tell the user:

- the mode before and after;
- which gates changed as a result, listed by stage id;
- which gates were preserved as user customisations, if any;
- **when it takes effect**: the switch applies at the *next* gate evaluation. A
  stage already running finishes under the policy it started with, and a gate
  already sitting in `gate_waiting` still needs `/approve`.

Do not modify `run.json` — the controller owns the `mode` field there and will
pick the change up from the gate policy. Do not start or resume any pipeline work
as part of this command.
