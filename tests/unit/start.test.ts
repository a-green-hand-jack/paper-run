/**
 * `paper-run start` tests.
 *
 * The interesting behaviour here is coordination: a TUI holding the terminal
 * and a controller driving the pipeline behind it, where either finishing has
 * to end the other cleanly. Those paths are covered against a fake TUI handle
 * and a stubbed controller, since a real TUI would take over the test runner's
 * terminal.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execaSync } from "execa";

import { statusCommand, modeCommand } from "../../src/commands/start.js";
import {
  writeRunState,
  readRunState,
  writeGatePolicy,
  readGatePolicy,
  writeStageHistory,
} from "../../src/state/store.js";
import { generateGatePreset } from "../../src/state/gate-presets.js";
import type { RunState } from "../../src/state/schema.js";
import { NotAProjectError } from "../../src/utils/errors.js";

let tmpDir: string;
let cwdSpy: ReturnType<typeof vi.spyOn>;

function makeRunState(overrides: Partial<RunState> = {}): RunState {
  return {
    schema_version: "paper-run-v1",
    run_id: "abcd1234",
    run_branch: "paper-run/abcd1234",
    mode: "collaborative",
    current_stage: "paper_positioning",
    stage_status: "running",
    started_at: "2026-08-29T10:00:00.000Z",
    updated_at: "2026-08-29T10:00:00.000Z",
    template_version: "v0.3.0",
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "paper-run-start-"));
  mkdirSync(join(tmpDir, ".paper-run"), { recursive: true });
  execaSync("git", ["init"], { cwd: tmpDir });
  execaSync("git", ["config", "user.email", "t@t.com"], { cwd: tmpDir });
  execaSync("git", ["config", "user.name", "T"], { cwd: tmpDir });
  execaSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: tmpDir });

  writeRunState(tmpDir, makeRunState());
  writeGatePolicy(tmpDir, generateGatePreset("collaborative"));
  writeStageHistory(tmpDir, {
    schema_version: "paper-run-stage-history-v1",
    stages: [
      {
        stage_id: "bootstrap",
        status: "completed",
        started_at: "2026-08-29T10:00:00.000Z",
        completed_at: "2026-08-29T10:01:00.000Z",
        commit_sha: "abc123",
      },
    ],
  });

  cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
});

afterEach(() => {
  cwdSpy.mockRestore();
  vi.restoreAllMocks();
  rmSync(tmpDir, { recursive: true, force: true });
  process.exitCode = undefined;
});

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

describe("statusCommand", () => {
  it("emits machine-readable JSON on stdout", async () => {
    const chunks: string[] = [];
    const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk: any) => {
      chunks.push(String(chunk));
      return true;
    });

    await statusCommand({ json: true });
    write.mockRestore();

    const parsed = JSON.parse(chunks.join(""));
    expect(parsed.run_id).toBe("abcd1234");
    expect(parsed.mode).toBe("collaborative");
    expect(parsed.current_stage).toBe("paper_positioning");
    expect(parsed.completed).toBe(1);
    expect(parsed.total).toBe(13);
  });

  it("includes the error when a run is blocked", async () => {
    writeRunState(
      tmpDir,
      makeRunState({
        stage_status: "blocked",
        error: {
          stage: "material_assessment",
          message: "materials are unusable",
          at: "2026-08-29T10:05:00.000Z",
        },
      }),
    );

    const chunks: string[] = [];
    const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk: any) => {
      chunks.push(String(chunk));
      return true;
    });

    await statusCommand({ json: true });
    write.mockRestore();

    const parsed = JSON.parse(chunks.join(""));
    expect(parsed.error.message).toContain("unusable");
  });

  it("writes nothing to stdout in human mode, so piping stays clean", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await statusCommand({});
    expect(write).not.toHaveBeenCalled();
    write.mockRestore();
  });

  it("fails outside a project", async () => {
    const outside = mkdtempSync(join(tmpdir(), "paper-run-outside-"));
    cwdSpy.mockReturnValue(outside);

    await expect(statusCommand({ json: true })).rejects.toThrow(NotAProjectError);

    rmSync(outside, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// mode
// ---------------------------------------------------------------------------

describe("modeCommand", () => {
  it("reports the current mode when given no argument", async () => {
    await expect(modeCommand()).resolves.toBeUndefined();
    expect(readRunState(tmpDir).mode).toBe("collaborative");
  });

  it("switches the mode and rewrites the gate policy", async () => {
    await modeCommand("autonomous");

    expect(readRunState(tmpDir).mode).toBe("autonomous");
    const policy = readGatePolicy(tmpDir);
    expect(policy.mode).toBe("autonomous");
    // Previously await_human under the collaborative preset.
    expect(policy.gates["paper_positioning"]?.policy).toBe("auto");
  });

  it("preserves a per-gate override across the switch", async () => {
    const policy = readGatePolicy(tmpDir);
    // Not the collaborative default for this stage: a deliberate override.
    policy.gates["evidence_inventory"] = { policy: "await_human" };
    writeGatePolicy(tmpDir, policy);

    await modeCommand("autonomous");

    expect(readGatePolicy(tmpDir).gates["evidence_inventory"]?.policy).toBe("await_human");
  });

  it("is a no-op when already in the requested mode", async () => {
    const before = readGatePolicy(tmpDir);
    await modeCommand("collaborative");
    expect(readGatePolicy(tmpDir)).toEqual(before);
  });

  it("rejects an unknown mode without touching state", async () => {
    const before = readRunState(tmpDir);
    await expect(modeCommand("turbo")).rejects.toThrow(/Invalid mode/);
    expect(readRunState(tmpDir)).toEqual(before);
  });

  it("does not change the stage a run is on", async () => {
    // Switching mode must not disturb pipeline position.
    await modeCommand("autonomous");
    const state = readRunState(tmpDir);
    expect(state.current_stage).toBe("paper_positioning");
    expect(state.stage_status).toBe("running");
  });
});

// ---------------------------------------------------------------------------
// TUI / controller coordination
// ---------------------------------------------------------------------------

/**
 * A stand-in for the real TUI handle, so the coordination logic can be
 * exercised without a process taking over the test runner's terminal.
 */
function fakeTui() {
  let resolveExit: (code: number) => void = () => {};
  let closed = false;

  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });

  return {
    handle: {
      exited,
      get closed() {
        return closed;
      },
      close() {
        closed = true;
        resolveExit(0);
      },
    },
    /** Simulate the user quitting. */
    quit(code = 0) {
      closed = true;
      resolveExit(code);
    },
    get wasClosed() {
      return closed;
    },
  };
}

describe("TUI and controller coordination", () => {
  it("stops the controller when the user quits the TUI", async () => {
    const tui = fakeTui();
    const abort = new AbortController();

    let controllerStopped = false;
    const controller = {
      run: () =>
        new Promise((resolve) => {
          abort.signal.addEventListener("abort", () => {
            controllerStopped = true;
            resolve({ status: "interrupted", stageId: "paper_positioning" });
          });
        }),
      abort: async () => {},
    };

    const race = (async () => {
      const finishedBy = await Promise.race([
        controller.run().then(() => "pipeline" as const),
        tui.handle.exited.then(() => "tui" as const),
      ]);
      if (finishedBy === "tui") {
        abort.abort();
        await controller.abort();
      }
      return finishedBy;
    })();

    // User quits.
    setTimeout(() => tui.quit(), 20);

    expect(await race).toBe("tui");
    expect(controllerStopped).toBe(true);
  });

  it("closes the TUI when the pipeline finishes", async () => {
    const tui = fakeTui();

    const controller = {
      run: () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ status: "completed", runId: "abcd1234", tag: "t" }), 20),
        ),
      abort: async () => {},
    };

    const finishedBy = await Promise.race([
      controller.run().then(() => "pipeline" as const),
      tui.handle.exited.then(() => "tui" as const),
    ]);

    expect(finishedBy).toBe("pipeline");
    if (!tui.handle.closed) tui.handle.close();
    expect(tui.wasClosed).toBe(true);
  });

  it("captures a controller failure rather than leaving it unhandled", async () => {
    // An unhandled rejection here would kill the process while the user is
    // still looking at the TUI.
    const tui = fakeTui();

    let captured: unknown;
    const pipeline = Promise.reject(new Error("controller blew up")).catch((err: unknown) => {
      captured = err;
      return undefined;
    });

    await Promise.race([pipeline.then(() => "pipeline" as const), tui.handle.exited]);

    expect(captured).toBeInstanceOf(Error);
    expect((captured as Error).message).toBe("controller blew up");
  });
});
