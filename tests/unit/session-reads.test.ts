/**
 * Reading the transcript back to see what a turn actually opened.
 *
 * Without this, "did the agent load the writing skill it was pointed at?" is
 * unanswerable — a turn that ignored the skill looks exactly like one that
 * followed it. The transcript shape belongs to OpenCode, so the extraction is
 * defensive: an unfamiliar part is skipped, never thrown on.
 */

import { describe, it, expect } from "vitest";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";

import {
  getSessionReads,
  getSessionReadProfile,
  relativizeReads,
  guidanceReads,
} from "../../src/opencode/session.js";

function clientWith(data: unknown): OpencodeClient {
  return {
    session: {
      messages: async () => ({ data, error: undefined }),
    },
  } as unknown as OpencodeClient;
}

function toolPart(tool: string, input: Record<string, unknown>): unknown {
  return { type: "tool", tool, state: { status: "completed", input } };
}

describe("getSessionReads", () => {
  it("collects file paths from read calls, de-duplicated and sorted", async () => {
    const client = clientWith([
      {
        info: { role: "assistant" },
        parts: [
          toolPart("read", { filePath: "PAPER.md" }),
          toolPart("read", { filePath: ".agents/skills/section-writing/SKILL.md" }),
        ],
      },
      {
        info: { role: "assistant" },
        parts: [
          toolPart("read", { filePath: "PAPER.md" }),
          { type: "text", text: "thinking about the introduction" },
        ],
      },
    ]);

    expect(await getSessionReads(client, "ses_1")).toEqual([
      ".agents/skills/section-writing/SKILL.md",
      "PAPER.md",
    ]);
  });

  it("accepts the alternative input key names tools use", async () => {
    const client = clientWith([
      { parts: [toolPart("read", { file_path: "a.tex" }), toolPart("view", { path: "b.tex" })] },
    ]);
    expect(await getSessionReads(client, "ses_1")).toEqual(["a.tex", "b.tex"]);
  });

  it("ignores tools that are not reads", async () => {
    const client = clientWith([
      { parts: [toolPart("edit", { filePath: "PAPER.md" }), toolPart("bash", { command: "ls" })] },
    ]);
    expect(await getSessionReads(client, "ses_1")).toEqual([]);
  });

  it("returns nothing rather than throwing on an unfamiliar transcript", async () => {
    for (const shape of [null, undefined, "text", [{ parts: "not-an-array" }], [{}]]) {
      expect(await getSessionReads(clientWith(shape), "ses_1")).toEqual([]);
    }
  });

  it("returns nothing when the call errors", async () => {
    const client = {
      session: { messages: async () => ({ data: undefined, error: new Error("nope") }) },
    } as unknown as OpencodeClient;
    expect(await getSessionReads(client, "ses_1")).toEqual([]);
  });
});

describe("relativizeReads", () => {
  it("keeps project files and drops everything outside the project", () => {
    const paths = relativizeReads(
      ["/project/PAPER.md", "paper/sections/02_intro.tex", "/etc/passwd", "/home/someone/.ssh/id_rsa"],
      "/project",
    );
    expect(paths).toEqual(["PAPER.md", "paper/sections/02_intro.tex"]);
  });

  it("drops the project root itself and de-duplicates", () => {
    expect(relativizeReads(["/project", "/project/a.md", "a.md"], "/project")).toEqual(["a.md"]);
  });
});

describe("guidanceReads", () => {
  it("selects harness guidance and leaves the manuscript out", () => {
    const guidance = guidanceReads([
      ".agents/knowledge/scientific-writing.md",
      ".agents/skills/section-writing/SKILL.md",
      ".agents/vendor/ccfa-skills/ccf-paper-writer/references/section-modules.md",
      ".agents/tools/check-structure.py",
      "PAPER.md",
      "paper/sections/02_intro.tex",
    ]);

    expect(guidance).toEqual([
      ".agents/knowledge/scientific-writing.md",
      ".agents/skills/section-writing/SKILL.md",
      ".agents/vendor/ccfa-skills/ccf-paper-writer/references/section-modules.md",
    ]);
  });
});

describe("getSessionReadProfile", () => {
  it("counts every read call and the messages that carried them", async () => {
    // Two messages: one that read three files in a single turn, one that read
    // a single file. Four calls across two batches.
    const client = {
      session: {
        messages: async () => ({
          data: [
            {
              parts: [
                { tool: "read", state: { input: { filePath: "/p/PAPER.md" } } },
                { tool: "read", state: { input: { filePath: "/p/EXPERIMENTS.md" } } },
                { tool: "read", state: { input: { filePath: "/p/BRIEF.md" } } },
              ],
            },
            { parts: [{ tool: "read", state: { input: { filePath: "/p/PAPER.md" } } }] },
          ],
        }),
      },
    } as never;

    const profile = await getSessionReadProfile(client, "ses_1");

    expect(profile.calls).toBe(4);
    expect(profile.batches).toBe(2);
    // The deduplicated view cannot see the difference: three paths, four reads.
    expect(profile.paths).toEqual(["/p/BRIEF.md", "/p/EXPERIMENTS.md", "/p/PAPER.md"]);
  });

  it("reports nothing rather than throwing when the transcript is unreadable", async () => {
    const client = { session: { messages: async () => ({ error: "nope" }) } } as never;

    expect(await getSessionReadProfile(client, "ses_1")).toEqual({
      paths: [],
      calls: 0,
      batches: 0,
    });
  });
});
