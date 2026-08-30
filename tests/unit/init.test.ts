/**
 * `paper-run init` tests.
 *
 * init is the only command that can destroy something, so most of these cover
 * refusal and cleanup rather than the happy path: a non-empty directory must
 * survive untouched, and a failure part-way through must not leave a
 * half-built repository behind.
 *
 * The full happy path needs network (it clones the template), so it lives in
 * the integration suite. What is exercised here is every decision made before
 * and after that fetch.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { assertTargetUsable, INITIAL_STAGE_STATUS } from "../../src/commands/init.js";
import { verifyTemplateTree } from "../../src/harness/template.js";
import { DirectoryNotEmptyError, PaperRunError } from "../../src/utils/errors.js";
import { PAPER_RUN_DIR } from "../../src/utils/constants.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "paper-run-init-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Refusing to overwrite
// ---------------------------------------------------------------------------

describe("target directory checks", () => {
  it("accepts a path that does not exist yet", () => {
    expect(() => assertTargetUsable(join(tmpDir, "new-paper"))).not.toThrow();
  });

  it("accepts an existing empty directory", () => {
    const dir = join(tmpDir, "empty");
    mkdirSync(dir);
    expect(() => assertTargetUsable(dir)).not.toThrow();
  });

  it("refuses a directory containing anything at all", () => {
    // Even a single unrelated file means this is someone's work.
    writeFileSync(join(tmpDir, "notes.txt"), "my notes");
    expect(() => assertTargetUsable(tmpDir)).toThrow(DirectoryNotEmptyError);
  });

  it("refuses a directory holding only a dotfile", () => {
    writeFileSync(join(tmpDir, ".env"), "SECRET=1");
    expect(() => assertTargetUsable(tmpDir)).toThrow(DirectoryNotEmptyError);
  });

  it("leaves the existing contents untouched when it refuses", () => {
    writeFileSync(join(tmpDir, "paper.tex"), "\\documentclass{article}");
    const before = readdirSync(tmpDir);

    expect(() => assertTargetUsable(tmpDir)).toThrow();

    expect(readdirSync(tmpDir)).toEqual(before);
    expect(existsSync(join(tmpDir, "paper.tex"))).toBe(true);
  });

  it("names the more specific problem when the target is already a paper-run project", () => {
    // The fix differs — continue it rather than choose another directory — so
    // the message should say which case this is.
    mkdirSync(join(tmpDir, PAPER_RUN_DIR), { recursive: true });
    writeFileSync(join(tmpDir, PAPER_RUN_DIR, "run.json"), "{}");

    let caught: unknown;
    try {
      assertTargetUsable(tmpDir);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(PaperRunError);
    expect((caught as PaperRunError).message).toContain("already a paper-run project");
    expect((caught as PaperRunError).hint).toContain("paper-run start");
  });

  it("refuses a path that exists but is a file", () => {
    const file = join(tmpDir, "afile");
    writeFileSync(file, "x");
    expect(() => assertTargetUsable(file)).toThrow(/not a directory/);
  });
});

// ---------------------------------------------------------------------------
// Template verification
// ---------------------------------------------------------------------------

describe("verifyTemplateTree", () => {
  function makeTemplate(dir: string): void {
    mkdirSync(join(dir, ".agents", "tools"), { recursive: true });
    mkdirSync(join(dir, ".agents", "skills"), { recursive: true });
    mkdirSync(join(dir, "paper"), { recursive: true });
    writeFileSync(join(dir, "AGENTS.md"), "# routing");
    writeFileSync(join(dir, "PAPER.md"), "# paper");
    writeFileSync(join(dir, "BRIEF.md"), "# brief");
    writeFileSync(join(dir, ".agents", "tools", "verify.sh"), "");
    writeFileSync(join(dir, ".agents", "tools", "paper-init.py"), "");
    writeFileSync(join(dir, ".agents", "tools", "paper-brief.py"), "");
  }

  it("reports nothing missing for a complete template", () => {
    makeTemplate(tmpDir);
    expect(verifyTemplateTree(tmpDir)).toEqual([]);
  });

  it("lists every missing path for an empty directory", () => {
    const missing = verifyTemplateTree(tmpDir);
    expect(missing).toContain("AGENTS.md");
    expect(missing).toContain(".agents/tools/verify.sh");
    expect(missing).toContain("paper");
  });

  it("catches a template that dropped a tool we depend on", () => {
    // The template ships fast and renamed itself once already; failing here is
    // far better than failing later inside a stage.
    makeTemplate(tmpDir);
    rmSync(join(tmpDir, ".agents", "tools", "paper-brief.py"));

    expect(verifyTemplateTree(tmpDir)).toEqual([".agents/tools/paper-brief.py"]);
  });
});

// ---------------------------------------------------------------------------
// Argument validation
// ---------------------------------------------------------------------------

describe("init argument validation", () => {
  it("initializes bootstrap as pending so first start runs it", () => {
    expect(INITIAL_STAGE_STATUS).toBe("pending");
  });

  it("rejects an unknown mode before doing any work", async () => {
    const { initCommand } = await import("../../src/commands/init.js");
    const target = join(tmpDir, "paper");

    await expect(
      initCommand(target, { brief: "anything", mode: "turbo", template: "v0.3.0" }),
    ).rejects.toThrow(/Invalid mode/);

    // Nothing was created.
    expect(existsSync(target)).toBe(false);
  });

  it("rejects a missing brief before doing any work", async () => {
    const { initCommand } = await import("../../src/commands/init.js");
    const target = join(tmpDir, "paper");

    await expect(
      initCommand(target, {
        brief: join(tmpDir, "no-such-brief.md"),
        mode: "autonomous",
        template: "v0.3.0",
      }),
    ).rejects.toThrow(/Brief not found/);

    expect(existsSync(target)).toBe(false);
  });

  it("requires --repo when creating a GitHub repository", async () => {
    const { initCommand } = await import("../../src/commands/init.js");
    writeFileSync(join(tmpDir, "brief.md"), "# Brief\n\nSome content.\n");

    await expect(
      initCommand(join(tmpDir, "paper"), {
        brief: join(tmpDir, "brief.md"),
        mode: "autonomous",
        template: "v0.3.0",
        // no repo, and not --local
      }),
    ).rejects.toThrow(/repository name is required/);
  });

  it("refuses a non-empty target before checking anything else", async () => {
    const { initCommand } = await import("../../src/commands/init.js");
    writeFileSync(join(tmpDir, "brief.md"), "# Brief\n");
    const target = join(tmpDir, "occupied");
    mkdirSync(target);
    writeFileSync(join(target, "existing.txt"), "work");

    await expect(
      initCommand(target, {
        brief: join(tmpDir, "brief.md"),
        mode: "autonomous",
        template: "v0.3.0",
        local: true,
      }),
    ).rejects.toThrow(DirectoryNotEmptyError);

    // Untouched.
    expect(existsSync(join(target, "existing.txt"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Failure cleanup
// ---------------------------------------------------------------------------

describe("cleanup on failure", () => {
  it("removes a directory it created when the fetch fails", async () => {
    // Point at a tag that does not exist so the clone fails.
    const { initCommand } = await import("../../src/commands/init.js");
    writeFileSync(join(tmpDir, "brief.md"), "# Brief\n\nContent.\n");
    const target = join(tmpDir, "paper");

    await expect(
      initCommand(target, {
        brief: join(tmpDir, "brief.md"),
        mode: "autonomous",
        template: "v0.0.0-does-not-exist",
        local: true,
      }),
    ).rejects.toThrow();

    // No half-built repository left for the user to clean up.
    expect(existsSync(target)).toBe(false);
  }, 60_000);

  it("does not delete a pre-existing empty directory on failure", async () => {
    // The user made this directory; a failed init must not remove it.
    const { initCommand } = await import("../../src/commands/init.js");
    writeFileSync(join(tmpDir, "brief.md"), "# Brief\n\nContent.\n");
    const target = join(tmpDir, "mine");
    mkdirSync(target);

    await expect(
      initCommand(target, {
        brief: join(tmpDir, "brief.md"),
        mode: "autonomous",
        template: "v0.0.0-does-not-exist",
        local: true,
      }),
    ).rejects.toThrow();

    expect(existsSync(target)).toBe(true);
  }, 60_000);
});
