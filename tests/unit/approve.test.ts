import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { approveGate } from "../../src/commands/approve.js";
import { readRunState, writeRunState } from "../../src/state/store.js";
import type { RunState } from "../../src/state/schema.js";

let tmpDir: string;

function state(status: RunState["stage_status"]): RunState {
  return {
    schema_version: "paper-run-v1",
    run_id: "abcdef12",
    run_branch: "paper-run/abcdef12",
    mode: "collaborative",
    current_stage: "story_outline",
    stage_status: status,
    started_at: "2026-08-30T10:00:00.000Z",
    updated_at: "2026-08-30T10:00:00.000Z",
    template_version: "v0.3.0",
  };
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "paper-run-approve-"));
  mkdirSync(join(tmpDir, ".paper-run"));
});

afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

describe("approveGate", () => {
  it("atomically transitions only gate_waiting to approved", () => {
    writeRunState(tmpDir, state("gate_waiting"));

    expect(approveGate(tmpDir).stage_status).toBe("approved");
    expect(readRunState(tmpDir).current_stage).toBe("story_outline");
  });

  it("refuses every non-waiting status without changing state", () => {
    writeRunState(tmpDir, state("running"));

    expect(() => approveGate(tmpDir)).toThrow(/not "gate_waiting"/);
    expect(readRunState(tmpDir).stage_status).toBe("running");
  });
});
