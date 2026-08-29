/**
 * Adapter installation tests.
 *
 * These cover the contract the rest of paper-run relies on: every template
 * lands where OpenCode looks for it, placeholders are resolved, and a repeat
 * install never silently destroys a file the user has edited.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  installAdapter,
  updateAdapter,
  isAdapterInstalled,
  ensureGitignore,
  findTemplatesDir,
  substitutePlaceholders,
  DEFAULT_MODEL,
} from "../../src/adapter/install.js";
import { OPENCODE_DIR, OPENCODE_CONFIG, PAPER_RUN_DIR, STATE_FILES } from "../../src/utils/constants.js";

/** Every file the adapter must put into a writing repo, project-relative. */
const EXPECTED_FILES = [
  // Singular is what OpenCode 1.18.25 actually reads for agents and commands;
  // plural is what the docs show. Both are installed, so the adapter works
  // either way — an agent that never loads takes /status, /mode and /approve
  // down with it, silently.
  `${OPENCODE_DIR}/agent/paper-writer.md`,
  `${OPENCODE_DIR}/agent/paper-reviewer.md`,
  `${OPENCODE_DIR}/command/status.md`,
  `${OPENCODE_DIR}/command/mode.md`,
  `${OPENCODE_DIR}/command/approve.md`,
  `${OPENCODE_DIR}/command/stage.md`,
  `${OPENCODE_DIR}/agents/paper-writer.md`,
  `${OPENCODE_DIR}/agents/paper-reviewer.md`,
  `${OPENCODE_DIR}/commands/status.md`,
  `${OPENCODE_DIR}/commands/mode.md`,
  `${OPENCODE_DIR}/commands/approve.md`,
  `${OPENCODE_DIR}/commands/stage.md`,
  `${OPENCODE_DIR}/tools/paper-run-state.ts`,
  `${OPENCODE_DIR}/plugins/gate-plugin.ts`,
  OPENCODE_CONFIG,
];

const SESSION_IGNORE_LINE = `${PAPER_RUN_DIR}/${STATE_FILES.session}`;

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "paper-run-adapter-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("findTemplatesDir", () => {
  it("locates the shipped template tree", () => {
    const dir = findTemplatesDir();
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(join(dir, "agent", "paper-writer.md"))).toBe(true);
  });
});

describe("substitutePlaceholders", () => {
  it("replaces known placeholders", () => {
    expect(substitutePlaceholders("model: {{MODEL}}", { MODEL: "x/y" })).toBe("model: x/y");
  });

  it("replaces every occurrence", () => {
    expect(substitutePlaceholders("{{A}}-{{A}}", { A: "1" })).toBe("1-1");
  });

  it("leaves unknown placeholders verbatim", () => {
    expect(substitutePlaceholders("{{NOPE}}", { MODEL: "x" })).toBe("{{NOPE}}");
  });
});

describe("installAdapter", () => {
  it("creates every expected file", async () => {
    const result = await installAdapter(tmpDir);

    for (const rel of EXPECTED_FILES) {
      expect(existsSync(join(tmpDir, rel)), `missing ${rel}`).toBe(true);
      expect(result.installed).toContain(rel);
    }
    expect(result.skipped).toEqual([]);
  });

  it("puts opencode.json at the project root, not inside .opencode/", async () => {
    await installAdapter(tmpDir);

    expect(existsSync(join(tmpDir, OPENCODE_CONFIG))).toBe(true);
    expect(existsSync(join(tmpDir, OPENCODE_DIR, OPENCODE_CONFIG))).toBe(false);
  });

  it("writes valid JSON to opencode.json", async () => {
    await installAdapter(tmpDir, { model: "anthropic/claude-test" });

    const config = JSON.parse(readFileSync(join(tmpDir, OPENCODE_CONFIG), "utf-8"));
    expect(config.model).toBe("anthropic/claude-test");
  });

  it("substitutes {{MODEL}} with the requested model", async () => {
    await installAdapter(tmpDir, { model: "openai/gpt-test" });

    for (const rel of EXPECTED_FILES) {
      const content = readFileSync(join(tmpDir, rel), "utf-8");
      expect(content, `${rel} still has a MODEL placeholder`).not.toContain("{{MODEL}}");
    }
    expect(readFileSync(join(tmpDir, OPENCODE_CONFIG), "utf-8")).toContain("openai/gpt-test");
  });

  it("falls back to the default model", async () => {
    await installAdapter(tmpDir);
    expect(readFileSync(join(tmpDir, OPENCODE_CONFIG), "utf-8")).toContain(DEFAULT_MODEL);
  });

  it("leaves no unresolved placeholders in any installed file", async () => {
    await installAdapter(tmpDir);

    for (const rel of EXPECTED_FILES) {
      const content = readFileSync(join(tmpDir, rel), "utf-8");
      expect(content, `${rel} has an unresolved placeholder`).not.toMatch(/\{\{[A-Z_]+\}\}/);
    }
  });

  it("creates the target directory when it does not exist", async () => {
    const nested = join(tmpDir, "does", "not", "exist");
    await installAdapter(nested);
    expect(existsSync(join(nested, OPENCODE_DIR, "agent", "paper-writer.md"))).toBe(true);
  });
});

describe("installAdapter re-install", () => {
  it("skips existing files and leaves their content untouched", async () => {
    await installAdapter(tmpDir);

    const edited = join(tmpDir, OPENCODE_DIR, "agents", "paper-writer.md");
    writeFileSync(edited, "MY LOCAL EDIT");

    const result = await installAdapter(tmpDir);

    expect(result.installed).toEqual([]);
    expect(result.skipped).toEqual(expect.arrayContaining(EXPECTED_FILES));
    expect(readFileSync(edited, "utf-8")).toBe("MY LOCAL EDIT");
  });

  it("overwrites when force is set", async () => {
    await installAdapter(tmpDir);

    const edited = join(tmpDir, OPENCODE_DIR, "agents", "paper-writer.md");
    writeFileSync(edited, "MY LOCAL EDIT");

    const result = await installAdapter(tmpDir, { force: true });

    expect(result.skipped).toEqual([]);
    expect(result.installed).toEqual(expect.arrayContaining(EXPECTED_FILES));
    expect(readFileSync(edited, "utf-8")).not.toBe("MY LOCAL EDIT");
    expect(readFileSync(edited, "utf-8")).toContain("mode: primary");
  });

  it("re-substitutes placeholders with a new model on force", async () => {
    await installAdapter(tmpDir, { model: "first/model" });
    await installAdapter(tmpDir, { model: "second/model", force: true });

    const config = readFileSync(join(tmpDir, OPENCODE_CONFIG), "utf-8");
    expect(config).toContain("second/model");
    expect(config).not.toContain("first/model");
  });
});

describe("updateAdapter", () => {
  it("overwrites without an explicit force flag", async () => {
    await installAdapter(tmpDir);

    const edited = join(tmpDir, OPENCODE_DIR, "commands", "status.md");
    writeFileSync(edited, "STALE");

    const result = await updateAdapter(tmpDir);

    expect(result.skipped).toEqual([]);
    expect(readFileSync(edited, "utf-8")).not.toBe("STALE");
  });
});

describe("ensureGitignore", () => {
  it("creates .gitignore when absent", () => {
    expect(ensureGitignore(tmpDir)).toBe(true);
    expect(readFileSync(join(tmpDir, ".gitignore"), "utf-8")).toContain(SESSION_IGNORE_LINE);
  });

  it("appends to an existing .gitignore", () => {
    writeFileSync(join(tmpDir, ".gitignore"), "node_modules/\n");

    expect(ensureGitignore(tmpDir)).toBe(true);

    const content = readFileSync(join(tmpDir, ".gitignore"), "utf-8");
    expect(content).toContain("node_modules/");
    expect(content).toContain(SESSION_IGNORE_LINE);
  });

  it("appends a newline first when the file lacks a trailing one", () => {
    writeFileSync(join(tmpDir, ".gitignore"), "node_modules/");

    ensureGitignore(tmpDir);

    const lines = readFileSync(join(tmpDir, ".gitignore"), "utf-8").split("\n");
    expect(lines).toContain("node_modules/");
    expect(lines).toContain(SESSION_IGNORE_LINE);
  });

  it("is a no-op when the line is already present", () => {
    writeFileSync(join(tmpDir, ".gitignore"), `${SESSION_IGNORE_LINE}\n`);

    expect(ensureGitignore(tmpDir)).toBe(false);
    expect(readFileSync(join(tmpDir, ".gitignore"), "utf-8")).toBe(`${SESSION_IGNORE_LINE}\n`);
  });
});

describe("installAdapter and .gitignore", () => {
  it("adds the session.json ignore line", async () => {
    await installAdapter(tmpDir);
    expect(readFileSync(join(tmpDir, ".gitignore"), "utf-8")).toContain(SESSION_IGNORE_LINE);
  });

  it("does not duplicate the line across installs", async () => {
    await installAdapter(tmpDir);
    await installAdapter(tmpDir);
    await installAdapter(tmpDir, { force: true });

    const occurrences = readFileSync(join(tmpDir, ".gitignore"), "utf-8")
      .split("\n")
      .filter((line) => line.trim() === SESSION_IGNORE_LINE);

    expect(occurrences).toHaveLength(1);
  });

  it("preserves pre-existing ignore rules", async () => {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, ".gitignore"), "*.aux\n*.log\n");

    await installAdapter(tmpDir);

    const content = readFileSync(join(tmpDir, ".gitignore"), "utf-8");
    expect(content).toContain("*.aux");
    expect(content).toContain("*.log");
    expect(content).toContain(SESSION_IGNORE_LINE);
  });
});

describe("isAdapterInstalled", () => {
  it("is false on a fresh directory", () => {
    expect(isAdapterInstalled(tmpDir)).toBe(false);
  });

  it("is true after installation", async () => {
    await installAdapter(tmpDir);
    expect(isAdapterInstalled(tmpDir)).toBe(true);
  });

  it("is false when opencode.json is missing", async () => {
    await installAdapter(tmpDir);
    rmSync(join(tmpDir, OPENCODE_CONFIG));
    expect(isAdapterInstalled(tmpDir)).toBe(false);
  });

  it("installs agents and commands under both directory namings", async () => {
    // Regression: OpenCode 1.18.25 loads project agents from the SINGULAR
    // .opencode/agent/, while the docs show the plural form. Installing only
    // the plural one meant `opencode agent list` never saw paper-writer, and
    // /status, /mode and /approve silently did not exist — with no error
    // anywhere, because a missing agent is not a failure, just an absence.
    await installAdapter(tmpDir);

    for (const name of ["paper-writer.md", "paper-reviewer.md"]) {
      expect(existsSync(join(tmpDir, OPENCODE_DIR, "agent", name)), `agent/${name}`).toBe(true);
      expect(existsSync(join(tmpDir, OPENCODE_DIR, "agents", name)), `agents/${name}`).toBe(true);
    }
    for (const name of ["status.md", "mode.md", "approve.md", "stage.md"]) {
      expect(existsSync(join(tmpDir, OPENCODE_DIR, "command", name)), `command/${name}`).toBe(true);
      expect(existsSync(join(tmpDir, OPENCODE_DIR, "commands", name)), `commands/${name}`).toBe(true);
    }
  });

  it("keeps both copies of an agent identical", async () => {
    await installAdapter(tmpDir, { model: "test/model" });
    const singular = readFileSync(join(tmpDir, OPENCODE_DIR, "agent", "paper-writer.md"), "utf-8");
    const plural = readFileSync(join(tmpDir, OPENCODE_DIR, "agents", "paper-writer.md"), "utf-8");
    expect(singular).toBe(plural);
    expect(singular).toContain("test/model");
  });

  it("is false when the primary agent is missing", async () => {
    await installAdapter(tmpDir);
    rmSync(join(tmpDir, OPENCODE_DIR, "agent", "paper-writer.md"));
    expect(isAdapterInstalled(tmpDir)).toBe(false);
  });
});
