/**
 * `paper-run start` — launch OpenCode TUI and start the pipeline controller.
 *
 * Full implementation: M1-12.
 */

import { log } from "../utils/index.js";

export interface StartOptions {
  mode?: string;
  stage?: string;
  port?: number;
  session?: string;
  auto?: boolean;
}

export async function startCommand(opts: StartOptions): Promise<void> {
  log.step("Starting paper-run pipeline...");
  if (opts.mode) log.info(`  Mode override: ${opts.mode}`);
  if (opts.stage) log.info(`  Starting from stage: ${opts.stage}`);
  log.blank();
  log.warn("start command not yet implemented — see issue #15");
}
