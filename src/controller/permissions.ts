/**
 * Permission auto-approval, driven from the controller.
 *
 * No bash command is approved automatically. Repository inspection can carry
 * surprising Git configuration and shell parsing behavior, so every command
 * remains visible to the human permission boundary.
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
 * The `permission.asked` **event** is real, so the controller observes it but
 * deliberately leaves every request unanswered for the normal human prompt.
 */

import type { OpencodeClient } from "@opencode-ai/sdk/v2";

/** No bash commands are safe enough to run unattended. */
export const AUTO_APPROVED_BASH: readonly RegExp[] = [];

/**
 * True when a bash command may run without asking.
 *
 * The policy intentionally has no exceptions.
 */
export function isAutoApproved(command: string): boolean {
  void command;
  return false;
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
  void client;
  void payload;
  void opts;
  return false;
}
