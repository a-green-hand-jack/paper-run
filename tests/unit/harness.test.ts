import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

import {
  detectHarness,
  getTemplateVersion,
  validateHarnessIntegrity,
  readContract,
  extractMode,
  extractCollaborationCues,
  runCheck,
  initializeHarnessTrust,
} from "../../src/harness/harness.js";
import { HARNESS } from "../../src/utils/constants.js";

function createMockHarness(dir: string): void {
  writeFileSync(join(dir, "AGENTS.md"), "# Task routing\n");
  mkdirSync(join(dir, ".agents", "tools"), { recursive: true });
  mkdirSync(join(dir, ".agents", "skills"), { recursive: true });
  writeFileSync(join(dir, ".agents", "tools", "verify.sh"), "#!/bin/bash\nexit 0\n");
  writeFileSync(join(dir, ".agents", "tools", "paper-init.py"), "");
  writeFileSync(join(dir, ".agents", "tools", "paper-brief.py"), "");
  writeFileSync(
    join(dir, ".agents", "template-origin.json"),
    JSON.stringify({ schema_version: "paper-template-origin-v1", template_repository: "a-green-hand-jack/agent-writing-harness" }),
  );
}

describe("detectHarness", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "paper-run-harness-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns false for empty directory", () => {
    expect(detectHarness(tmpDir)).toBe(false);
  });

  it("returns true when harness files exist", () => {
    createMockHarness(tmpDir);
    expect(detectHarness(tmpDir)).toBe(true);
  });

  it("returns false when AGENTS.md is missing", () => {
    mkdirSync(join(tmpDir, ".agents", "tools"), { recursive: true });
    writeFileSync(join(tmpDir, ".agents", "tools", "verify.sh"), "");
    expect(detectHarness(tmpDir)).toBe(false);
  });
});

describe("getTemplateVersion", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "paper-run-harness-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null when file doesn't exist", () => {
    expect(getTemplateVersion(tmpDir)).toBeNull();
  });

  it("returns template_repository field", () => {
    createMockHarness(tmpDir);
    expect(getTemplateVersion(tmpDir)).toBe("a-green-hand-jack/agent-writing-harness");
  });
});

describe("validateHarnessIntegrity", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "paper-run-harness-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reports all missing paths for empty dir", () => {
    const missing = validateHarnessIntegrity(tmpDir);
    expect(missing.length).toBeGreaterThan(0);
    expect(missing).toContain(HARNESS.agentsRouter);
    expect(missing).toContain(HARNESS.verifyScript);
  });

  it("reports empty for complete harness", () => {
    createMockHarness(tmpDir);
    const missing = validateHarnessIntegrity(tmpDir);
    expect(missing).toHaveLength(0);
  });
});

describe("runCheck", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "paper-run-harness-check-"));
    mkdirSync(join(tmpDir, ".agents", "tools"), { recursive: true });
    execFileSync("git", ["init", "--quiet"], { cwd: tmpDir });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns exit-only diagnostics without repository script output", async () => {
    writeFileSync(
      join(tmpDir, ".agents", "tools", "check-secret.py"),
      "import sys\nprint('stdout-secret')\nprint('stderr-secret', file=sys.stderr)\nraise SystemExit(4)\n",
    );
    await initializeHarnessTrust(tmpDir, "v0.3.0");

    const result = await runCheck(tmpDir, "check-secret.py");

    expect(result).toMatchObject({ passed: false, exitCode: 4, stdout: "" });
    expect(result.stderr).toBe("check-secret.py exited with code 4");
  });

  it("permits an unchanged locally trusted script", async () => {
    const marker = join(tmpDir, "ran");
    writeFileSync(
      join(tmpDir, ".agents", "tools", "trusted.py"),
      `from pathlib import Path\nPath(${JSON.stringify(marker)}).write_text('yes')\n`,
    );
    await initializeHarnessTrust(tmpDir, "v0.3.0");

    const result = await runCheck(tmpDir, "trusted.py");

    expect(result.passed).toBe(true);
    expect(existsSync(marker)).toBe(true);
  });

  it("rejects a changed script without executing it", async () => {
    const script = join(tmpDir, ".agents", "tools", "trusted.py");
    const marker = join(tmpDir, "ran");
    writeFileSync(script, "raise SystemExit(0)\n");
    await initializeHarnessTrust(tmpDir, "v0.3.0");
    writeFileSync(script, `from pathlib import Path\nPath(${JSON.stringify(marker)}).write_text('bad')\n`);

    const result = await runCheck(tmpDir, "trusted.py");

    expect(result).toMatchObject({ passed: false, exitCode: 126 });
    expect(result.stderr).toContain("has changed");
    expect(existsSync(marker)).toBe(false);
  });

  it("rejects a symlinked trusted path without executing it", async () => {
    const script = join(tmpDir, ".agents", "tools", "trusted.py");
    const replacement = join(tmpDir, "replacement.py");
    const marker = join(tmpDir, "ran");
    writeFileSync(script, "raise SystemExit(0)\n");
    await initializeHarnessTrust(tmpDir, "v0.3.0");
    rmSync(script);
    writeFileSync(replacement, `from pathlib import Path\nPath(${JSON.stringify(marker)}).write_text('bad')\n`);
    symlinkSync(replacement, script);

    const result = await runCheck(tmpDir, "trusted.py");

    expect(result).toMatchObject({ passed: false, exitCode: 126 });
    expect(result.stderr).toContain("symlink");
    expect(existsSync(marker)).toBe(false);
  });

  it("rejects a crafted clone with no local manifest", async () => {
    const marker = join(tmpDir, "ran");
    writeFileSync(
      join(tmpDir, ".agents", "tools", "crafted.py"),
      `from pathlib import Path\nPath(${JSON.stringify(marker)}).write_text('bad')\n`,
    );

    const result = await runCheck(tmpDir, "crafted.py");

    expect(result).toMatchObject({ passed: false, exitCode: 126 });
    expect(result.stderr).toContain("manifest is missing or invalid");
    expect(existsSync(marker)).toBe(false);
  });
});

describe("readContract", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "paper-run-harness-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null for missing contract", () => {
    expect(readContract(tmpDir, "PAPER")).toBeNull();
  });

  it("reads contract content", () => {
    writeFileSync(join(tmpDir, "PAPER.md"), "# Paper\n\n## Operating mode\n\nMode: autonomous\n");
    const content = readContract(tmpDir, "PAPER");
    expect(content).toContain("Mode: autonomous");
  });
});

describe("extractMode", () => {
  it("extracts autonomous", () => {
    expect(extractMode("## Operating mode\n\nMode: autonomous\n")).toBe("autonomous");
  });

  it("extracts collaborative", () => {
    expect(extractMode("## Operating mode\n\nMode: collaborative\n")).toBe("collaborative");
  });

  it("extracts unresolved", () => {
    expect(extractMode("## Operating mode\n\nMode: unresolved\n")).toBe("unresolved");
  });

  it("returns unresolved when Mode: line is missing", () => {
    expect(extractMode("## Operating mode\n\nNo mode here\n")).toBe("unresolved");
  });

  it("is case-insensitive", () => {
    expect(extractMode("Mode: Autonomous")).toBe("autonomous");
  });
});

describe("extractCollaborationCues", () => {
  it("extracts cues from sections", () => {
    const md = `## Central thesis

This section is locked.

## What may evolve

This section is free to change.

## Unresolved

Status is unresolved.
`;
    const cues = extractCollaborationCues(md);
    expect(cues["Central thesis"]).toBe("locked");
    expect(cues["What may evolve"]).toBe("free");
    expect(cues["Unresolved"]).toBe("unresolved");
  });

  it("returns empty for no cues", () => {
    const md = "## Introduction\n\nJust text.\n";
    const cues = extractCollaborationCues(md);
    expect(Object.keys(cues)).toHaveLength(0);
  });
});
