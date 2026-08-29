/**
 * Permission auto-approval, driven from the controller.
 *
 * The writing pipeline runs the same handful of harness validators dozens of
 * times per run. Prompting for each one trains the user to approve reflexively,
 * which is worse for safety than approving a narrow, known-safe set
 * automatically. Everything outside that set still asks.
 *
 * ## Why this is not a plugin
 *
 * The obvious home for this is the `permission.ask` plugin hook. That hook is
 * declared in `@opencode-ai/plugin` but **never dispatched by the runtime** —
 * verified against opencode 1.18.25, where the hook name occurs exactly once
 * (its own type declaration) while live hooks like `tool.execute.before` and
 * `shell.env` occur at several dispatch sites. A handler there type-checks and
 * silently never fires: the worst possible shape for a security control,
 * because it looks like a guard while granting nothing.
 *
 * The `permission.asked` **event** is real, and replying to it is how OpenCode's
 * own `--auto` mode works. So the controller subscribes and answers.
 *
 * ## Asymmetry
 *
 * This only ever *allows*. It never denies, so it cannot silently tighten a
 * permission the user configured — an unrecognised request simply falls through
 * to the human.
 */

import type { OpencodeClient } from "@opencode-ai/sdk/v2";

import { replyToPermission } from "../opencode/interaction.js";
import { log } from "../utils/logger.js";

/**
 * Bash commands safe to run unattended in a writing repo.
 *
 * Read-only inspection plus the harness's own validators and build.
 * Deliberately excludes anything that rewrites history, moves refs, or reaches
 * the network: `git commit`, `git push`, `git checkout`, `rm`, `curl` and
 * friends keep asking.
 */
export const AUTO_APPROVED_BASH: readonly RegExp[] = [
  /^python3\s+\.agents\/tools\/(check|paper)-[\w-]+\.py\b/,
  /^bash\s+\.agents\/tools\/verify\.sh\b/,
  /^\.\/\.agents\/tools\/verify\.sh\b/,
  /^make\s+(pdf|diff|clean|check)\b/,
  /^git\s+(status|diff|log|show|ls-files)\b/,
];

/** Shell metacharacters and line breaks that turn one command into several. */
const COMMAND_SEPARATORS = /[;&|`\n\r]|\$\(/;

/**
 * True when a bash command may run without asking.
 *
 * Only single commands are judged. A chained, substituted, or multi-line
 * command could smuggle anything past a prefix match — `git status\nrm -rf /`
 * matches the git pattern on its first line but runs two commands — so anything
 * carrying a separator falls through to the normal prompt.
 */
export function isAutoApproved(command: string): boolean {
  const normalized = command.trim();
  if (COMMAND_SEPARATORS.test(normalized)) return false;
  return AUTO_APPROVED_BASH.some((pattern) => pattern.test(normalized));
}

/**
 * The runtime's permission payload.
 *
 * NOTE: this deliberately does not use the `Permission` type exported by
 * `@opencode-ai/sdk` (v1), which is stale — it declares `type`/`pattern`/
 * `title`/`time`, while the runtime emits `permission`/`patterns`/`always`.
 * The v2 generated types agree with the runtime. Shape confirmed by inspecting
 * the emitted event in opencode 1.18.25:
 *   {id, sessionID, permission, patterns, metadata, always}
 */
export interface PermissionAskedPayload {
  id: string;
  sessionID: string;
  /** Permission key: "bash", "edit", "read", … */
  permission: string;
  patterns?: string[];
  metadata?: Record<string, unknown>;
}

/** Pull the command about to run out of a permission request. */
export function commandFromPayload(payload: PermissionAskedPayload): string {
  // `metadata.command` is the command actually about to run. `patterns` is only
  // the config glob that matched it, so it is never a safe thing to judge.
  const command = payload.metadata?.["command"];
  return typeof command === "string" ? command : "";
}

/**
 * Decide a pending permission request.
 *
 * Returns true when it was auto-approved, false when it was left for the human.
 */
export async function handlePermissionRequest(
  client: OpencodeClient,
  payload: PermissionAskedPayload,
  opts: { directory?: string } = {},
): Promise<boolean> {
  if (payload.permission !== "bash") return false;

  const command = commandFromPayload(payload);
  if (command === "" || !isAutoApproved(command)) return false;

  try {
    await replyToPermission(client, {
      requestID: payload.id,
      reply: "once",
      ...(opts.directory !== undefined ? { directory: opts.directory } : {}),
    });
    log.debug(`auto-approved: ${command}`);
    return true;
  } catch (err) {
    // The human may have answered first; that is a normal race, not a failure.
    log.debug(`auto-approval declined by server: ${String(err)}`);
    return false;
  }
}
