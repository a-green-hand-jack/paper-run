import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { findProjectRoot, isEmptyDir } from "../../src/utils/paths.js";
import { PAPER_RUN_DIR, STATE_FILES } from "../../src/utils/constants.js";

describe("findProjectRoot", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "paper-run-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null when no .paper-run/ exists", () => {
    expect(findProjectRoot(tmpDir)).toBeNull();
  });

  it("finds project root in the same directory", () => {
    const prDir = join(tmpDir, PAPER_RUN_DIR);
    mkdirSync(prDir);
    writeFileSync(join(prDir, STATE_FILES.run), "{}");
    expect(findProjectRoot(tmpDir)).toBe(tmpDir);
  });

  it("walks upward to find project root", () => {
    const prDir = join(tmpDir, PAPER_RUN_DIR);
    mkdirSync(prDir);
    writeFileSync(join(prDir, STATE_FILES.run), "{}");

    const nested = join(tmpDir, "a", "b", "c");
    mkdirSync(nested, { recursive: true });

    expect(findProjectRoot(nested)).toBe(tmpDir);
  });
});

describe("isEmptyDir", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "paper-run-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns true for non-existent path", () => {
    expect(isEmptyDir(join(tmpDir, "nope"))).toBe(true);
  });

  it("returns true for empty directory", () => {
    const dir = join(tmpDir, "empty");
    mkdirSync(dir);
    expect(isEmptyDir(dir)).toBe(true);
  });

  it("returns false for non-empty directory", () => {
    writeFileSync(join(tmpDir, "file.txt"), "hi");
    expect(isEmptyDir(tmpDir)).toBe(false);
  });
});
