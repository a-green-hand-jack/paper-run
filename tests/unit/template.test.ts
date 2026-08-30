import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";

vi.mock("execa", () => ({ execa: vi.fn() }));

import { execa } from "execa";
import { fetchTemplate } from "../../src/harness/template.js";

const execaMock = execa as unknown as {
  mockImplementation: (
    implementation: (command: string | URL, args?: readonly string[]) => Promise<unknown>,
  ) => void;
  mockReset: () => void;
};

describe("GitHub template fetching", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
    roots.length = 0;
    execaMock.mockReset();
  });

  it("clones the exact tag and publishes from the resulting source without --template", async () => {
    const root = mkdtempSync(join(tmpdir(), "paper-run-template-"));
    roots.push(root);
    const target = join(root, "paper");
    const calls: Array<{ command: string; args: string[] }> = [];

    execaMock.mockImplementation(async (command, args) => {
      const argv = [...(args ?? [])].map(String);
      calls.push({ command: String(command), args: argv });
      if (command === "git" && argv[0] === "clone") {
        const staging = argv.at(-1)!;
        mkdirSync(join(staging, ".git"), { recursive: true });
        writeFileSync(join(staging, "AGENTS.md"), "trusted tag tree\n");
      }
      if (command === "git" && argv[0] === "remote") {
        return { exitCode: 0, stdout: "https://github.com/me/paper.git\n" };
      }
      if (command === "git" && argv[0] === "rev-parse") {
        return { exitCode: 0, stdout: "0123456789abcdef0123456789abcdef01234567\n" };
      }
      return { exitCode: 0, stdout: "" };
    });

    const result = await fetchTemplate({
      targetDir: target,
      version: "v9.8.7",
      source: "github",
      repoName: "me/paper",
    });

    const clone = calls.find((call) => call.command === "git" && call.args[0] === "clone");
    expect(clone?.args).toEqual([
      "clone",
      "--depth",
      "1",
      "--branch",
      "v9.8.7",
      "https://github.com/a-green-hand-jack/agent-writing-harness.git",
      `${target}.paper-run-staging`,
    ]);
    expect(calls.some((call) => call.args.includes("refs/tags/v9.8.7^{commit}"))).toBe(true);
    const create = calls.find((call) => call.command === "gh" && call.args[0] === "repo");
    expect(create?.args).toContain("--source");
    expect(create?.args).toContain(target);
    expect(create?.args).not.toContain("--template");
    expect(calls.findIndex((call) => call.command === "git" && call.args[0] === "clone"))
      .toBeLessThan(calls.findIndex((call) => call.command === "gh" && call.args[0] === "repo"));
    expect(result.version).toBe("v9.8.7");
  });
});
