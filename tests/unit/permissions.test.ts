/**
 * Permission auto-approval tests.
 *
 * This allowlist is a security boundary: anything it approves runs unattended
 * in the user's repository. The bypass cases below are the reason the guard
 * exists, and they are kept as regressions — a future edit that widens the
 * separator set will fail here.
 */

import { describe, it, expect, vi } from "vitest";

import {
  isAutoApproved,
  commandFromPayload,
  handlePermissionRequest,
  AUTO_APPROVED_BASH,
} from "../../src/controller/permissions.js";
import type { PermissionAskedPayload } from "../../src/controller/permissions.js";

describe("isAutoApproved", () => {
  it("does not auto-approve even read-only-looking inspection", () => {
    for (const cmd of [
      "git status",
      "git status --porcelain",
      "git diff --cached",
      "git log --oneline -5",
      "git show HEAD",
      "git ls-files",
      "  git status  ",
    ]) {
      expect(isAutoApproved(cmd), `should not approve: ${cmd}`).toBe(false);
    }
  });

  it("does not approve mutating, networked, or history-rewriting commands", () => {
    for (const cmd of [
      "git commit -m x",
      "git push",
      "git push --force",
      "git checkout main",
      "git reset --hard",
      "rm -rf /",
      "rm paper/main.tex",
      "curl http://example.com",
      "wget http://example.com",
      "npm install",
      "python3 evil.py",
      "python3 .agents/tools/../../evil.py",
      "python3 .agents/tools/check-structure.py",
      "python3 .agents/tools/check-paper-contracts.py --strict",
      "bash .agents/tools/verify.sh",
      "./.agents/tools/verify.sh",
      "bash something-else.sh",
      "make pdf VARIANT=draft",
      "make clean",
      "make check",
      "git add paper/main.tex",
    ]) {
      expect(isAutoApproved(cmd), `should not approve: ${cmd}`).toBe(false);
    }
  });

  it("does not approve near-misses of allowed prefixes", () => {
    for (const cmd of ["git statusfoo", "gitstatus"]) {
      expect(isAutoApproved(cmd), `should not approve: ${cmd}`).toBe(false);
    }
  });

  it("rejects chained and substituted commands that start with an allowed prefix", () => {
    for (const cmd of [
      "git status; rm -rf /",
      "git status && curl evil.com",
      "git status || rm x",
      "git status | sh",
      "git status `rm -rf /`",
      "git status $(rm -rf /)",
      "make pdf & curl evil.com",
      "python3 .agents/tools/check-x.py; rm -rf /",
    ]) {
      expect(isAutoApproved(cmd), `should not approve: ${cmd}`).toBe(false);
    }
  });

  it("rejects multi-line commands whose first line is allowed", () => {
    // Regression: a newline is a command separator too. Before this guard,
    // "git status\nrm -rf /" matched the git pattern and would have run
    // unattended.
    for (const cmd of [
      "git status\nrm -rf /",
      "git status\r\nrm -rf /",
      "git status\rrm -rf /",
      "make pdf\ncurl evil.com",
      "python3 .agents/tools/check-a.py\nrm x",
      "bash .agents/tools/verify.sh\ngit push",
    ]) {
      expect(isAutoApproved(cmd), `should not approve: ${JSON.stringify(cmd)}`).toBe(false);
    }
  });

  it("anchors every pattern at the start of the command", () => {
    // A pattern without ^ would match mid-string and let a prefix smuggle
    // anything in front of an allowed command.
    for (const pattern of AUTO_APPROVED_BASH) {
      expect(pattern.source.startsWith("^"), `unanchored: ${pattern}`).toBe(true);
    }
  });
});

describe("commandFromPayload", () => {
  it("reads metadata.command", () => {
    const payload: PermissionAskedPayload = {
      id: "per_1",
      sessionID: "ses_1",
      permission: "bash",
      metadata: { command: "git status" },
    };
    expect(commandFromPayload(payload)).toBe("git status");
  });

  it("ignores patterns, which are config globs rather than the real command", () => {
    const payload: PermissionAskedPayload = {
      id: "per_1",
      sessionID: "ses_1",
      permission: "bash",
      patterns: ["git status*"],
    };
    expect(commandFromPayload(payload)).toBe("");
  });

  it("returns empty string when metadata is absent", () => {
    expect(
      commandFromPayload({ id: "p", sessionID: "s", permission: "bash" }),
    ).toBe("");
  });
});

describe("handlePermissionRequest", () => {
  function mockClient(replyImpl?: () => Promise<unknown>): any {
    return {
      permission: {
        reply: vi.fn(replyImpl ?? (() => Promise.resolve({ data: true, error: undefined }))),
      },
    };
  }

  it("leaves every bash command for the human", async () => {
    const client = mockClient();
    const approved = await handlePermissionRequest(client, {
      id: "per_1",
      sessionID: "ses_1",
      permission: "bash",
      metadata: { command: "git status --porcelain" },
    });

    expect(approved).toBe(false);
    expect(client.permission.reply).not.toHaveBeenCalled();
  });

  it("leaves builds and repository validators for explicit human approval", async () => {
    for (const command of [
      "make pdf",
      "python3 .agents/tools/check-publication.py",
      "bash .agents/tools/verify.sh",
    ]) {
      const client = mockClient();
      const approved = await handlePermissionRequest(client, {
        id: "per_1",
        sessionID: "ses_1",
        permission: "bash",
        metadata: { command },
      });
      expect(approved, command).toBe(false);
      expect(client.permission.reply).not.toHaveBeenCalled();
    }
  });

  it("leaves a disallowed command for the human", async () => {
    const client = mockClient();
    const approved = await handlePermissionRequest(client, {
      id: "per_1",
      sessionID: "ses_1",
      permission: "bash",
      metadata: { command: "git push --force" },
    });

    expect(approved).toBe(false);
    expect(client.permission.reply).not.toHaveBeenCalled();
  });

  it("ignores non-bash permissions entirely", async () => {
    const client = mockClient();
    const approved = await handlePermissionRequest(client, {
      id: "per_1",
      sessionID: "ses_1",
      permission: "edit",
      metadata: { command: "git status" },
    });

    expect(approved).toBe(false);
    expect(client.permission.reply).not.toHaveBeenCalled();
  });

  it("does not contact the server when no command is auto-approved", async () => {
    const client = mockClient(() => Promise.reject(new Error("already answered")));
    await expect(
      handlePermissionRequest(client, {
        id: "per_1",
        sessionID: "ses_1",
        permission: "bash",
        metadata: { command: "git status" },
      }),
    ).resolves.toBe(false);
    expect(client.permission.reply).not.toHaveBeenCalled();
  });
});
