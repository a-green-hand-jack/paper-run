import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  detectHarness,
  getTemplateVersion,
  validateHarnessIntegrity,
  readContract,
  extractMode,
  extractCollaborationCues,
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
